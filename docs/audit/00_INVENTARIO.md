# FASE 0 — Inventario y Reconocimiento

> **Auditoría integral de seguridad, vulnerabilidades y calidad** — `dashcommerce-mercadopago`
> Repositorio: https://github.com/Jorguitouy/dashcommerce-mercadopago
> Commit auditado: `7dd257d` (master, 2026-10-14) · Fase: **SOLO LECTURA** (sin cambios a código fuente)
> Auditor: equipo AppSec multidisciplinario · Metodología: OWASP ASVS, OWASP Top 10, API Security Top 10, SSDLC

---

## 1. Identificación del proyecto

| Atributo | Valor |
|---|---|
| Nombre | `dashcommerce-mercadopago` v0.1.1 (no publicado aún en npm) |
| Tipo | Plugin wrapper — payment provider Mercado Pago (Checkout Pro) para DashCommerce |
| Lenguaje | TypeScript (ESM), target ES2022, `strict: true`, `isolatedModules` |
| Runtime | Node ≥ 20 / Bun ≥ 1.2 (`packageManager: bun@1.3.14`) |
| Licencia | MIT |
| Dominio | **Procesamiento de pagos reales** (LatAm + USD/EUR) |
| Peer deps | `@dashcommerce/core@^0.3.0`, `emdash@^1.2.0` (ambas obligatorias) |
| Dev deps | core 0.3.0, emdash 1.2.0, typescript ^5.9.0 — **cero dependencias runtime propias** |
| CI | GitHub Actions: bun install --frozen-lockfile → tsc --noEmit → bun test |
| Estado git | master limpio, 3 commits, sincronizado con origin |

## 2. Inventario de archivos (git ls-files, 41 archivos)

