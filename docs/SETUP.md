# Setup Guide

Complete installation and configuration guide for
**dashcommerce-mercadopago**.

> Short version: [README.md](../README.md#install) — this is the long version.

## Prerequisites

| Requirement | Check |
|---|---|
| DashCommerce app (`@dashcommerce/core@^0.3.0`) | `package.json` lists it |
| EmDash CMS (`emdash@^1.2.0`) | `package.json` lists it |
| Node ≥ 20 or Bun ≥ 1.2 | `node --version` |
| A Mercado Pago account | [Register free](https://www.mercadopago.com/developers/panel/app) |

## Option A — Automated install (recommended)

From your DashCommerce app root:

```sh
bunx dashcommerce-mercadopago-setup
```

The script verifies prerequisites, installs the package, patches
`astro.config.mjs` (`dashcommerce()` → `dashcommerceWithMercadoPago()`), and
prints the remaining manual steps. It is idempotent — safe to re-run. It never
touches credentials.

## Option B — Manual install

### 1. Install the package

```sh
bun add dashcommerce-mercadopago
# or
npm install dashcommerce-mercadopago
```

### 2. Register the plugin

Edit `astro.config.mjs`. Replace `dashcommerce()` with
`dashcommerceWithMercadoPago()`:

```diff
  import { emdash } from "emdash/astro";
- import { dashcommerce } from "@dashcommerce/core";
+ import { dashcommerceWithMercadoPago } from "dashcommerce-mercadopago";

  export default defineConfig({
    integrations: [
      emdash({
        database: …,
        storage:  …,
-       plugins: [dashcommerce()],
+       plugins: [dashcommerceWithMercadoPago()],
      }),
    ],
  });
```

If you pass options to `dashcommerce()` (e.g. a custom id), pass the same
options to `dashcommerceWithMercadoPago({ id: "…" })`.

### 3. Create the Mercado Pago application

1. Go to [developers.mercadopago.com/panel/app](https://www.mercadopago.com/developers/panel/app)
2. **Create application** → choose a name (e.g. "My Store — production")
3. Copy the **Access Token** (`APP_USR-…`)
4. For sandbox testing, use the **test credentials** token (`TEST-…`) instead

### 4. Configure the webhook in your MP application

In your application's **Webhooks** settings:

| Field | Value |
|---|---|
| URL | `https://YOUR-DOMAIN/_emdash/api/plugins/dashcommerce/checkout/webhook-mercadopago` |
| Events | Payment events (`payments`) |
| Secret key | A random string (min 8 chars) — **save this** |

Generate a strong secret:

```sh
bun -e "console.log(crypto.randomUUID().replace(/-/g,'') + crypto.randomUUID().replace(/-/g,''))"
# or
openssl rand -hex 24
```

### 5. Configure DashCommerce

In your DashCommerce admin:

1. **Settings → Payment Provider → Mercado Pago**
   - Access token: your `APP_USR-…` (or `TEST-…`) token
   - Webhook secret: the same string you set in step 4
2. **Settings → paymentProvider** → select `mercadopago`

Stripe remains fully configured — switching back is one toggle.

### 6. Verify

```sh
bun run dev
```

1. Add an item to the cart, proceed to checkout
2. You should be redirected to Mercado Pago's hosted checkout (Checkout Pro)
3. With `TEST-` credentials, MP shows its sandbox payment page
4. Pay with a [test card](https://www.mercadopago.com/developers/panel/test-cards)
5. You are redirected back to the thank-you page; the order appears in the
   admin once the webhook lands (usually instant)

## Sandbox testing

Mercado Pago sandbox specifics:

- Use the `TEST-…` access token in admin settings.
- Test users and cards:
  [MP test cards panel](https://www.mercadopago.com/developers/panel/test-cards).
- The plugin behaves identically in sandbox and production — only the
  credentials differ.
- **Important**: MP's sandbox payment search API is unreliable for
  third-party queries — always correlate payments by `external_reference`
  (the order draft id), not by listing all payments.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Checkout 409 "does not support: coupons" | Cart has a coupon; MP provider declares `coupons:false` | Remove the coupon or switch provider |
| Checkout 409 "does not support: subscriptions" | Cart is subscription-only | MP provider does not do subscriptions yet |
| Webhook 400 "Invalid signature" | Secret mismatch between admin settings and MP application | Set the same secret in both places |
| Webhook 400 "Timestamp drift" | Server clock is off by >5 min | Sync the server clock (NTP) |
| Webhook 429 | Rate limit: >30 req/min from one IP | Check for retry storms; MP retries 500s |
| Order stuck "pending" on thank-you page | Webhook hasn't landed yet (polling continues up to 60s) | Wait; check admin → orders |
| Payment approved but no order | Draft expired before webhook | Preferences expire with the draft (15 min + 5 min grace) — contact support with the draft id |
| `TEST-` token rejected | Token prefix validation | Tokens must start with `TEST-` or `APP_USR-` |

## Uninstall / rollback

1. Admin → **Settings → paymentProvider** → switch back to `stripe`
2. Revert `astro.config.mjs`: `dashcommerceWithMercadoPago()` → `dashcommerce()`
3. `bun remove dashcommerce-mercadopago`

No data is lost — orders, drafts and settings are keyed by provider id and
remain in the database.
