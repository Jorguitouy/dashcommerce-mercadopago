# Mercado Pago — Matriz de Pruebas

> Cobertura de pruebas del plugin MP: cada caso con resultado verificado.
> Fecha: 2026-10-14. Suite: `bun test tests/` (151/151 PASS).

## 1. Unit tests — money.ts (20)

| # | Caso | Resultado |
|---|---|---|
| 1 | CLP 0 decimales (mayús/minús) | ✅ |
| 2 | BHD/KWD 3 decimales | ✅ |
| 3 | UYU/USD 2 decimales | ✅ |
| 4 | minorUnitsToDecimalString exacto (150000→"1500.00", 2099→"20.99", 5→"0.05") | ✅ |
| 5 | CLP passthrough entero | ✅ |
| 6 | BHD "1.500"/"0.001" | ✅ |
| 7 | Rechazo negativos | ✅ |
| 8 | Rechazo no-safe-integer (float, >MAX_SAFE) | ✅ |
| 9 | minorUnitsToDecimalNumber exacto | ✅ |
| 10 | Round-trip number→minor units | ✅ |
| 11 | Parse "1500.00" UYU → 150000 | ✅ |
| 12 | Parse CLP "1500" → 1500 | ✅ |
| 13 | Parse BHD "1.500" → 1500 | ✅ |
| 14 | Acepta JSON numbers defensivamente (20.99 USD → 2099) | ✅ |
| 15 | Rechaza "abc", "1,500.00", "1e3", "" | ✅ |
| 16 | Rechaza "-5.00" | ✅ |
| 17 | Rechaza "1500.005" UYU (3 dec en moneda de 2) | ✅ |
| 18 | Rechaza NaN/Infinity | ✅ |
| 19 | Rechaza fuera de safe-integer | ✅ |
| 20 | formatMinorUnits "UYU 1500.00" / "CLP 1500" | ✅ |

## 2. Unit tests — signature.ts (15)

| # | Caso | Resultado |
|---|---|---|
| 1 | Header bienformado ts+v1 | ✅ |
| 2 | Whitespace y orden invertido | ✅ |
| 3 | Null si falta ts o v1 | ✅ |
| 4 | Manifest lowercase data.id | ✅ |
| 5 | Firma válida (ts segundos) | ✅ |
| 6 | Firma válida (ts milisegundos) | ✅ |
| 7 | Firma manipulada (otro payment id) → mismatch | ✅ |
| 8 | ts expirado (6 min) → fuera de ventana | ✅ |
| 9 | ts futuro (>5 min) → rechazo | ✅ |
| 10 | Header malformado | ✅ |
| 11 | Secret incorrecto | ✅ |
| 12 | request-id alterado | ✅ |
| 13 | ts no numérico → fail closed | ✅ |
| 14 | v1 no-hex | ✅ |
| 15 | Reason nunca contiene el secret | ✅ |

## 3. Unit tests — provider.ts (11)

| # | Caso | Resultado |
|---|---|---|
| 1 | charge.succeeded enriquecido completo | ✅ |
| 2 | Fallback providerEventId = paymentReference | ✅ |
| 3 | charge.failed con reason | ✅ |
| 4 | Tipo desconocido → unhandled | ✅ |
| 5 | JSON inválido → unhandled/unparseable | ✅ |
| 6 | JSON no-objeto → unhandled | ✅ |
| 7 | charge.succeeded sin orderDraftId → unhandled | ✅ |
| 8 | Adversarial: nunca success sin campos requeridos | ✅ |
| 9 | Contrato PaymentProvider completo | ✅ |
| 10 | Monedas soportadas + case-insensitive | ✅ |
| 11 | formatAmount decimal exacto | ✅ |

## 4. Unit tests — security.ts (14)

| # | Caso | Resultado |
|---|---|---|
| 1 | URL https en host MP allowlisted | ✅ |
| 2 | Rechazo http/javascript:/data:/ftp: | ✅ |
| 3 | Rechazo host no-allowlisted (evil.com, .evil.com sufijo) | ✅ |
| 4 | Rechazo credenciales embebidas user:pass@ | ✅ |
| 5 | Rechazo undefined/""/"not a url"/null | ✅ |
| 6 | Idempotency key estable por draft | ✅ |
| 7 | Keys distintas para drafts distintos | ✅ |
| 8 | Forma UUID v4 correcta (fix H-3) | ✅ |
| 9 | approved → succeeded + minor units exactos | ✅ |
| 10 | 5 estados pending → pending | ✅ |
| 11 | rejected/cancelled → failed | ✅ |
| 12 | Estado DESCONOCIDO → failed (nunca succeeded) | ✅ |
| 13 | Monto malformado → failed, nunca adivina | ✅ |
| 14 | Sin amount → omite (status approved solo) | ✅ |