| Categoría | Archivos |
|---|---|
| **Fuente (8)** | [src/index.ts](file:///c:/Users/servi/Desktop/servicedecalefones/dashcommerce-mercadopago/src/index.ts) (descriptor factory), [src/entry.ts](file:///c:/Users/servi/Desktop/servicedecalefones/dashcommerce-mercadopago/src/entry.ts) (entrypoint runtime), [src/provider.ts](file:///c:/Users/servi/Desktop/servicedecalefones/dashcommerce-mercadotones/src/provider.ts) (adapter PaymentProvider), [src/webhook.ts](file:///c:/Users/servi/Desktop/servicedecalefones/dashcommerce-mercadopago/src/webhook.ts) (verificación), [src/routes.ts](file:///c:/Users/servi/Desktop/servicedecalefones/dashcommerce-mercadopago/src/routes.ts) (rutas webhook+admin), [src/signature.ts](file:///c:/Users/sservi/Desktop/servicedecalefones/dashcommerce-mercadopago/src/signature.ts) (HMAC), [src/money.ts](file:///c:/Users/servi/Desktop/servicedecalefones/dashcommerce-mercadopago/src/money.ts) (aritmética exacta), [src/types.ts](file:///c:/Users/servi/Desktop/servicedecalefones/dashcommerce-mercadopago/src/types.ts) |
| **Tests (11)** | money, money-properties, provider, security, signature, webhook, webhook-defensive, refund-dedup, admin-settings, rate-limit-stress, concurrency |
| **Docs (6)** | ARCHITECTURE, SECURITY_MODEL, SETUP, OPERATIONS, TEST_MATRIX, CLOUDFLARE |
| **Meta** | package.json, tsconfig.json, tsconfig.build.json, bun.lock, .gitignore, LICENSE, SECURITY.md, CONTRIBUTING.md, CHANGELOG.md |
| **READMEs (3)** | EN / ES / PT |
| **Otros** | scripts/setup.mjs (bin CLI), skills/dashcommerce-mercadopago-setup/SKILL.md, .github/workflows/ci.yml, 2 issue templates |

## 3. Arquitectura del sistema (reconstruida del código)

```
astro.config.mjs (app consumidora)
  └─ dashcommerceWithMercadoPago() [src/index.ts]
       └─ descriptor idéntico al core + entrypoint propio + api.mercadopago.com en allowedHosts
            └─ createPlugin [src/entry.ts]
                 ├─ registra mercadopagoProvider en el registry compartido (marker idempotente)
                 ├─ merge routes: checkout/webhook-mercadopago (público, raw) + admin/mercadopago/settings
                 └─ settingsSchema: 2 secrets → AES-GCM en reposo (emdash)
Flujo de pago:
  checkout → initCheckout → POST api.mercadopago.com/checkout/preferences (idempotencia UUID FNV-1a)
  MP → webhook-mercadopago → rate limit (CAS) → x-signature HMAC → live-retrieve → binding (ext_ref/amount/currency) → signEnrichedEvent (HMAC+bodyHash) → core checkout/webhook → dedupe → live-retrieve (capa 3) → reconcile → orden
Refunds: lock CAS mp:refund:lock:<paymentId> (30s stale) → POST /v1/payments/{id}/refunds
```

**Cadena de confianza del webhook** (4 capas de defensa, verificadas):
1. Firma MP `x-signature` (HMAC-SHA256, timing-safe, ±5min)
2. Firma interna reinyección (HMAC + SHA-256 del body completo)
3. Live-retrieve del core (nunca confía en el body)
4. reconcilePaymentAmount → integrityHold si mismatch

## 4. Línea base verificada (evidencia de ejecución)

| Check | Resultado | Evidencia |
|---|---|--- inventory |
| `bun test tests/` | ✅ **117 pass / 0 fail / 2.807 aserciones / 11 archivos** | salida 2026-10-14T00:28 |
| `bunx tsc --noEmit` | ✅ 0 errores | salida 2026-10-14T00:29 |
| `npm pack --dry-run` | ✅ 37 archivos, 80.3 kB, dist/ compilado incluido, `scripts/setup.mjs` incluido (auto-incluido por `bin`) | salida 2026-10-14T00:33 |
| Secretos en repo | ✅ Solo fixtures falsos (`TEST-abcdef1…`, `TEST-xyz9876…`) | scan regex 2026-10-14T00:29 |
| Git | ✅ master limpio, HEAD = 7dd257d = origin/master | 2026-10-14T00:27 |

## 5. Hallazgos preliminares de la FASE 0

> Se desarrollarán con evidencia completa en las fases 1-9. Los IDs son provisionales.

| ID | Severidad prelim. | Título | Estado |
|---|---|---|---|
| **AUD-001** | MEDIA | Rate limiter: contadores KV `state:mpWebhookRate:<ip>:<window>` **nunca se eliminan** — el comentario "self-expire by window rotation" es incorrecto; `createKVAccess` de emdash no implementa TTL. Vector DoS de almacenamiento con IPs spoofeadas (x-forwarded-for). El core sí barre sus locks (`sweep-stock-locks` cron) pero solo prefijo `lock:`. | Confirmado (código + dist emdash) |
| **AUD-002** | MEDIA | README/docs dicen "17 currencies" pero `SUPPORTED_CURRENCIES` tiene **9** (UYU ARS BRL CLP COP MXN PEN USD EUR). Marketing vs código. | Confirmado |
| **AUD-003** | BAJA | [ci.yml](file:///c:/Users/servi/Desktop/servicedecalefones/dashcommerce-mercadopago/.github/workflows/ci.yml#L30) línea 30: "Tests: 111 expected across 10 files" — desactualizado (117/11). Además la línea es un `echo` estático engañoso (no mide nada). | Confirmado |
| **AUD-004** | BAJA | README tabla de suites de test omite `concurrency` (6 tests que cubren SEC-001/002). SKILL.md dice "111 tests". TEST_MATRIX.md dice "75/75 PASS" y "bun test tests/mercadopago/" (obsoleto — la suite real es tests/ con 117). | Confirmado |
| **-** | — | Sin secretos reales en repo, dist/ compilado correcto, licencia MIT, SECURITY.md con policy de disclosure, CI en rama correcta | ✅ Positivos |
| **-** | — | Los 5 hallazgos de la auditoría externa previa (SEC-001/002/003, BUG-001, CI-001) **están corregidos y verificados** en el código auditado | ✅ Verificado |

## 6. Preguntas de investigación para FASES 1-8

1. **AUD-001**: ¿existe alguna vía de limpieza para `state:mpWebhookRate:*`? ¿El `list()` del KV permite barrido por prefijo? (Sí — ver `createKVAccess.list(keyPrefix)`; factible un sweep)
2. **AUD-002**: ¿MP Preferences API soporta más monedas de las listadas? ¿Es claim de marketing o bug?
3. Flujo pending→approved: el core solo borra stock locks en `charge.failed`, no el draft — ¿un pago `in_process` que luego pasa a `approved` re-crea la orden correctamente? (webhook.ts ya lo maneja: pending → charge.failed con pending flag → MP re-notifica)
4. ¿`notification_url` derivado del origin del successUrl funciona en producción tras proxy/CDN?
5. ¿La validación de prefijo `TEST-/APP_USR-` del admin POST es suficiente? (no valida formato completo del token)
6. **Supply chain**: bun.lock congelado, pero ¿audit de vulnerabilidades de dependencias transitivas? (FASE 4)
7. **CI/CD**: `permissions` no declarado en ci.yml (GitHub default: write-all en algunos casos) — evaluar en FASE 6
8. ¿Rate limit fail-open tras 8 intentos CAS es aceptable? (documentado, pero evaluar en FASE 8)
9. `toMpOffsetIso` hardcodea **-03:00** (America/Montevideo) — ¿qué pasa con servidores en otros husos horarios? (el Date se construye con Date.now() UTC, el offset solo afecta la presentación; MP interpreta ISO con offset → correcto en cualquier huso)
10. `validateCheckoutUrl` allowlist de hosts MP: ¿cubre todos los países LatAm donde opera MP? (falta .com.ar/.com.br/.com.mx/.com.cl/.com.co/.com.pe en producción — solo sandbox)

## 7. Conclusión de la FASE 0

El repositorio está en estado **post-fixes verificado**: los 5 hallazgos de la auditoría externa previa están corregidos, la suite pasa 117/117, typecheck limpio, artefacto npm correcto (dist/ compilado + bin auto-incluido). La arquitectura de 4 capas de defensa del webhook es sólida y está documentada con evidencia empírica.

Se identificaron **4 hallazgos preliminares** (AUD-001 a AUD-004) que se desarrollarán con evidencia completa en las fases siguientes, más 10 preguntas de investigación. El hallazgo más significativo es AUD-001 (crecimiento no acotado de contadores de rate-limit en KV sin TTL), que es un defecto de diseño real con vector DoS, no un problema de documentación.

**Estado de la auditoría**: FASE 0 completa → procediendo a FASE 1 (errores funcionales).
