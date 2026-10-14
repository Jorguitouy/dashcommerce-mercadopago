# INFORME DE REAUDITORÍA — FASE 12

> **Proyecto**: `dashcommerce-mercadopago` v0.1.1 @ commit `b075faf` (master)
> **Alcance**: verificación de la remediación completa del plan P0–P3 de la auditoría integral ([INFORME_FINAL](INFORME_FINAL.md))
> **Fecha**: 2026-10-14 · **Metodología**: verificación de cada fix con evidencia fresca (grep del código, suite completa, typecheck, build, pack)

---

## A. Metodología de la reauditoría

Cada hallazgo del plan de remediación se verificó de forma independiente con evidencia del commit `b075faf`:

1. **Evidencia de código**: grep directo del patrón corregido en el archivo fuente.
2. **Evidencia de comportamiento**: los tests de regresión escritos ANTES del fix (metodología FASE 11) corren verdes en la suite completa.
3. **Evidencia de integración**: `bunx tsc --noEmit` (0 errores), `bun run build` (OK), `npm pack --dry-run` (artefacto válido).
4. **Evidencia de estado**: worktree clean, commit único con mensaje conventional, push a master.

## B. Verificación hallazgo por hallazgo

### P1 — Correcciones importantes (3/3 CERRADOS)

| # | Hallazgo | Severidad | Evidencia de cierre | Estado |
|---|---|---|---|---|
| P1-1 | **BUG-002** — allowlist de hosts de checkout incompleta (checkout roto fuera de Uruguay) | ALTA (funcional) | `src/provider.ts` `MP_CHECKOUT_HOSTS`: 19 matches de dominios productivos (www/apex × AR/BR/MX/CL/CO/PE, Chile `mercadopago.cl` sin `.com`, `sandbox.mercadopago.cl`). Test paramétrico: 14 casos país×forma + lookalike phishing en `tests/security.test.ts` | ✅ CERRADO |
| P1-2 | **SEC-004** — manifest de firma con segmento vacío (webhooks legítimos sin `x-request-id` rechazados) | MEDIA | `src/signature.ts:77`: `requestIdSegment = params.requestId === "" ? "" : \`request-id:…\`` — omisión del segmento completo según spec MP. 4 tests en `tests/signature.test.ts` (firma MP sin request-id aceptada + regresión con request-id) | ✅ CERRADO |
| P1-3 | **DOC-001** — claim "17 currencies" insostenible | MEDIA | Los 3 READMEs (EN/ES/PT) línea 37: "9 currencies/monedas/moedas" con lista real (ARS BRL CLP COP MXN PEN UYU + USD/EUR) | ✅ CERRADO |

### P2 — Robustez y mantenimiento (4/4 CERRADOS)

| # | Hallazgo | Evidencia de cierre | Estado |
|---|---|---|---|
| P2-1 | **BUG-003** — contadores de rate-limit sin expiración (DoS de almacenamiento) | `src/routes.ts`: `sweepStaleRateCounters()` (L121) + 2 llamadas fire-and-forget en los 2 caminos (CAS L165, fallback L197). `PluginKV.list?` declarado en `src/types.ts` verificado contra emdash 1.2.0 dist (`context-CvhgHgSH.mjs:1059`). 3 tests de barrido en `tests/rate-limit-stress.test.ts` (W-5/W-4/W-3 barridos vía list, W-1 retenido, fallback W-2 sin list) | ✅ CERRADO |
| P2-2 | **CI-002** — GITHUB_TOKEN sin permisos explícitos | `.github/workflows/ci.yml:11`: `permissions: contents: read` (least privilege) | ✅ CERRADO |
| P2-3 | **DOC-002…007** — métricas obsoletas en 6 archivos | Grep de `111 tests|117 tests|75/75|tests/mercadopago|10 test files`: 0 ocurrencias activas (solo la cita histórica intencional en SECURITY_MODEL). READMEs: 151/151 badge + tabla de 12 suites con `concurrency` y `contract`; SKILL.md 151; TEST_MATRIX `bun test tests/` 151/151; OPERATIONS path corregido; ARCHITECTURE §8 árbol real de 12 archivos; CI echo estático eliminado (ahora cuenta archivos reales) | ✅ CERRADO |
| P2-4 | **GAP-4/5/6** — tests de contrato del wrapper | `tests/contract.test.ts` (nuevo, 12 tests): refund sin amount → 0 sin crash; body `{}` para full refund; amount parseado del fallback MP; parseWebhookEvent total (defaults 0/UYU, unparseable→unhandled); createPlugin: provider registrado, 2 rutas MP mergeadas + core intacto, allowedHosts con MP+Stripe, 2 secrets en settingsSchema, síncrono | ✅ CERRADO |

### P3 — Mejoras preventivas (4/5 CERRADOS, 1 EXTERNO)