## 5. Integration tests — webhook.ts (15)

| # | Caso | Resultado |
|---|---|---|
| 1 | Aprobado + amount/currency exactos → charge.succeeded + Bearer en fetch | ✅ |
| 2 | GET → 405 | ✅ |
| 3 | Sin data.id → 400 | ✅ |
| 4 | Sin x-signature → 400 | ✅ |
| 5 | Firma inválida → 400 ANTES de live-retrieve (0 fetch calls) | ✅ |
| 6 | Live-retrieve falla → 502 (MP reintenta) | ✅ |
| 7 | Sin external_reference → 400 | ✅ |
| 8 | Draft consumido → 200 duplicate | ✅ |
| 9 | Amount menor (0.99 vs 20.99) → 400 | ✅ |
| 10 | Amount MAYOR (25.00 vs 20.99) → 400 (no overpay) | ✅ |
| 11 | Currency mismatch → 400 (fix H-2: orden correcto) | ✅ |
| 12 | rejected → charge.failed | ✅ |
| 13 | in_process → charge.failed + pending flag | ✅ |
| 14 | Estado desconocido → NUNCA charge.succeeded | ✅ |
| 15 | Round-trip sign→verify + tampering del body FALLA (fix H-1) | ✅ |

## 6. E2E contra server real (puerto 4324)

| # | Caso | Resultado |
|---|---|---|
| 1 | Carrito completo → preferencia MP real (sandbox URL) | ✅ e2e-full-checkout.mjs |
| 2 | Webhook firma válida + id falso → 502 live-retrieve | ✅ sim-webhook.mjs |
| 3 | Webhook firma inválida → 400 signature mismatch | ✅ |
| 4 | Replay 10x idéntico → comportamiento uniforme | ✅ replay-test.mjs |
| 5 | Concurrencia 5x → sin races ni 500s | ✅ concurrent-test.mjs |
| 6 | checkout/mode → 200 hosted | ✅ |
| 7 | Admin settings sin auth → 401 | ✅ |
| 8 | Registry: stripe + mercadopago sin colisión | ✅ |
| 9 | Refund endpoint plural → 404 correcto con id falso | ✅ |
| 10 | ts expirado (-10min) con HMAC válido → 400 ventana (live) | ✅ ts-window-test.mjs (16:55Z) |
| 11 | ts futuro (+10min) con HMAC válido → 400 ventana (live) | ✅ ts-window-test.mjs (16:55Z) |
| 12 | Burst legítimo 12 webhooks firmados → 12/12 al live-retrieve, 0×429 (live) | ✅ legit-burst-test.mjs (16:57Z) |
| 13 | Admin GET/POST settings sin auth → 401 (live, re-verificado) | ✅ (16:54Z) |
| 14 | Pago sandbox real → orden creada → thank-you | ⏳ PENDIENTE (bloqueado: reCAPTCHA Enterprise exige login manual — ver FINAL_REPORT §6) |
| 15 | Extreme malformed payloads (SQLi chars, 10KB ids, path traversal, ids negativos/float, unicode con firma válida, 10KB garbage signature, v1 vacío, data.id duplicado, null byte) → 10/10 clean JSON, 0×500, sin stack traces (live) | ✅ malformed-extreme-test.mjs (18:42Z) |
| 16 | Webhook con pago REAL de MP (rejected 1353603273, ext_ref=draft tienda) → 200 received, live-retrieve OK, 0 órdenes creadas (fail-closed correcto) | ✅ sim-webhook.mjs (19:28Z) |
| 17 | Replay 3× del webhook del pago REAL → 3×200 duplicate:true (idempotencia con eventos reales, no solo mocks) | ✅ (19:38Z) |
| 18 | H-10: 26× create-session anónimo agota stock (25×200 + 409 "only 0 available"); cliente legítimo 409; recovery tras TTL: locks 25→0, create-session 200 | ✅ lock-exhaustion-test.mjs + lock-recovery-check.mjs (19:10Z/19:37Z) |
| 19 | Thank-you page con draft del pago REAL: by-draft → 200 {"status":"pending"}; HTML 7/7 checks (sin secrets, sin cookies, estado pending) | ✅ thankyou-live-check.mjs (19:43Z) |

## 7. Casos NO cubiertos (documentados)

- Refund con paymentId real sandbox (requiere pago real primero).
- Webhook secret real de MP (placeholder en uso — ver SECURITY.md §4.1).
- Transición in_process→approved con pago real (la lógica está testeada con
  mocks; el flujo real requiere pago real).
- Build de producción completo (`cf:deploy` — fuera de alcance: no deploy).
