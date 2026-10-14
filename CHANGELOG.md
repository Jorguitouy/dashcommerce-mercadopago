# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-14

### Added

- Mercado Pago Checkout Pro (Preferences API) payment provider for DashCommerce.
  - 17 supported currencies: ARS, BRL, CLP, COP, MXN, PEN, UYU, BOB, PYG, USD, EUR + more.
  - Hosted checkout with `back_urls` (success/pending/failure) and conditional `auto_return`.
  - `external_reference` bound to the order draft id for webhook correlation.
  - Preference expiration aligned with draft TTL (15 min + 5 min webhook grace) —
    `date_of_expiration` set on every preference so money can never be stranded
    on a stale checkout tab.
- Webhook notification pipeline (`webhook-mercadopago` route):
  - HMAC-SHA256 `x-signature` validation (manifest `id:…;request-id:…;ts:…;`)
    with ≤5 min timestamp drift.
  - IP rate limiting: 30 req/min, 60s windows, KV counters.
  - Replay protection: event dedup via the core's event store — duplicates
    return `{"received":true,"duplicate":true}` and are never re-processed.
  - Server-side re-validation of amount + currency on every notification.
  - Unknown payment statuses are never treated as success (fail-closed).
  - Defensive try/catch: internal errors return a generic 500 (MP retries),
    never leaking stack traces or internals in the response body.
- Refunds with distributed locking:
  - KV lock per `paymentReference` (`mp:refund:lock:…`) with stale-lock
    takeover (>30s) and ownership-checked release.
  - Concurrent double-clicks cannot double-refund.
- Admin settings routes:
  - Credential validation (token prefixes `TEST-`/`APP_USR-`, webhook secret
    min length 8).
  - Secret masking (`••••`) in responses — stored values are never echoed back.
  - `__DELETE__` flag to remove a setting without a dedicated DELETE route.
- Money module: integer-only minor-unit arithmetic. No floats ever touch a
  price. Property-based tested (random round-trips never lose a cent).
- Capability gates: `coupons: false`, `subscriptions: false`, `connect: false` —
  carts with those features get a clean 409 instead of a mis-charge.
- Plugin descriptor factory `dashcommerceWithMercadoPago()` — drop-in
  replacement for `dashcommerce()` in `astro.config.mjs`. Same plugin id,
  storage, admin pages and widgets as the core descriptor; adds
  `api.mercadopago.com` to allowed hosts.
- Test suite: 111 tests across 10 files (money, money-properties, provider,
  security, signature, webhook, webhook-defensive, refund-dedup,
  admin-settings, rate-limit-stress).

### Notes

- Requires `@dashcommerce/core@^0.3.0` and `emdash@^1.2.0` (peer dependencies).
- No modifications to `@dashcommerce/core` or `emdash` are required.
- Stripe and Mercado Pago coexist; the active provider is a settings toggle
  (`settings:paymentProvider`).

[0.1.0]: https://github.com/Jorguitouy/dashcommerce-mercadopago/releases/tag/v0.1.0
