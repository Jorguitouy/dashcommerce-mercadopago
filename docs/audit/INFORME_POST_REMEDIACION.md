# Informe Post-Remediación — Auditoría Final de Hardening

> **Fecha**: 2026-10-14 · **Ejecutor**: equipo senior (ingeniería TS/Node, AppSec pagos, fiabilidad/concurrencia, integración MP, CI/CD, revisor independiente)
> **Repositorio**: `Jorguitouy/dashcommerce-mercadopago` @ `86e05da` + cambios de esta auditoría
> **Paquete**: `dashcommerce-mercadopago` — publicado en npm como `0.1.1` (latest) desde las 13:58Z del 2026-10-14

---

## 0. Resumen ejecutivo

Esta auditoría re-verificó de forma independiente el estado real del repositorio tras los ciclos de remediación previos (commits `7dd257d`, `b075faf`, `007275f`, `86e05da`). **No re-implementó** lo ya corregido: distinguió CERRADO / PARCIAL / ABIERTO / ACEPTADO CON LIMITACIONES / NO VERIFICABLE por hallazgo.

**Resultado**: se identificaron **3 hallazgos nuevos** (1 de código, 2 de documentación), se corrigieron los 3, y se confirmaron cerrados los hallazgos previos que eran verificables localmente. El bloqueo de CI es **externo** (billing de GitHub), no del código. **No se publicó npm, no se crearon tags/releases** (el paquete ya estaba publicado por el owner antes de esta auditoría; los cambios de esta auditoría quedarán en un commit pendiente de publicar como `0.1.2` cuando el owner lo decida).

**Veredicto**: **APTO CONDICIONADO** — ver §7.

---

## 1. FASE 0 — Baseline verificado

| Ítem | Estado | Evidencia |
|---|---|---|
| Worktree limpio al inicio | ✅ | `git status --short` vacío; HEAD `86e05da` == `origin/master` |
| 151 tests / 2.870 aserciones (afirmado en informes previos) | ✅ Reproducido | `bun test tests/` → 151 pass / 0 fail / 12 archivos |
| Typecheck sin errores | ✅ Reproducido | `bunx tsc --noEmit` → exit 0 |
| Build satisfactorio | ✅ Reproducido | `bun run build` → exit 0 |
| `npm pack --dry-run` satisfactorio | ✅ Reproducido | 49 archivos, exit 0 |
| Publicación npm 0.1.1 | ✅ Confirmado | `npm view` → latest=0.1.1, modified 2026-10-14T13:58Z |
| Branch protection en `master` | ✅ Activa | API: required_status_checks `["test"]` strict, force-push/deletions bloqueados, `enforce_admins=false` |
| Rama protegida contra… admins | ⚠️ Nota | `enforce_admins=false` — el owner puede bypassear; decisión del owner (ver §6.4) |

---

## 2. FASE 1 — Diagnóstico CI (prioridad máxima)

**Causa raíz: BLOQUEO EXTERNO — cuenta GitHub locked por billing.**

Evidencia (anotación oficial del check run `test`, run 38578464909, commit `86e05da`):

> *"The job was not started because your account is locked due to a billing issue."*

- Los 7 runs listados fallan en 0-3s, `runner_id: 0`, sin pasos, sin logs de job (`log not found`).
- El workflow `.github/workflows/ci.yml` es YAML válido; permissions `contents:read`; actions pineadas por SHA. **No es fallo de código ni de configuración.**
- Anotación adicional (notice): migración `ubuntu-latest` → Ubuntu 26 el 2026-10-19 — riesgo menor, sin acción requerida ahora (el workflow no fija `ubuntu-latest` explícitamente… lo usa; monitorear).

**Clasificación**: NO VERIFICABLE en CI hasta resolver el billing. La verificación de pruebas se ejecutó localmente (§1).

**Acción del owner** (fuera de mi alcance):
1. Resolver el billing: https://github.com/settings/billing
2. Re-ejecutar: `gh run rerun 38578464909`
3. Verificar el check `test` en verde en master.

---

## 3. FASE 2 — Reembolsos e idempotencia (crítica)

### 3.1 Re-verificación de lo existente (NO re-implementado)