| # | Hallazgo | Evidencia de cierre | Estado |
|---|---|---|---|
| P3-1 | **CI-003** — actions sin pin por SHA | `ci.yml:21,24`: `actions/checkout@11d5960a…` (v4.4.0) y `oven-sh/setup-bun@0c5077e5…` (v2.2.0), SHAs verificados vía `git ls-remote` contra los repos upstream | ✅ CERRADO |
| P3-2 | **AUD-006** — sin auditoría de dependencias en CI | `ci.yml:34`: `bun audit \|\| true` (informativo; el árbol dev no se distribuye) | ✅ CERRADO |
| P3-3 | **AUD-007** — tag + release notes al publicar | ✅ CERRADO — tag `v0.1.1` pusheado; release público con notas del CHANGELOG: [releases/tag/v0.1.1](https://github.com/Jorguitouy/dashcommerce-mercadopago/releases/tag/v0.1.1) (verificado: isDraft=false) |
| P3-4 | **AUD-008** — riesgo residual del redactor documentado | `docs/SECURITY_MODEL.md` §AUD-008: hallazgo, por qué es aceptable, mitigación operativa, estado | ✅ CERRADO |
| P3-5 | Branch protection en GitHub | ✅ CERRADO — API PUT protection en master: required_status_checks `["test"]` (strict), allow_force_pushes=false, allow_deletions=false, enforce_admins=false (bypass owner mientras CI está bloqueado por billing) |

## C.1 Evidencia post-publicación (npm, verificación E2E del artefacto real)

Publicado el 2026-10-14 por **`astrodesing`** (jorgeferreirauy@gmail.com) — `npm view` confirma
`latest: 0.1.1`. Verificación de instalación real desde el registry (directorio limpio,
`npm install dashcommerce-mercadopago@0.1.1 --ignore-scripts`):

| Verificación | Resultado |
|---|---|
| Instalación desde registry | OK — **0 vulnerabilidades** reportadas por npm audit del install |
| API público (`dashcommerceWithMercadoPago`) | `function` — descriptor con id `dashcommerce`, entrypoint `dashcommerce-mercadopago/entry`, allowedHosts = Stripe + `api.mercadopago.com` |
| `entry.createPlugin({})` (Node puro, sin bundler) | **69 rutas**: `checkout/webhook-mercadopago` ✅, `admin/mercadopago/settings` ✅, `checkout/webhook` del core preservada ✅ |
| Token de publicación | Revocado de la máquina local tras el publish (expuesto en el chat); sesión previa restaurada |

> Nota de seguridad: el token granular usado para el publish se pegó en texto plano en el
> chat durante el proceso. Fue removido del `.npmrc` local inmediatamente después de la
> publicación. **Acción pendiente del owner**: eliminarlo también desde la web de npm
> ([Access Tokens](https://www.npmjs.com/settings/astrodesing/tokens)) por higiene.

## C. Verificación de suite e integridad (commit `b075faf`)

| Verificación | Resultado |
|---|---|
| `bun test tests/` | **151 pass / 0 fail / 2,870 aserciones / 12 archivos** (117 originales + 19 P1 + 3 BUG-003 + 12 contract) |
| `bunx tsc --noEmit` | **0 errores** |
| `bun run build` (tsc -p tsconfig.build.json) | **OK** — dist/ ESM JS + .d.ts |
| `npm pack --dry-run` | **OK** — 48 archivos, 115.3 kB empaquetado, 364.5 kB descomprimido; sin TypeScript crudo en el artefacto (BUG-001 sigue cerrado) |
| YAML del workflow | Válido (parseado con js-yaml) |
| Worktree | CLEAN — todo el ciclo P1+P2+P3 en un solo commit conventional |
| Push | `7dd257d..b075faf master -> master` |

### Pruebas de que los tests de regresión detectan los bugs (metodología FASE 11)

Confirmado durante el desarrollo: los tests de BUG-002, SEC-004 y BUG-003 **fallaban antes del fix** (12, 2 y 2 fallos respectivamente contra el código viejo) y pasan contra el código corregido — prueban el defecto, no la implementación.

## D. Pasos restantes para la publicación de v0.1.1 (requieren tu login interactivo)

El paquete **no está aún en npm** (verificado: 404 en registry). Todo el trabajo de código está completo y verificado. Solo queda:

1. **`npm publish`** (requiere tu sesión npm con `jorgeferreirauy@gmail.com`):
   ```sh
   npm publish
   ```
   El `prepublishOnly` gate ya corre build + tests automáticamente.

2. **Tag + release** (P3-3, tras publicar):
   ```sh
   git tag -a v0.1.1 -m "v0.1.1 — external + integral audit remediations"
   git push origin v0.1.1
   ```
   Release notes: usar la entrada [0.1.1] de CHANGELOG.md.

3. **Branch protection** (P3-5, Settings del repo GitHub): requerir CI en master, bloquear force-push.

## E. Dictamen de la reauditoría

# ✅ APTO — CONDICIONES P1/P2/P3 SATISFECHAS

Las **5 condiciones formales de aptitud** del INFORME_FINAL están cumplidas:

1. ✅ BUG-002 corregido + test paramétrico por país (GAP-1).
2. ✅ SEC-004 corregido + test de manifest sin request-id (GAP-2).
3. ✅ DOC-001 corregido (READMEs honestos en 3 idiomas).
4. ✅ BUG-003 corregido (barrido de contadores) + CI-002 (permissions read).
5. ✅ Suite completa verde (151 ≥ 117 + nuevos), typecheck 0, build OK, `npm pack` limpio.

**Los 14 hallazgos de la auditoría integral están cerrados al 100%** (código, docs, CI, publicación npm con tag v0.1.1 + release, y branch protection del repo). El paquete `dashcommerce-mercadopago@0.1.1` está **publicado en npm** (latest) y verificado E2E desde el registry.

**Alcance del dictamen**: igual que el INFORME_FINAL — no es una certificación de seguridad; cubre el código del plugin y su integración con `@dashcommerce/core@0.3.0` + `emdash@1.2.0` en la versión auditada. No cubre el despliegue del host, tráfico productivo real, ni PCI DSS (SAQ-A del comercio por separado).
