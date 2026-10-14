# Mercado Pago — Modelo de Amenazas y Seguridad

> Seguridad "grado bancario": cada control verificado con tests o evidencia
> empírica. Fecha: 2026-10-13.

## 1. Superficie de ataque y controles

### 1.1 Webhook público (`checkout/webhook-mercadopago`)

| Amenaza | Control | Evidencia |
|---|---|---|
| Webhook forjado | HMAC-SHA256 sobre manifest `id;request-id;ts` con timing-safe compare | signature.test.ts 15 casos |
| Replay de notificación | Ventana ±5 min sobre ts (segundos o ms, normalizado solo para el check) | test expired/future |
| Monto manipulado | Binding exacto minor units vs draft snapshot (capa 1) + live-retrieve core (capa 3) + reconcile (capa 4) | webhook.test.ts |
| Moneda intercambiada | Currency check ANTES de amount (fix: comparar minor units de monedas distintas es inválido) | test currency mismatch |
| Pago de otro comercio | external_reference === orderDraftId del draft propio | test missing ext_ref |
| Pago duplicado | Draft consumido → 200 duplicate; core recordStripeEvent `${paymentId}:${status}` | replay 10x + concurrencia 5x E2E |
| Estado desconocido → aprobado | Fail-closed: unknown → failed, NUNCA succeeded | test unknown status |
| SSRF vía data.id | paymentId solo se usa en `GET /v1/payments/${encodeURIComponent(id)}` contra MP_API_BASE fijo | code review + fetchCalls test |
| Secretos en logs | reason strings nunca contienen secret/expected signature | test no-leak |
| DDoS de live-retrieves | Firma se valida ANTES de cualquier llamada externa | test: 0 fetch calls con firma inválida |

### 1.2 Reinyección interna (routes.ts → core checkout/webhook)

| Amenaza | Control | Evidencia |
|---|---|---|
| Body alterado en la reinyección | HMAC interno incluye **SHA-256 del body completo** (bodyHash) | round-trip + tampering test |
| Ruta pública explotada directamente | La ruta core valida la misma firma interna con el mismo secret | code review core |

### 1.3 Checkout (create-session)

| Amenaza | Control | Evidencia |
|---|---|---|
| Total manipulado por el cliente | Total SIEMPRE del draft snapshot server-side; el body del cliente no lleva montos | e2e-full-checkout.mjs |
| Open redirect vía init_point | Allowlist https + hosts MP + sin credenciales embebidas | security.test.ts 14 casos |
| URL javascript:/data: | Rechazadas por validación de protocolo | security.test.ts |
| Prefetch/reintento duplica preferencias | X-Idempotency-Key UUID v4 estable por draft | test estabilidad + forma |

### 1.4 Admin y secretos

| Amenaza | Control | Evidencia |
|---|---|---|
| Secretos expuestos al frontend | GET settings devuelve {isSet, hint} solo; nunca valores | routes.ts + 401 verificado |
| Escalada por rutas admin | Rutas admin requieren auth emdash (401 sin sesión) | verificado E2E |
| Secretos en código/frontend | Solo settings encriptados AES-GCM (EMDASH_ENCRYPTION_KEY); grep sin pistas en src público | auditoría previa |
| Token inválido aceptado | POST valida prefijos TEST-/APP_USR- y longitud mínima del secret | routes.ts validación |

## 2. Hallazgos corregidos (este ciclo de auditoría)

### H-1: Firma interna no cubría el body (medio → corregido)

- **Descripción**: `signEnrichedEvent` firmaba solo `id/request-id/ts`; el
  amount/orderDraftId/customer del body reinyectado no estaban cubiertos.
- **Explotación**: un atacante con acceso a la red interna podría alterar el
  body reinyectado. Mitigado por capa 3 (core live-retrieve sobrescribe amount
  desde MP) — pero defense in depth exigía cerrarlo.
- **Corrección**: `bodyHash` (SHA-256 del body) incluido en el manifest interno;
  `verifyWebhook` del adapter lo verifica. Test de tampering ahora falla.
- **Regresión**: round-trip test verde; suite completa 75/75.

### H-2: Order de checks currency/amount (bajo → corregido)

- **Descripción**: amount se comparaba antes que currency; un pago en UYU por
  un draft en USD producía "Amount mismatch" (209900 ≠ 2099) en vez de
  "Currency mismatch" — diagnóstico engañoso para el operador.
- **Corrección**: currency primero; guard contra `currency_id` undefined
  (evitaba TypeError 500).
- **Regresión**: test currency mismatch ahora espera el error correcto.

### H-3: Clave de idempotencia malformada (bajo → corregido)

- **Descripción**: `orderCreateIdempotencyKey` producía `8-8-8-8-` con dash
  final y 16 chars finales muertos (`.slice(0,36)` siempre los cortaba) — no
  era forma UUID.
