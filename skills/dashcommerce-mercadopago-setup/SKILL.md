---
name: dashcommerce-mercadopago-setup
description: Installs and configures the Mercado Pago payment provider in a DashCommerce store. Use when the user wants to add Mercado Pago payments, switch from Stripe, set up MP webhooks, test with MP sandbox, or troubleshoot MP checkout/webhook/refund issues.
---

# dashcommerce-mercadopago — Setup Skill

## Overview

This skill installs the Mercado Pago (Checkout Pro) payment provider into a
DashCommerce app (EmDash CMS + Astro). The provider coexists with Stripe —
switching is a settings toggle, never a migration.

## Prerequisites (verify before starting)

1. The target app is a DashCommerce app: `package.json` contains
   `@dashcommerce/core` (≥ 0.3.0) and `emdash` (≥ 1.2.0).
2. Node ≥ 20 or Bun ≥ 1.2 available.
3. The user has (or can create) a Mercado Pago application at
   https://www.mercadopago.com/developers/panel/app
4. The store is deployed on a domain reachable by MP webhooks (publicly
   routable URL). Local dev can use MP sandbox but webhooks need a tunnel
   (or manual verification via the admin).

## Install steps

### Step 1 — Install the package

From the DashCommerce app root:

```sh
bun add dashcommerce-mercadopago
```

### Step 2 — Register the plugin

In `astro.config.mjs`, replace `dashcommerce()` with
`dashcommerceWithMercadoPago()`:

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

Preserve any existing options: `dashcommerce({ id: "…" })` becomes
`dashcommerceWithMercadoPago({ id: "…" })`.

**Never** modify `node_modules/@dashcommerce/core` or emdash. The wrapper
architecture requires zero core changes.

### Step 3 — Create the MP application (user action)

Direct the user to https://www.mercadopago.com/developers/panel/app →
"Create application". They need:

- **Access Token**: `APP_USR-…` (production) or `TEST-…` (sandbox)
- **Webhook configuration**: URL + secret (next step)

### Step 4 — Configure the webhook in MP

In the MP application's webhook settings:

- URL: `https://<STORE-DOMAIN>/_emdash/api/plugins/dashcommerce/checkout/webhook-mercadopago`
- Secret: a random string, min 8 characters

Suggest generating it with:

```sh
openssl rand -hex 24
```

### Step 5 — Configure DashCommerce admin (user action)

1. Admin → **Settings → Payment Provider → Mercado Pago**:
   - Access token (paste the `TEST-` or `APP_USR-` token)
   - Webhook secret (the SAME string as step 4 — signature validation fails
     otherwise with 400 "Invalid signature")
2. Admin → **Settings → paymentProvider** → `mercadopago`

### Step 6 — Verify

```sh
bun run dev
```

1. Add an item to the cart → checkout → redirect to MP hosted checkout.
2. Pay with an MP test card (sandbox).
3. Redirect back to thank-you; order appears in admin within seconds
   (webhook), or after polling (up to 60s) if the webhook is delayed.

## Troubleshooting guide

| Symptom | Diagnosis | Fix |
|---|---|---|
| 409 "does not support: coupons" | Cart has a coupon; provider declares coupons:false | Remove coupon or use Stripe for that cart |
| 409 "does not support: subscriptions" | Subscription-only cart | Not supported by MP provider yet |
| Webhook 400 "Invalid signature" | Secret mismatch (admin vs MP app) | Set identical secret in both |
| Webhook 400 timestamp/drift error | Server clock >5 min off | Sync server clock (NTP) |
| Webhook 429 | >30 req/min from one IP | Check retry storms; MP retries 5xx — ensure handlers return fast |
| Thank-you stuck "Confirming" | Webhook not delivered yet | Island polls for 60s; then shows "processing" with draft reference. Check MP app webhook URL. |
| Payment approved, no order | Draft expired (>15 min + 5 min grace) before webhook | Preference expires with draft — customer can't pay stale carts. If it happens, refund via admin. |
| Refund button double-fires | — | Already guarded: KV lock per payment reference. If visible, report a bug. |

## Security invariants (do not "fix" these)

- Webhook requests without a valid `x-signature` (HMAC-SHA256, ≤5 min drift)
  are rejected. Never bypass signature validation, not even "temporarily".
- Amount and currency are re-validated server-side on every notification.
- Unknown payment statuses are never treated as success.
- Credentials are stored encrypted and masked (`••••`) in admin responses.
- Rate limit is 30 req/min/IP. Do not raise it without a reason.
- Money math is integer-only (minor units). Never introduce floats.

## Testing

The repo's suite (151 tests) runs against the package sources:

```sh
bun test tests/
```

Sandbox E2E: use `TEST-` credentials and MP test cards. Correlate payments by
`external_reference` (draft id) — MP's sandbox payment *search* is unreliable
for third-party apps; the plugin already binds `external_reference` on every
preference.

## Rollback

1. Admin → paymentProvider → `stripe`
2. `astro.config.mjs`: revert to `dashcommerce()`
3. `bun remove dashcommerce-mercadopago`

No data loss: orders/drafts/settings are keyed by provider id and persist.
