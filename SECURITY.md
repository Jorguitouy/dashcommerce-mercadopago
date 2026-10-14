# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ |

## Reporting a vulnerability

**Do not open a public GitHub issue for security problems.**

Email: **jorgeferreirauy@gmail.com**

Include:
1. Description of the vulnerability
2. Steps to reproduce (PoC if possible)
3. Affected versions
5. Potential impact

You will receive an acknowledgment within 72 hours. Fixes for accepted
vulnerabilities ship in a patch release and are credited in the CHANGELOG
(unless you prefer to remain anonymous).

## Security model

This package handles money. The design assumes a hostile network and
hostile input at every boundary:

### Webhook boundary

| Threat | Mitigation |
|---|---|
| Forged notifications | HMAC-SHA256 `x-signature` validation against the configured secret. Unsigned or wrongly-signed requests are rejected with 400. |
| Replay attacks | Event deduplication — already-processed payment ids return `{"duplicate":true}` and are never re-processed. |
| Timestamp drift / delayed replay | Signatures older than 5 minutes are rejected. |
| DoS / flooding | Per-IP rate limit: 30 req/min in 60s windows (KV counters). Returns 429. |
| Tampered amounts | Amount and currency are re-validated server-side against the order draft on every notification. A modified preference cannot over- or under-charge. |
| Unknown statuses | Never treated as success. Default is failure (fail-closed). |
| Information leakage | Internal errors return a generic 500 body. Stack traces, internal messages and credentials never appear in responses. |

### Refund boundary

| Threat | Mitigation |
|---|---|
| Double refunds (double-click / concurrent requests) | Distributed KV lock per payment reference with stale-lock takeover (>30s) and ownership-checked release. |
| Refund of unknown/stale payments | Payment reference must exist and be in a refundable state. |

### Credential handling

| Threat | Mitigation |
|---|---|
| Secret exposure via admin API | Stored secrets are masked (`••••`) in every response. Values are never echoed back. |
| Weak credentials | Access tokens must carry the `TEST-` or `APP_USR-` prefix; webhook secrets must be ≥8 chars. Rejected otherwise. |
| Logging | Credentials and signatures are never logged. |
| Client leakage | Tokens/secrets are server-side only — never serialized to the browser. |

### Money handling

| Threat | Mitigation |
|---|---|
| Floating-point drift | Integer-only minor-unit arithmetic throughout. No float math on any price, ever. Property-based tests verify random round-trips. |
| Currency confusion | Strict per-currency allowlist + minor-unit digit table. Unsupported currencies are rejected before any charge. |
| Stale checkout tabs | Preferences carry `date_of_expiration` aligned with the order draft TTL — a payment on an expired draft is rejected by the webhook, and the preference itself expires so the customer cannot pay a stale cart. |

## Scope

In scope: this package's source (`src/`), its routes, and its interaction with
the Mercado Pago API.

Out of scope: vulnerabilities in `@dashcommerce/core`, `emdash`, Astro, or the
Mercado Pago platform itself (report those to their respective maintainers).
