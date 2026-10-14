# Mercado Pago — Documentación de Arquitectura

> Estado: IMPLEMENTADO y verificado (2026-10-13). Este documento describe la
> arquitectura real del plugin, con evidencia empírica de cada decisión.

## 1. Decisión de API: Preferences API (Checkout Pro)

**Elegida**: Preferences API (`POST /checkout/preferences`) — Checkout Pro clásico.

**Descartada**: Orders API (`POST /v1/orders`), pese a ser la recomendada por MP
para integraciones nuevas, por incompatibilidad estructural **verificada
empíricamente** (2026-10-13, contra `api.mercadopago.com` con credenciales TEST-
del comercio):

| Criterio | Orders API | Preferences API |
|---|---|---|
| Token TEST- | ❌ 401 `invalid_credentials` ("Test credentials are not supported") | ✅ 201 con init_point |
| `notification_url` por orden | ❌ No existe (webhook global) | ✅ Por preferencia |
| `unit_price` | string decimal | **number JSON** (verificado: rechaza strings) |
| Refund endpoint | `/refund` singular | `/refunds` plural (verificado: 404 con id inexistente) |
| Migración a prod | Reescribir adapter | Ninguna (APP_USR- funciona igual) |

El requisito de probar con credenciales sandbox del usuario (TEST-) hace la
Orders API inutilizable para este proyecto en esta fase. Cuando el comercio
migre a producción, la Preferences API sigue soportada por MP (Checkout Pro).

## 2. Arquitectura: wrapper-plugin del entrypoint del core

```
apps/dashcommerce-store/src/plugins/mercadopago/
├── entry.ts     — wrapper: importa createPlugin del core, registra el
│                   provider MP, fusiona rutas, extiende allowedHosts
├── provider.ts   — PaymentProvider adapter (Preferences API + Payments API)
├── webhook.ts    — verifyMpWebhook: pipeline completo de verificación
├── signature.ts  — HMAC x-signature + sha256Hex (body coverage)
├── routes.ts     — webhook público (raw) + admin settings
├── money.ts      — aritmética decimal exacta (minor units ⇄ decimal)
├── types.ts      — PluginRouteContext local
└── index.ts      — re-exports
```

**Mismo plugin id (`dashcommerce`)** que el core → mismo KV namespace, mismos
settings encriptados, mismo admin, `allowedHosts` extendido (no reemplazado).
Verificado: `listPaymentProviders()` → `[stripe, mercadopago]`.

## 3. Flujo de pago end-to-end

```
Cliente → checkout.astro (SSR)
  → POST /_emdash/api/plugins/dashcommerce/checkout/create-session
    → resolveProvider(kv) → settings:paymentProvider = "mercadopago"
    → initCheckout → POST api.mercadopago.com/checkout/preferences
      (Bearer token; external_reference = orderDraftId; back_urls;
       auto_return condicional; notification_url = webhook propio)
    → sandbox_init_point validado (https + allowlist MP) → redirect
  → MP hosted page → pago → redirect a successUrl
MP → POST webhook-mercadopago?data.id=<paymentId>
  → verifyMpWebhook:
    1. 405 si no POST; 400 sin data.id; 400 sin x-signature
    2. HMAC x-signature (timing-safe, manifest id/request-id/ts, ±5min)
    3. LIVE-RETRIEVE GET /v1/payments/<id> (nunca confiar en el body)
    4. Binding: external_reference === draft, currency, amount exacto
    5. Draft consumido → 200 duplicate (idempotencia capa 1)
  → signEnrichedEvent (HMAC + SHA-256 del body) → core checkout/webhook
    → core verifyWebhook (HMAC + bodyHash) → parseWebhookEvent
    → recordStripeEvent dedupe (capa 2) → handleNormalizedChargeSucceeded
    → getPaymentStatus live-retrieve (capa 3) → reconcilePaymentAmount
    → createOrderFromPaymentIntent → orden + stock + email
```

## 4. Capas de verificación financiera (defense in depth)

