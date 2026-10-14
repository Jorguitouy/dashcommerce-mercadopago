<div align="center">

# dashcommerce-mercadopago

**Mercado Pago (Checkout Pro) payment provider for [DashCommerce](https://github.com/emdashCommerce/dashcommerce)**

Accept payments across all of Latin America — Argentina, Brazil, Chile, Colombia,
Mexico, Peru, Uruguay and more — directly in your DashCommerce store.
One `bun add`. One line of config. Done.

[![npm](https://img.shields.io/npm/v/dashcommerce-mercadopago.svg)](https://www.npmjs.com/package/dashcommerce-mercadopago)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-111%2F111-brightgreen.svg)](#testing)

**English** · [Español](README.es.md) · [Português](README.pt.md)

</div>

---

## Why

DashCommerce ships with Stripe only. Stripe's coverage in Latin America is
limited and its Checkout does not support the region's dominant payment
methods. Meanwhile, **Mercado Pago processes millions of payments per day**
across Latin America and is the default way people pay online in the region:
local cards, cash networks (OXXO, Pago Fácil, Servipag), bank transfers,
installments, and the Mercado Pago wallet.

This package adds Mercado Pago as a first-class payment provider to any
DashCommerce store — no core modifications, no forks.

## Features

- **Checkout Pro (Preferences API)** — the hosted checkout customers already
  know and trust across LATAM.
- **17 currencies** — ARS, BRL, CLP, COP, MXN, PEN, UYU, BOB, PYG, plus USD
  and EUR for cross-border sales.
- **Bank-grade webhook security** — HMAC-SHA256 signature validation with
  timestamp drift limits, IP rate limiting (30 req/min), replay protection
  via event deduplication, and fail-closed defaults.
- **Idempotent refunds** — KV-backed distributed locks prevent double refunds
  when an admin double-clicks.
- **Money safety** — integer-only minor-unit arithmetic. No floats ever touch
  a price. Property-based tested.
- **Expiration alignment** — payment preferences expire with the order draft
  (15 min + 5 min webhook grace), so money can never be stranded on a stale
  checkout tab.
- **Fail-closed capability gates** — coupons and subscriptions are cleanly
  rejected (409) rather than silently mis-charged. Stripe remains available
  side-by-side; switching providers is a settings toggle.
- **Full admin integration** — configure credentials and webhook secret from
  the DashCommerce admin panel. Secrets are masked, never echoed back.

## Requirements

| | |
|---|---|
| DashCommerce | `@dashcommerce/core@^0.3.0` |
| EmDash CMS | `emdash@^1.2.0` |
| Runtime | Node 20+, or Bun 1.2+ |
| Mercado Pago account | [Create one free](https://www.mercadopago.com/developers/panel/app) |

## Install

```sh
bun add dashcommerce-mercadopago
# or: npm install dashcommerce-mercadopago
```

## Setup

**1. Register the plugin** in `astro.config.mjs` — replace `dashcommerce()`
with `dashcommerceWithMercadoPago()`:

```ts
import { emdash } from "emdash/astro";
import { dashcommerceWithMercadoPago } from "dashcommerce-mercadopago";

export default defineConfig({
  integrations: [
    emdash({
      database: …,
      storage:  …,
      plugins: [dashcommerceWithMercadoPago()],
    }),
  ],
});
```

**2. Create a Mercado Pago application** at
[developers.mercadopago.com](https://www.mercadopago.com/developers/panel/app)
and grab the **Access Token** (production: `APP_USR-…`, sandbox: `TEST-…`).

**3. Configure credentials** in DashCommerce admin →
**Settings → Payment Provider → Mercado Pago**:

| Field | Value |
|---|---|
| Access token | `APP_USR-…` (or `TEST-…` for sandbox) |
| Webhook secret | A random string, min 8 chars — set the same value in your MP application's webhook configuration |

**4. Point your MP application's webhook** at:

```
https://YOUR-DOMAIN/_emdash/api/plugins/dashcommerce/checkout/webhook-mercadopago
```

**5. Switch the payment provider** in DashCommerce admin →
**Settings → paymentProvider** → `mercadopago`. Stripe stays configured and
can be re-enabled at any time.

### Sandbox testing

Use MP test credentials (`TEST-…` token) and the
[test users](https://www.mercadopago.com/developers/panel/test-cards) Mercado
Pago provides. The plugin behaves identically in sandbox and production —
only the credentials differ.

## Testing

111 tests. Zero tolerance for money bugs.

```sh
bun test
```

| Suite | Covers |
|---|---|
| money | Integer minor-unit math, rounding, round-trips |
| money-properties | Property-based: random amounts never lose a cent |
| provider | Capability gates, currency allowlist, status mapping |
| security | No secret leakage, masked admin responses |
| signature | HMAC manifest construction + verification round-trip |
| webhook | Full notification pipeline, drift limits, replay protection |
| webhook-defensive | Malformed payloads, missing headers, internal errors |
| refund-dedup | Concurrent refund race, lock stealing, ownership |
| admin-settings | Credential validation, masking, delete flag |
| rate-limit-stress | 30 req/min/IP window enforcement under load |

## Architecture

```
Your DashCommerce app
└── dashcommerce-mercadopago          ← this package
    ├── src/index.ts                  descriptor factory (astro.config)
    ├── src/entry.ts                  plugin entrypoint (runtime wrapper)
    ├── src/provider.ts               PaymentProvider: sessions, refunds,
    │                                 status mapping, capability gates
    ├── src/webhook.ts                notification processing pipeline
    ├── src/routes.ts                 webhook route + admin settings routes
    ├── src/signature.ts              HMAC-SHA256 manifest + verification
    ├── src/money.ts                  integer-only currency math
    └── src/types.ts                  shared types

Dependencies: @dashcommerce/core (peer), emdash (peer)
Modifications to core/emdash required: NONE
```

The package is a **wrapper**: it re-exports the core DashCommerce plugin
descriptor with the Mercado Pago provider injected. Same plugin id, same
storage, same admin UI — Stripe and Mercado Pago coexist, and switching is a
settings toggle.

## Security

- Webhook requests are rejected unless the `x-signature` header verifies
  against your secret with ≤5 min timestamp drift.
- Rate limited per IP (30 req/min). Replays return `{"duplicate":true}` and
  are never re-processed.
- Amount and currency are re-validated server-side on every notification —
  a tampered preference cannot over/under-charge.
- Unknown payment statuses are **never** treated as success.
- Refunds take a KV lock keyed by payment reference; concurrent double-clicks
  cannot double-refund.
- Credentials are stored encrypted, masked in admin responses (`••••`), and
  never logged.

Report vulnerabilities to [the security policy](SECURITY.md).

## Documentation

- [Install & Setup guide](docs/SETUP.md)
- [Architecture deep-dive](docs/ARCHITECTURE.md)
- [Security model](docs/SECURITY.md)
- [Operations runbook](docs/OPERATIONS.md)
- [Test matrix](docs/TEST_MATRIX.md)
- [Changelog](CHANGELOG.md)

## License

MIT © Jorge Ferreira

---

<div align="center">

**Made in Uruguay 🇺🇾 for all of Latin America**

</div>
