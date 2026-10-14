# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-10-14

### Security

- **SEC-001**: Refund lock acquisition is now ATOMIC. Uses emdash's
  database-level CAS primitive (`compareAndSet(key, null, …)` =
  `INSERT … ON CONFLICT DO NOTHING`) — exactly one concurrent request
  acquires the lock; the rest are rejected before any Mercado Pago call.
  Stale-lock takeover is a compare-and-swap on the observed revision
  (two simultaneous thieves cannot both win), and release uses
  `compareAndDelete` by revision (a slow request can never delete a
  lock it no longer owns). Plain-KV fallbacks degrade to the documented
  best-effort semantics. Verified by tests/concurrency.test.ts.
- **SEC-002**: Webhook rate limiter counter is now ATOMIC — a CAS loop
  on the observed revision means a concurrent burst of N requests
  admits exactly 30 (no lost increments). IP trust model documented:
  `cf-connecting-ip` (Cloudflare) preferred; `x-forwarded-for` is a
  documented fallback with spoofing caveats behind untrusted proxies.
- **SEC-004** (integral audit): `buildManifest` now OMITS the
  `request-id:` segment entirely when the webhook carries no
  `x-request-id` header (previously it emitted an empty segment,
  deviating from Mercado Pago's documented manifest construction).
  Legitimate MP notifications without a request-id were being rejected
  with 400 — an approved payment could exist without its order.
  Sign and verify share the same builder, so the round-trip stays
  consistent. Verified by tests/signature.test.ts (MP omission rule).

### Fixed

- **BUG-001**: Package now publishes compiled `dist/` (ESM JS + .d.ts)
  instead of raw TypeScript entrypoints. The published package runs on
  Node 20+ without a TypeScript-capable runtime or bundler (verified by
  importing `dist/money.js` and `dist/entry.js` in pure Node).
  Mirrors `@dashcommerce/core`'s own packaging pattern.
- **BUG-002** (integral audit): Checkout host allowlist now includes the
  productive Mercado Pago domains for all supported markets —
  `www.mercadopago.{com.ar,com.br,com.mx,com.co,com.pe}` plus apex
  forms, and Chile's special `mercadopago.cl` (no `.com`), plus
  `sandbox.mercadopago.cl`. Previously only Uruguay's domains were
  allowlisted, so the init_point redirect was rejected for merchants in
  AR/BR/MX/CL/CO/PE — checkout was broken outside Uruguay. Verified by
  a parametric test across 7 country TLDs × www/apex forms
  (tests/security.test.ts).
- **BUG-003** (integral audit): Stale webhook rate-limit counters are now
  swept. emdash's plugin KV has no TTL, so every
  `state:mpWebhookRate:<ip>:<window>` counter lived forever — a
  spoofed-IP flood would grow the options table unboundedly (storage
  DoS). The first request of each new window now opportunistically
  deletes this IP's counters for windows ≤ W-2 via `kv.list(prefix)`
  (bounded fallback without list support). Fire-and-forget: cleanup can
  never fail an admitted request. Verified by tests/rate-limit-stress.test.ts.
- **CI-001**: CI workflow now triggers on pushes to `master` (the
  default branch) in addition to `main`.

### CI / Supply chain

- **CI-002** (integral audit): workflow declares `permissions:
  contents: read` — least privilege for the default GITHUB_TOKEN.
- **CI-003** (integral audit): actions pinned by commit SHA
  (`actions/checkout@11d5960a…` v4.4.0,
  `oven-sh/setup-bun@0c5077e5…` v2.2.0) — tags are mutable.
- **AUD-006** (integral audit): `bun audit` added to CI as an
  informational step (the dev tree is not distributed).

### Documentation

- **DOC-001** (integral audit): currency claim corrected to the real 9
  (ARS, BRL, CLP, COP, MXN, PEN, UYU + USD/EUR for cross-border) in all
  three READMEs — the previous "17 currencies / all of LatAm" claim was
  unsustainable for a financial package.
- **DOC-002…007** (integral audit): all test metrics and paths updated
  across READMEs, SKILL.md, TEST_MATRIX, OPERATIONS, ARCHITECTURE and
  SECURITY_MODEL; the CI "Test summary" step no longer echoes hardcoded
  (false) metrics.
- **AUD-008** (integral audit): emdash log-redactor residual risk
  documented in SECURITY_MODEL.md (secrets are only redacted if they
  passed through the plugin's settings.set).

### Verified

- **SEC-003**: Credential encryption at rest CONFIRMED against emdash
  1.2.0 dist — `ctx.kv.set("settings:…")` routes through
  `createSettingsAccess` → `encryptPluginSetting` (AES-GCM) for keys
  declared `type:"secret"`. Documentation now cites the exact files and
  functions as evidence.
- Test suite: 151 tests / 12 files — 6 concurrency tests (SEC-001/002),
  19 regression tests for the integral-audit P1 fixes (country
  allowlist, MP manifest omission rule), 3 stale-counter sweep tests
  (BUG-003), and 12 wrapper contract tests (refund without amount,
  parseWebhookEvent defaults, createPlugin smoke — GAP-4/5/6).
  151 pass, 0 fail, 2,870 assertions.

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