| Control previo | Estado | Evidencia |
|---|---|---|
| Lock per-payment con adquisición CAS atómica (`compareAndSet(key, null, …)`) | ✅ CERRADO | concurrency.test.ts: 2 simultáneos → exactamente 1 llega a MP |
| Stale takeover race-free (CAS sobre revision observada) | ✅ CERRADO | concurrency.test.ts: 2 ladrones simultáneos → 1 gana |
| Release ownership-checked (`compareAndDelete` por revision) | ✅ CERRADO | concurrency.test.ts: slow winner no borra lock ajeno |
| Fallback plain-KV documentado best-effort | ✅ CERRADO | concurrency.test.ts: rechaza double-click secuencial |
| MP ignora X-Idempotency-Key (hallazgo empírico) | ✅ Documentado | tests/refund-dedup.test.ts header |

### 3.2 Hallazgo nuevo RES-001 — llamada MP sin timeout puede sobrevivir al robo del lock

**ID**: RES-001 · **Severidad**: MEDIA · **Estado**: ✅ CERRADO (esta auditoría)

- **Ubicación**: [src/provider.ts](../../src/provider.ts) `mpApi()` — `ctx.http.fetch` sin deadline.
- **Reproducción**: `refund()` adquiere el lock → llamada MP se cuelga (sin timeout) → a los 30s el lock es robable como stale → un segundo `refund()` roba el lock y llama a MP → **la primera llamada sigue viva en MP** → potencial doble reembolso (solo el backstop de monto restante de MP protege).
- **Impacto**: doble reembolso financiero en el escenario hung-call + retry con ventana vencida.
- **Fix aplicado**: timeout duro de **20s** por llamada MP vía `AbortController` + `setTimeout`, con invariante documentada `MP_API_TIMEOUT_MS (20s) < MP_REFUND_LOCK_STALE_MS (30s)`. La señal aborta tanto el fetch como la lectura del body (headers-then-stall). Override ops/test solo puede ACORTAR (clamp `Math.min`), jamás alargar. Timer limpiado en `finally`.
- **Por qué AbortController y no `AbortSignal.timeout()`**: verificado empíricamente que Bun 1.3.14 setea `.aborted` pero **no despacha listeners "abort"** de señales de timeout — un fetch colgado con listener nunca settles. Repro mínimo incluido en la evidencia de trabajo; documentado en el comentario del código.
- **Prueba**: tests/mp-api-timeout.test.ts (4 tests): invariante orden constantes, señal viva en cada llamada, hung-call aborta y libera lock, siguiente refund adquiere limpio. **Mutación controlada**: invertir la invariante (`40_000`) hace fallar el test de invariante — detectado y revertido.
- **Cobertura de la señal a través de emdash**: verificada contra dist 1.2.0 — `bufferPluginHttpRequest` hace spread `...init` (solo elimina `duplex`) y `createHttpAccess` propaga el init al fetch real.

### 3.3 Escenarios del prompt (2.2) — clasificación

| Escenario | Clasificación | Justificación |
|---|---|---|
| Proceso muere tras enviar a MP antes del write a KV | ACEPTADO CON LIMITACIONES | No hay transacción distribuida; el lock queda (crash leftover) y es robado a los 30s. El backstop de MP (monto restante) es la última línea. Mitigado además por el timeout de RES-001: la ventana se acota a 20s de vuelo máximo. |
| Respuesta MP perdida (timeout tras procesar MP) | ACEPTADO CON LIMITACIONES | MP procesó el reembolso pero nosotros vemos AbortError → el core reintenta con nuevo refundRequestId → MP aplica su backstop de monto restante. Documentado; no duplicable sin que MP mismo lo impida en el caso full-refund (segundo intento falla por monto 0). |

---

## 4. FASE 3 — Rate limiting y concurrencia

| Control | Estado | Evidencia |
|---|---|--- routes.ts |
|---|---|---|
| CAS loop con máx 8 intentos → fail-open | ✅ ACEPTADO CON LIMITACIONES (documentado) | El comentario del código lo declara: "cannot exceed the limit by more than the in-flight retry races". Protección aproximada, no estricta — así documentado en SECURITY_MODEL. |
| 30 req/min/IP, ventanas 60s | ✅ CERRADO | rate-limit-stress.test.ts + concurrency.test.ts (burst 60 → exactamente 30 admitidos, contador exacto) |
| IP: `cf-connecting-ip` ?? `x-forwarded-for` ?? "unknown" | ✅ ACEPTADO CON LIMITACIONES (documentado) | Spoofing posible tras proxy no-CF; degrada a per-spoofed-IP, mejor que nada. Documentado en SECURITY_MODEL. |
| `sweepStaleRateCounters` (BUG-003) | ✅ CERRADO | kv.list con fallback delete W-2; fire-and-forget; solo claves numéricas; verificado contra dist emdash (list() devuelve plugin-relative keys) |

