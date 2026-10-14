# Contributing to dashcommerce-mercadopago

Thanks for your interest in improving Mercado Pago support for DashCommerce!

## Ground rules

This package **handles money**. Contributions are held to a higher bar than
typical OSS:

1. **Never weaken a security invariant.** Signature validation, rate limits,
   fail-closed defaults, amount re-validation, integer money math — these are
   not negotiable. A PR that relaxes any of them will be rejected.
2. **Every bug fix needs a test that fails without the fix.** Money bugs get
   property-based tests when feasible.
3. **No floats. Ever.** All money math is integer minor units.
4. **No new dependencies** without discussion — the zero-runtime-dependency
   surface is a feature.
5. **Fail-closed over fail-open.** When in doubt, reject.

## Development setup

```sh
git clone https://github.com/Jorguitouy/dashcommerce-mercadopago
cd dashcommerce-mercadopago
bun install
bun test        # 111 tests — all must pass
bunx tsc --noEmit   # 0 errors
```

## Making changes

1. Fork + branch: `git checkout -b fix/short-description`
2. Make your change in `src/`
3. Add/adjust tests in `tests/` — the suite must stay green
4. Run both gates:

```sh
bun test
bunx tsc --noEmit
```

5. Commit with a clear message. Conventional commits appreciated
   (`fix:`, `feat:`, `test:`, `docs:`).
6. Open a PR describing **what** and **why**. For money-related changes,
   explain the failure mode your change prevents.

## Testing philosophy

| Suite | Purpose |
|---|---|
| money / money-properties | Integer math correctness under random inputs |
| provider | Capability gates, currency allowlist, status mapping |
| security | No secret leakage anywhere |
| signature / webhook | Notification pipeline integrity |
| webhook-defensive | Hostile input handling |
| refund-dedup | Concurrency safety |
| admin-settings | Credential handling |
| rate-limit-stress | DoS resistance |

When adding a feature, ask: "what happens if MP sends garbage here?" — and
test that.

## Reporting bugs

Open an issue with:
- DashCommerce core version + emdash version
- What you expected vs. what happened
- Relevant logs (NEVER include tokens or secrets — redact `TEST-…`/`APP_USR-…`)

Security issues: see [SECURITY.md](SECURITY.md) — do NOT open public issues
for those.

## License

By contributing, you agree your contributions are licensed under the MIT
License.
