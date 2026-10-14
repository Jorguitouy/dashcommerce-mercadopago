# Cloudflare Deployment Guide

**Hardening the Mercado Pago provider at the edge.**

DashCommerce stores typically run on Cloudflare (Workers/Pages). This guide
adds a WAF layer around the payment endpoints — defense in depth on top of
the origin-side protections the provider already ships.

## Threat model

| Layer | Protection | Where |
|---|---|---|
| Edge (this guide) | Volumetric DDoS, bot abuse, OWASP patterns, admin-path challenges | Cloudflare WAF |
| Origin (built-in) | HMAC-SHA256 signature validation, 30 req/min/IP app rate limit, replay dedup, amount re-validation, fail-closed defaults | `dashcommerce-mercadopago` |

The edge layer is a **backstop**, never the primary defense. Webhook
authenticity is proven by the HMAC signature at origin — an attacker who
passes the WAF still cannot forge a notification.

## Recommended ruleset

### 1. Webhook path — generous volumetric backstop

The MP notification endpoint receives machine traffic only. Never use
interactive challenges here: Mercado Pago's notifier cannot solve them and
will retry in a loop, silently breaking order fulfillment.

**Rate limiting rule** (Security → WAF → Rate limiting rules):

```
Expression:
  (http.request.uri.path eq "/_emdash/api/plugins/dashcommerce/checkout/webhook-mercadopago")

Requests: 300
Period:   1 minute
Action:   Block  (returns 429)
```

300/min is deliberately ~10× the app's own limit (30 req/min/IP with per-event
dedup). The edge rule only fires on true floods; day-to-day abuse is handled
at origin with precise, payment-aware logic.

### 2. Admin endpoints — managed challenge

Admin paths serve humans. Interactive challenges are safe and effective here.

**Custom rule** (Security → WAF → Custom rules):

```
Name: dashcommerce-admin-challenge
Expression:
  (starts_with(http.request.uri.path, "/_emdash/admin") and not cf.threat_score gt 0)
Action: Managed Challenge
```

### 3. API endpoints — block known-bad signatures

**Custom rule:**

```
Name: dashcommerce-api-no-bodyless-post
Expression:
  (http.request.method in {"POST" "PUT"} and
   starts_with(http.request.uri.path, "/_emdash/api/plugins/dashcommerce/") and
   http.request.body.len eq 0 and
   http.request.uri.path ne "/_emdash/api/plugins/dashcommerce/checkout/webhook-mercadopago")
Action: Block
```

> Note: `http.request.body.len` requires a Business/Enterprise plan. On
> Free/Pro, skip this rule — origin validation already rejects malformed
> payloads.

### 4. Managed rules (all plans)

Enable **OWASP Core Ruleset** on the zone (Security → WAF → Managed rules).
The provider's endpoints are JSON APIs; set the OWASP sensitivity to **Low**
to avoid false positives on legitimate payment payloads, and add this
exception if needed:

```
Name: mp-webhook-owasp-exception
Expression:
  (http.request.uri.path eq "/_emdash/api/plugins/dashcommerce/checkout/webhook-mercadopago")
Action: Skip → OWASP Ruleset
```

The webhook body is validated by HMAC at origin; OWASP inspection there adds
latency without security value.

### 5. Bot Fight Mode

Enable **Bot Fight Mode** (Security → Bots). Storefront traffic gets standard
bot filtering; the webhook path is machine traffic but arrives from MP's
reputable egress and passes verified-bot detection. If you observe false
positives on the webhook, add a skip:

```
Name: mp-webhook-bot-skip
Expression:
  (http.request.uri.path eq "/_emdash/api/plugins/dashcommerce/checkout/webhook-mercadopago")
Action: Skip → Bot Fight Mode
```

## Applying via API

With a token holding `Zone → WAF → Edit`:

```sh
ZONE_ID="your-zone-id"

# Custom rules (phase http_request_firewall_custom)
curl -X POST \
  "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/rulesets/phases/http_request_firewall_custom/entrypoint/rules" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "managed_challenge",
    "expression": "starts_with(http.request.uri.path, \"/_emdash/admin\")",
    "description": "dashcommerce-admin-challenge"
  }'
```

Rate limiting rules use the
[`http_ratelimit` phase](https://developers.cloudflare.com/waf/rate-limiting-rules/create-api/).

## What NOT to do

| Anti-pattern | Why it breaks |
|---|---|
| Challenge on the webhook path | MP's notifier can't solve challenges → retry storms → silent order loss |
| Tight edge rate limit (<100/min) on the webhook | Legitimate MP bursts (flash sales, retries after deploy) get dropped |
| IP allowlist of MP egress only | MP rotates egress IPs; you'd block real notifications |
| Trusting the WAF instead of the signature | The HMAC check at origin is the only cryptographic proof of authenticity |

## Verification checklist after applying

- [ ] Storefront loads normally (no challenge on public paths)
- [ ] Cart + checkout work (POST with JSON body passes)
- [ ] Sandbox webhook arrives: pay a test order, order appears in admin
- [ ] Admin panel shows Managed Challenge once, then remembers the browser
- [ ] Security → Events shows the rules matching expected traffic