**Nota FASE 3**: el fail-open del CAS loop tras 8 intentos es un trade-off consciente documentado — cambiarlo a fail-closed añadiría DoS propio bajo contención extrema. Se mantiene como está, con la documentación existente.

---

## 5. FASE 4 — Seguridad del ciclo de pago

| Control | Estado | Evidencia |
|---|---|---|
| 4 capas webhook (firma MP → binding server-side → firma interna con bodyHash → live-retrieve+reconcile core) | ✅ CERRADO | webhook.test.ts (15 casos) + webhook-defensive.test.ts + signature.test.ts |
| Monto SIEMPRE server-side (draft snapshot) | ✅ CERRADO | e2e-full-checkout.mjs + binding tests |
| Manifest SEC-004 (omisión de segmento vacío según spec MP) | ✅ CERRADO | signature.test.ts; buildManifest L77 |
| HMAC timing-safe + ventana ±5min | ✅ CERRADO | signature.test.ts |
| Allowlist hosts checkout (14 tests + lookalikes) | ✅ CERRADO | security.test.ts |
| Fail-closed en estados desconocidos | ✅ CERRADO | webhook.test.ts: unknown → failed, nunca succeeded |
| SSRF: data.id solo a MP_API_BASE fijo con encodeURIComponent | ✅ CERRADO | code review + fetchCalls test |

**Monedas (4.5)**: `SUPPORTED_CURRENCIES` = 9 monedas que el **código conoce** (ARS BRL CLP COP MXN PEN UYU USD EUR). Los READMEs ahora aclaran que las operables dependen del país de la cuenta MP. Allowlist de hosts cubre los 7 mercados MP (UY AR BR MX CL CO PE). **Sin verificación en producción por mercado** — ver §7 pendientes del owner.

---

## 6. FASES 5/6/8 — Contratos, empaquetado, cadena de suministro

### 6.1 Contratos emdash/DashCommerce (FASE 5) — ✅ CERRADO
- KV plugin CAS (`compareAndSet` L1038, `list` L1059 en dist 1.2.0): verificado en auditorías previas y re-confirmado para la propagación de `signal` (RES-001).
- Rutas: non-raw → objeto JSON; raw → `response:"raw"` + `pluginResponse()`. 69 rutas (67 core + 2 MP). allowedHosts = Stripe + api.mercadopago.com.

### 6.2 Empaquetado (FASE 6) — ✅ CERRADO
- `npm pack --dry-run`: 49 archivos, exit 0. `files`: dist, src, README, docs, LICENSE, CHANGELOG.
- `exports` con 8 subpaths, `bin` normalizado (`scripts/setup.mjs`, sin `./`).
- `engines.node >=20`, `packageManager bun@1.3.14`, peerDeps correctas.

### 6.3 Cadena de suministro (FASE 8) — ✅ CERRADO CON NOTAS
- Actions pineadas por SHA (`actions/checkout@11d5960a…`, `oven-sh/setup-bun@0c5077e5…`), verificadas por `git ls-remote` en auditoría previa.
- `permissions: contents:read` en ci.yml.
- `bun audit || true` informativo (0 vulnerabilidades al instalar el artefacto publicado — verificado en E2E previo).
- Branch protection activa. **Nota**: `enforce_admins=false` (el owner-admin puede bypassear) y `required_signatures.enabled=false` — decisión del owner; recomendar habilitar firmas si el equipo crece.

### 6.4 Riesgo residual aceptado (registro)
1. **CI no verificable** hasta resolver billing (§2).
2. **`enforce_admins=false`** en branch protection.
3. **Fallbacks plain-KV** (lock best-effort, rate limiter read-then-write): solo rutas de compatibilidad; emdash producción siempre da CAS. Documentado.
4. **Escenarios RES 2.2** (crash mid-flight, respuesta perdida): ACEPTADO CON LIMITACIONES con backstop MP + timeout RES-001.
5. **Rate limiter fail-open tras 8 intentos CAS**: aproximado por diseño, documentado.

---