- **Corrección**: UUID v4 real (8-4-4-4-12, version nibble, variant bits) con 4
  hashes FNV-1a del draft id. Estable por draft.
- **Regresión**: test de forma UUID + estabilidad verde.

### H-4: Branding engañoso con MP activo (bajo → corregido)

- **Descripción**: el banner del sitio y el footer del carrito decían
  "Secure checkout powered by Stripe" hardcodeados — con Mercado Pago activo,
  el storefront mostraba una marca que NO procesa los pagos. La entrada seed
  `ann-stripe` de la colección announcements tenía el mismo texto.
- **Riesgo**: confusión del cliente, pérdida de confianza, posible problema
  legal (afirmación falsa sobre el procesador de pagos).
- **Corrección**:
  1. `AnnouncementBar.astro`: fallback provider-aware vía
     `getPluginSetting("dashcommerce","paymentProvider")` (server-side).
  2. `cart.astro`: footer provider-aware con el mismo mecanismo.
  3. Entrada seed `ann-stripe` actualizada a texto neutral
     ("Secure checkout, every payment protected") en seed.json Y en la DB
     (`ec_announcements`, actualización dirigida — sin re-seed masivo).
- **Verificación E2E**: `/cart` muestra "powered by Mercado Pago" con MP
  activo; `/` muestra el texto neutral. Sin pistas de secrets en el HTML.

### H-5: MP descarta silenciosamente back_urls http:// (medio → documentado + mitigado)

- **Descripción**: la preferencia real creada en dev tenía `back_urls` VACÍAS.
  Verificado contra la API: MP acepta el POST pero guarda strings vacíos cuando
  las back_urls no son `https://` (y `auto_return` es rechazado con 400 si se
  envía). No es un bug del provider — el provider SÍ las envía.
- **Impacto**: en dev (http://localhost) el comprador queda en la página de MP
  tras pagar (sin botón de retorno); la orden se crea igual vía webhook. En
  producción (https) las back_urls se guardan y `auto_return: approved`
  funciona — verificado creando una preferencia con URLs https.
- **Mitigación**: comentario del provider actualizado con el comportamiento
  exacto verificado; `auto_return` solo se envía cuando TODAS las back_urls
  son https. Acción pre-producción: verificar en el primer despliegue https
  que la preferencia devuelta contenga las back_urls.

### H-6: Webhook sin rate limiting (medio → corregido y verificado)

- **Descripción**: el endpoint público `checkout/webhook-mercadopago` no
  tenía límite de requests. Un atacante podía bombardear con firmas inválidas
  (CPU) o con firmas válidas robadas (live-retrieves a MP, coste).
- **Corrección**: `webhookRateLimit()` en routes.ts — ventana fija de 60s por
  IP (`cf-connecting-ip` → `x-forwarded-for` → "unknown"), límite 30/min,
  contador en KV (`state:mpWebhookRate:<ip>:<window>`), aplicado ANTES de
  cargar credenciales o validar firma.
- **Verificación empírica**: flood de 40 requests → 30×400 + 10×429.
  Webhook legítimo en ventana nueva → pasa el rate limit (llega al
  live-retrieve, 502 con ID falso como es esperado). MP respeta 429 con
  backoff — no se pierden notificaciones reales.

## 3. Controles de red (sandbox emdash)

- `allowedHosts` extendido (no reemplazado): api.mercadopago.com + hosts de
  checkout MP (sandbox y prod, todos los países relevantes).
- Todas las llamadas externas vía `ctx.http.fetch` sandboxeado — nunca fetch
  global directo.
- Redirect del checkout: MP init_point validado contra allowlist ANTES de
  entregarse al browser.

## 4. Límites conocidos y compensaciones

1. **Placeholder webhook secret**: hasta que el usuario configure el secret
   real de su app MP, la firma se valida contra el placeholder. Un atacante que
   conozca el placeholder podría forjar webhooks PERO las capas 3-4
   (live-retrieve + reconcile) lo atrapan igual. Acción pre-producción:
   configurar secret real.
2. **Ventana replay 5 min**: MP reenvía notificaciones con ts fresco, así que
   la ventana no rompe reintentos legítimos. No sustituye la idempotencia
   (capas 1-2), es defensa adicional.
3. **Sin límite de rate propio**: emdash/infra debe rate-limitar la ruta
   pública. La validación de firma es barata (sin llamadas externas si falla).

## 5. Verificación continua

- `bun test tests/mercadopago/` — 75 tests, suite de regresión del plugin.
- `bun run typecheck` — 0 errores.
- E2E: e2e-full-checkout.mjs (carrito→preferencia), sim-webhook.mjs (firma),
  replay-test.mjs (10x), concurrent-test.mjs (5x).