| Capa | Mecanismo | Verificado |
|---|---|---|
| 1 | verifyMpWebhook: firma MP + binding amount/currency/external_reference | ✅ tests webhook.test.ts |
| 2 | Firma interna reinyección: HMAC sobre manifest **+ SHA-256 del body** | ✅ round-trip test |
| 3 | Core: getPaymentStatus live-retrieve sobrescribe amount del body | ✅ lectura sandbox-entry.js |
| 4 | Core: reconcilePaymentAmount → integrityHold si mismatch | ✅ lectura sandbox-entry.js |

**Hallazgo corregido este ciclo**: la firma interna original solo cubría
`id/request-id/ts` — un body alterado pasaba la capa 2. El core lo atrapaba en
capa 3 (live-retrieve), pero se endureció la capa 2 con `bodyHash` (SHA-256 del
body en el manifest interno). Test de tampering ahora falla como debe.

## 5. Normalización de estados (fail-closed)

| MP status | Interno | Efecto |
|---|---|---|
| approved | succeeded | crea orden |
| authorized, in_process, in_mediation, pending_contingency, pending_review_manual | pending | 200 + no-op; MP re-notifica |
| rejected, cancelled | failed | charge.failed |
| **desconocido** | **failed** | **NUNCA succeeded** (test verificado) |
| monto malformado | failed | nunca adivina (test verificado) |

## 6. Idempotencia (múltiples capas)

1. **Preferencia**: `X-Idempotency-Key` = UUID v4 derivado por FNV-1a del
   orderDraftId (estable por draft; fix este ciclo: forma UUID correcta).
2. **Webhook capa 1**: draft consumido → 200 duplicate (MP deja de reintentar).
3. **Webhook capa 2**: core `recordStripeEvent` con clave
   `${paymentId}:${status}` (no el paymentId pelado — MP transiciona estados).
4. **Orden**: `findOrderByPaymentIntent` → retorna orden existente.
5. **Replay 10x y concurrencia 5x**: verificado E2E — comportamiento idéntico,
   sin races ni 500s.

## 7. Secretos y configuración

- `settings:mercadopagoSecretKey` (TEST-/APP_USR-) y
  `settings:mercadopagoWebhookSecret` — encriptados AES-GCM por emdash
  (`EMDASH_ENCRYPTION_KEY`), declarados `type:"secret"` en settingsSchema.
- Admin GET devuelve solo `{isSet, hint}` — nunca valores. POST valida
  prefijos y rechaza el sentinel enmascarado.
- Tests verifican que errores nunca exponen secretos ni firmas esperadas.

## 8. Tests (bun test tests/, 151/151 PASS)

```
tests/
├── money.test.ts           — 20: exact decimal, CLP 0-dec, BHD 3-dec, malformed,
│                             negative, NaN/Inf, safe-integer, round-trip
├── money-properties.test.ts — property-based: montos aleatorios sin pérdida
├── signature.test.ts       — HMAC manifest, tampered, expired, future, malformed,
│                             wrong secret, non-hex, no-leak, MP omission rule
├── provider.test.ts        — parse enriched, dedupe keys, fail-closed,
│                             contract, currencies, formatAmount
├── security.test.ts        — open-redirect allowlist por país, UUID idempotency,
│                             status mapping fail-closed
├── webhook.test.ts         — full pipeline mocked, binding checks,
│                             round-trip signEnrichedEvent→verifyWebhook
├── webhook-defensive.test.ts — malformed payloads, missing headers, errors
├── refund-dedup.test.ts    — refund race, lock stealing, ownership
├── concurrency.test.ts     — parallel refunds/dedup under CAS (fidelign-style KV)
├── admin-settings.test.ts  — credential validation, masking, delete flag
├── rate-limit-stress.test.ts — 30 req/min/IP windows + stale counter sweep
└── contract.test.ts        — wrapper contracts (GAP-4/5/6)
```

## 9. Pendiente / limitaciones conocidas

- **Pago sandbox E2E real**: el flujo completo (webhook con paymentId real →
  orden creada → thank-you) requiere un pago real en sandbox. El usuario tiene
  una preferencia abierta; los pagos no aparecen aún en
  `GET /v1/payments/search`. Pipeline verificado hasta live-retrieve.
- **Webhook secret real de MP**: se usa placeholder
  (a placeholder value, not a production secret).
  Antes de producción: configurar el secret real en settings.
- **Refund E2E con pago real**: endpoint verificado (404 correcto con id falso,
  path plural), falta probar con paymentId sandbox real.
