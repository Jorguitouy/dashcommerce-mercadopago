# FASE 3 — Mercado Pago Específico (Prioritaria)

> **Auditoría integral** — `dashcommerce-mercadopago` @ `7dd257d`
> Fase: **SOLO LECTURA** · Foco: flujo de pago MP end-to-end, firma de webhooks, idempotencia, refunds, dominios por país
> Evidencia: código + doc oficial MP (developers.mercadopago) + verificación empírica previa (transcript 2026-10-13, credenciales TEST- UY reales)

---

## 1. Verificación del esquema de firma de webhooks (SEC-004 — nuevo hallazgo)

### El formato del manifest es correcto, pero la construcción tiene un desvío de la especificación

- **Archivo**: [src/signature.ts:58-74](../../src/signature.ts#L58-L74) (`buildManifest`) + [src/webhook.ts:114-115](../../src/webhook.ts#L114-L115)
- **Especificación oficial MP** (developers.mercadopago — webhook signature validation): el manifest es `id:{data.id};request-id:{x-request-id};ts:{ts};` con la regla explícita: **"If any of these fields (data.id or x-request-id) are missing from the incoming request, omit that entire segment completely rather than leaving it blank"**.
- **Evidencia del desvío**: `buildManifest` construye SIEMPRE los tres segmentos: `id:${id};request-id:${params.requestId};ts:${ts};`. En webhook.ts, `requestId = request.headers.get("x-request-id") ?? ""` — si MP envía una notificación **sin** el header `x-request-id`, el manifest local es `id:123;request-id:;ts:…;` (segmento con valor vacío) mientras que MP firmó `id:123;ts:…;` (segmento omitido) → HMAC distinto → **400 "Invalid signature" sobre una notificación auténtica**.
- **Impacto**: fail-closed excesivo — no es explotable para fraude (al revés: es demasiado estricto), pero tiene **impacto financiero operacional**: un pago aprobado cuyo webhook se rechaza → la orden no se crea (el cliente pagó; el stock lock se libera por TTL; el dinero queda sin orden asociada) → requiere reconciliación manual con el draft id. MP reintenta el webhook, pero si el header falta **consistentemente** en ese tipo de notificación (p. ej. ciertos eventos o ciertas configuraciones de la app MP), ningún reintento tiene éxito.
- **Requisitos previos**: MP omita `x-request-id` en alguna notificación real. La regla de omisión existe en la doc oficial porque el caso ocurre en producción.
- **Clasificación**: Probable (desvío de spec confirmado contra doc oficial; frecuencia real del header ausente no medible sin tráfico productivo).
- **Severidad**: **MEDIA** (integridad financiera operacional; no confidencialidad ni fraude).
- **Solución propuesta**: en `buildManifest`, omitir el segmento `request-id:` cuando `requestId === ""` (y documentar que data.id vacío ya se rechaza antes con 400 — la ruta exige data.id en query, así que el segmento `id:` siempre está presente en la práctica). El camino interno de reinyección SIEMPRE lleva requestId del original — si el original no lo tenía, el interno firma `request-id:;` y verifica igual → consistente; pero conviene aplicar la misma omisión en ambos lados (sign y verify) para mantener el round-trip.
- **Prueba de verificación**: unit test que firme un manifest SIN segmento request-id (simulando MP) y verifique que `verifyMercadoPagoSignature` con requestId="" lo acepta; test inverso de regresión (requestId presente → manifest completo).
- **Riesgo residual**: si MP además variara el orden de segmentos o agregara segmentos nuevos, el manifest fijo fallaría — mitigable con log del manifest rechazado (sin secret) para diagnóstico.

## 2. Dominios de checkout por país (BUG-002 — confirmado con evidencia oficial)

- **Evidencia oficial** (doc MP Checkout Pro): *"The TLD of the init_point will automatically match the marketplace country of the Access Token owner"*:
  - Argentina → `https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=…`
  - Brasil → `mercadopago.com.br` · México → `mercadopago.com.mx` · Colombia → `mercadopago.com.co`
  - **Chile → `mercadopago.cl`** (¡sin `.com`! — el código lista `sandbox.mercadopago.com.cl` que ni siquiera sigue el patrón real)
  - Perú → `mercadopago.com.pe` · Uruguay → `mercadopago.com.uy`
- **Contra-allowlist** ([provider.ts:90-108](../../src/provider.ts#L90-L108)): ninguno de los 6 dominios productivos no-UY está incluido. **6 de 9 mercados soportados rompen en producción** con `initCheckout → "Mercado Pago returned an invalid checkout URL"`.
- **Corroboración empírica**: transcript 2026-10-13 con token TEST- UY → `init_point = https://www.mercadopago.com.uy/checkout/v1/redirect?pref_id=2989674893-…` (patrón por país confirmado en vivo).
- **Clasificación**: Confirmado (doc oficial + patrón verificado en vivo).
- **Severidad**: **ALTA** (funcional; bloquea el mercado objetivo declarado del plugin).
- **Solución**: agregar a `MP_CHECKOUT_HOSTS`: `www.mercadopago.com.ar`, `mercadopago.com.ar`, `www.mercadopago.com.br`, `mercadopago.com.br`, `www.mercadopago.com.mx`, `mercadopago.com.mx`, `www.mercadopago.cl`, `mercadopago.cl`, `www.mercadopago.com.co`, `mercadopago.com.co`, `www.mercadopago.com.pe`, `mercadopago.com.pe` (+ equivalentes sandbox reales: `sandbox.mercadopago.cl` etc.). Tests por país.

## 3. Resto del flujo MP — verificado sin hallazgos

| Punto MP | Verificación | Estado |
|---|---|---|
| **Preferences API** (POST /checkout/preferences) | Elegida sobre Orders API por incompatibilidad TEST- verificada empíricamente (401 invalid_credentials). Cuerpo: items/external_reference/payer/back_urls/notification_url/date_of_expiration — todos con formas verificadas contra la API real | ✅ |
| **`unit_price` JSON number** | La API rechaza strings (verificado); `minorUnitsToDecimalNumber` produce número exacto desde string exacto — sin float math | ✅ |
| **`date_of_expiration`** (no `expiration_date`) | Verificado empíricamente: MP guarda el offset ISO y lo hace eco con delta <1s; alineado con draft TTL 15min + 5min grace | ✅ |
| **`auto_return` condicional** | Solo con TODAS back_urls https (MP rechaza 400 si no; además descarta http:// silenciosamente — verificado) | ✅ |
| **`notification_url` por preferencia** | Ventaja documentada de Preferences vs Orders (webhook global); derivado del origin del successUrl | ✅ |
| **Live-retrieve** GET /v1/payments/{id} | Nunca se confía en el body del webhook; `encodeURIComponent` en el id; respuesta validada (`asMpPayment`) | ✅ |
| **Mapeo de estados** | approved→succeeded; authorized/in_process/in_mediation/pending_contingency/pending_review_manual→pending; rejected/cancelled→failed; **desconocido→failed (fail-closed)** — 6 tests | ✅ |
| **Refunds** POST /v1/payments/{id}/**refunds** (plural) | Verificado (404 con singular); body vacío=total, `{amount}` decimal string=parcial; lock CAS per payment; X-Idempotency-Key enviado (MP lo ignora — documentado; sin impacto: dedupe por paymentId:status en el webhook) | ✅ |
| **Replay/idempotencia** | 4 capas: draft consumido→200 duplicate; recordStripeEvent `${paymentId}:${status}` (clave correcta para transiciones de estado MP); findOrderByPaymentIntent; replay 10x verificado E2E | ✅ |
| **Binding financiero** | external_reference===draft + currency ANTES que amount + amount exacto en minor units — 6 tests + E2E con pago real rechazado (fail-closed correcto) | ✅ |
| **Ventana replay ±5min** | ts segundos o ms normalizado solo para el check; manifest usa el ts RAW (correcto según spec) | ✅ |
| **Timing-safe compare** | XOR accumulate constante; length check primero (no filtra info útil del secret) | ✅ |
| **Webhook secret ≥8 chars** | Validación de entrada razonable (el usuario puede y debe poner más; SETUP.md sugiere `openssl rand -hex 24`) | ✅ |

## 4. Hallazgos de FASE 3

| ID | Severidad | Título | Clasificación |
|---|---|---|---|
| **SEC-004** | MEDIA | Manifest de firma: segmentos vacíos en vez de omitidos cuando falta `x-request-id` → webhooks legítimos de MP rechazados → pago sin orden | Probable (desvío de spec oficial confirmado) |
| **BUG-002** | ALTA | Allowlist de dominios productivos incompleta (AR/BR/MX/CL/CO/PE) — Chile ni siquiera sigue el patrón asumido (`mercadopago.cl`, no `.com.cl`) | Confirmado (doc oficial + verificación en vivo UY) |

## 5. Conclusión de la FASE 3

El flujo MP está implementado con rigor inusual (verificación empírica de cada forma de campo contra la API real, 4 capas de defensa, fail-closed en todos los defaults). Los dos hallazgos son de **conformidad con la especificación/dominio real de MP**, no de diseño: (1) la regla de omisión de segmentos del manifest que el código no implementa, y (2) la allowlist de dominios que solo contempla Uruguay en producción. Ambos tienen solución mecánica y tests de regresión claros.

**Estado**: FASE 3 completa → procediendo a FASE 4 (dependencias y cadena de suministro).
