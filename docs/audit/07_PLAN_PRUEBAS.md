# FASE 7 — Plan de Pruebas (Gap Analysis de Cobertura)

> **Auditoría integral** — `dashcommerce-mercadopago` @ `7dd257d`
> Fase: **SOLO LECTURA** · Foco: qué cubren los 117 tests, qué NO, y el plan para cerrar los gaps

---

## 1. Cobertura actual (verificada por mapeo de los 117 tests)

| Suite (archivo) | Tests | Qué cubre |
|---|---|---|
| money | 22 | Conversión exacta minor units ⇄ decimal, CLP 0-dec, BHD 3-dec, rechazos (negativos, malformed, NaN/Inf, >safe-integer, decimales extra) |
| money-properties | 8 | Property-based: round-trips aleatorios sin pérdida, forma por moneda, fail-closed |
| provider | 12 | parseWebhookEvent enriquecido (succeeded/failed/unhandled/unparseable), contrato PaymentProvider, monedas, formatAmount, strip placeholder H-9 |
| security | 14 | validateCheckoutUrl (allowlist, protocolos, credenciales embebidas, malformed), idempotency key (estabilidad, forma UUID), mapeo de estados fail-closed |
| signature | 15 | Header parse, manifest, firma válida (ts seg/ms), tampered, expirado, futuro, secret incorrecto, non-hex, no-leak |
| webhook | 15 | Pipeline completo mocked: 405/400/400 firma, 502 live-retrieve, binding ext_ref/amount/currency, duplicate, rejected/pending, unknown status, round-trip sign→verify |
| webhook-defensive | 3 | KV corrupto → 500 genérico sin leak; ECONNRESET → 502; orden de checks |
| refund-dedup | 8 | Lock: adquisición, concurrente rechazado, stale steal, ownership, release tras fallo MP, sin refundRequestId, sin KV, aislamiento por pago |
| admin-settings | 11 | GET isSet/hint sin valores, POST validación prefijos/longitud/keys, sentinel, __DELETE__, combinaciones |
| rate-limit-stress | 3 | 30/60s por IP, aislamiento por IP, rotación de ventana |
| concurrency | 6 | SEC-001: refunds simultáneos → 1 a MP; thieves → 1 gana; release no roba lock. SEC-002: burst 60 → exactamente 30; contador exacto |

**Total: 117 tests / 11 archivos / 2.807 aserciones — 117 pass, 0 fail (verificado en este ciclo)**

## 2. Gaps identificados (ordenados por prioridad)

### GAP-1 (ALTA prioridad de prueba) — `validateCheckoutUrl` con dominios productivos por país

No existe ningún test que alimente `init_point` de producción de AR/BR/MX/CL/CO/PE. El hallazgo BUG-002 (allowlist incompleta) habría sido atrapado por un test paramétrico por país. Los tests actuales solo usan hosts UY/sandbox/genéricos.

**Prueba requerida**: paramétrico `["com.ar","com.br","com.mx","cl","com.co","com.pe","com.uy"]` × `[www., ""]` → `validateCheckoutUrl("https://www.mercadopago.${tld}/checkout/v1/redirect?pref_id=1")` debe ser no-null.

### GAP-2 (ALTA) — Manifest de firma SIN segmento request-id (SEC-004)

Ningún test cubre la notificación de MP sin header `x-request-id`. La spec oficial dice que el segmento se OMITE; el código lo incluye vacío. Un test habría revelado el desvío.

**Prueba requerida**: firma MP con manifest `id:…;ts:…;` (sin request-id) → `verifyMercadoPagoSignature` con requestId="" debe aceptar (hoy rechaza).

### GAP-3 (MEDIA) — Limpieza de contadores de rate-limit (BUG-003)

No hay test de retención/limpieza de claves `state:mpWebhookRate:*` — porque no existe la limpieza. Tras implementarla, test de 3 ventanas → claves viejas barridas.

### GAP-4 (MEDIA) — Refund con `amount` parcial + respuesta MP sin `amount`

`executeMpRefund` parsea `refund.amount` solo cuando `input.amount === undefined` — pero el core SIEMPRE pasa amount. El fallback nunca se ejercita en tests con respuesta MP sin amount. Menor (camino muerto en producción), pero conviene un test de contrato.

### GAP-5 (BAJA) — `parseWebhookEvent` con defaults `?? 0` / `?? "UYU"`

Los defaults solo aplican si routes.ts dejara de setear amount/currency — hoy imposible. Un test de contrato que fije el comportamiento actual evitaría un refactor futuro que los active silenciosamente.

### GAP-6 (BAJA) — `entry.ts` createPlugin merge de rutas

`createPlugin` (merge de rutas core+MP, settingsSchema merge, allowedHosts) no tiene test directo — solo se ejercita E2E en la app store (fuera de este repo). Un test de humo (createPlugin({}) → routes contiene las 2 rutas MP + schema con 2 secrets) blindaría el contrato del wrapper.

### GAP-7 (INFORMATIVA) — E2E sandbox real

Ya documentado en TEST_MATRIX §7: pago sandbox real completo, refund con paymentId real, transición in_process→approved con pago real. Requieren interacción manual (reCAPTCHA) — fuera de automatización.

## 3. Plan de pruebas propuesto (para FASE 11 junto a los fixes)

| Fix | Tests de regresión a añadir |
|---|---|
| BUG-002 (allowlist países) | GAP-1: paramétrico por país (7×2 casos) |
| SEC-004 (manifest omisión) | GAP-2: firma sin request-id aceptada + regresión con request-id presente |
| BUG-003 (limpieza contadores) | GAP-3: retención acotada tras rotación de ventanas |
| CI-002/CI-003 | No aplican tests — cambios de workflow |
| DOC-001..007 | No aplican tests — cambios de docs |

**Criterio de aceptación**: suite ≥ 117 + ~12 nuevos tests, 0 fail, typecheck 0, y los tests nuevos fallan ANTES del fix correspondiente (prueba de que el test detecta el bug).

## 4. Conclusión de la FASE 7

La suite es inusualmente sólida para un paquete de este tamaño (117 tests con property-based, concurrencia real con CAS fideligno, adversarial payloads E2E verificados en vivo). Los gaps están concentrados exactamente en los dos hallazgos de FASE 3 (dominios por país y manifest de firma) — ambos detectables con tests baratos que deberían añadirse junto a los fixes.

**Estado**: FASE 7 completa → procediendo a FASE 8 (modelo de amenazas STRIDE).