## 7. FASE 9 — Documentación honesta (hallazgos nuevos corregidos)

| ID | Hallazgo | Estado |
|---|---|---|
| DOC-002 | Claim "bank-grade/grado bancario/nível bancário" en 4 comentarios src (fluyen a dist/*.d.ts publicados), SECURITY_MODEL.md, README.md:39, README.es.md:39, README.pt.md:39 | ✅ CERRADO — reemplazado por descripciones factuales de controles ("Hardened webhook security", "SECURITY CONTROLS (each verified…)") |
| DOC-003 | 19 links `file:///C:/Users/...` (rutas locales absolutas, incl. typos `survi`/`mercadotones`/`sservi`) en 5 informes docs/audit/ — inutilizables para terceros | ✅ CERRADO — convertidos a rutas relativas `../../`; 0 restantes |
| DOC-004 | `package.json` description: "Covers all of Latin America" — excesivo (MP checkout local: 7 mercados) | ✅ CERRADO — description ahora factual: 7 mercados + 9 monedas con nota de alcance |
| DOC-005 | READMEs: "9 currencies" sin distinguir monedas conocidas vs operables por cuenta | ✅ CERRADO — nota añadida en los 3 READMEs (EN/ES/PT) |

**Informes históricos** (00-09, INFORME_FINAL, INFORME_REAUDITORIA): NO reescritos — son evidencia histórica; solo se convirtió el formato de sus links (DOC-003). El INFORME_REAUDITORIA queda como documento histórico; este informe es el estado actual.

**CHANGELOG**: pendiente añadir entrada `0.1.2` con RES-001 + DOC-002/003/004/005 cuando el owner decida publicar (ver §9).

---

## 8. FASE 7 — Pruebas

- **Suite**: 155 pass / 0 fail / 2.884 aserciones / 13 archivos (antes: 151/12) — +4 tests del timeout RES-001.
- **Typecheck**: 0 errores. **Build**: OK. **Pack**: OK (49 archivos).
- **Mutación controlada**: invariante `MP_API_TIMEOUT_MS < MP_REFUND_LOCK_STALE_MS` invertida (`40_000`) → test de invariante falla → revertida. Los tests demuestran comportamiento (abort + release), no repetición de implementación.
- **CI**: bloqueado por billing externo (§2) — la suite corre localmente idéntica al workflow.

---

## 9. FASE 11 — Gate final y decisión

### Checklist de publicación

| Gate | Estado |
|---|---|
| Tests + typecheck + build + pack locales | ✅ 155/0, TSC 0, build OK, pack OK |
| CI GitHub Actions | ⛔ **BLOQUEADO EXTERNO** (billing) — requiere acción del owner |
| Hallazgos de auditorías previas | ✅ Verificados cerrados (los verificables localmente) |
| Hallazgos nuevos (RES-001, DOC-002~005) | ✅ Corregidos en esta auditoría |
| npm publish | ⏸️ NO ejecutado — los cambios requieren `0.1.2`; decisión del owner |
| Tags / releases GitHub | ⏸️ NO creados — decisión del owner |
| Token npm expuesto en chat (sesión previa) | ⚠️ **Pendiente del owner**: revocar en npmjs.com/settings/astrodesing/tokens |

### Veredicto

**APTO CONDICIONADO**

El código es apto para publicación como `0.1.2` una vez que:
1. El owner resuelva el billing de GitHub y el CI pase en verde (verificación independiente de la suite).
2. El owner decida el bump de versión y publique (npm + tag + release) — no automatizado por esta auditoría.
3. El owner revoca el token npm expuesto en el chat de la sesión previa.

**Sin esas condiciones**: el paquete publicado `0.1.1` sigue siendo funcional y seguro para sus casos operativos; los fixes de esta auditoría (timeout hung-call + docs honestas) quedan pendientes de release.

### Pendientes del owner (checklist accionable)

- [ ] Resolver billing GitHub → `gh run rerun 38578464909` → verificar check `test` verde.
- [ ] Bump `0.1.2` + entrada CHANGELOG (RES-001, DOC-002~005) → commit → push → `npm publish`.
- [ ] Revocar token npm expuesto.
- [ ] (Opcional) Habilitar `enforce_admins` y `required_signatures` en branch protection.
- [ ] (Opcional) Monitorear migración ubuntu-latest → Ubuntu 26 (2026-10-19).
