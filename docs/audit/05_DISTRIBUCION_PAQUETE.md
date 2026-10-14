# FASE 5 — Distribución y Paquete

> **Auditoría integral** — `dashcommerce-mercadopago` @ `7dd257d`
> Fase: **SOLO LECTURA** · Foco: artefacto npm, exports map, engines, entrypoint resolution, docs publicadas

---

## 1. Artefacto npm (npm pack --dry-run, verificado 2026-10-14)

| Propiedad | Valor | Veredicto |
|---|---|---|
| Archivos | 37 | ✅ |
| Tamaño | 80.3 kB packed / 268.4 kB unpacked | ✅ |
| Entradas | `dist/` compilado (16: 8 .js + 8 .d.ts) + `src/` + `docs/` (6) + 3 READMEs + scripts/setup.mjs + meta | ✅ |
| `bin` incluido | ✅ `scripts/setup.mjs` auto-incluido por npm (target de `bin`) | ✅ |
| `skills/` | NO incluido — decisión documentada (skill para agentes del repo, no runtime) | ✅ aceptable |
| shasum | `57622a0b2b4c55b7bd85b69a538f89509a9be136` | registrado |

## 2. Exports map y resolución de entrypoint (verificado contra emdash dist)

- `generatePluginsModule` (emdash virtual-modules) genera: `import { createPlugin } from "<descriptor.entrypoint>"` → el descriptor de nuestro `dashcommerceWithMercadoPago()` setea `entrypoint: "dashcommerce-mercadopago/entry"` → `exports["./entry"]` → `dist/entry.js` compilado. **Cadena completa verificada.** ✅
- Todos los imports relativos en dist/ usan extensión `.js` (estilo ESM Node) — verificado en los 8 archivos. ✅
- **Import real en Node puro v24**: `dist/money.js` importa y ejecuta (`minorUnitsToDecimalString(150000,"UYU") → "1500.00"`). ✅ (BUG-001 del ciclo previo cerrado y re-verificado)

## 3. Engines y compatibilidad

| Claim | Verificación |
|---|---|
| `engines: node >= 20` | ✅ dist/ es JS ESM puro sin TS — ejecutable en Node 20 (verificado en v24; sin sintaxis post-ES2022 — target tsc ES2022) |
| `packageManager: bun@1.3.14` | ✅ informativo (corepack), no restrictivo |
| Peer `@dashcommerce/core@^0.3.0` + `emdash@^1.2.0` | ✅ pinnadas en dev (contract testing contra las versiones del contrato) |

## 4. Discrepancias documentación vs artefacto (consolidadas de FASE 1 §3)

> Estas son las publicadas EN el tarball (README.md, README.es.md, README.pt.md, docs/, SKILL.md no publicado pero visible en repo).

| ID | Archivo:claim | Realidad | Severidad |
|---|---|---|---|
| **DOC-001** | README×3: "17 currencies — ARS, BRL, CLP, COP, MXN, PEN, UYU, **BOB, PYG**, plus USD and EUR" | `SUPPORTED_CURRENCIES` = 9 (sin BOB/PYG). Además el claim "Accept payments across all of Latin America" es funcionalmente falso en producción por BUG-002 (solo UY funciona) | **MEDIA** — claim de marketing financieramente sensible: un comercio BOB/PYG instala y el checkout falla con "Currency not supported" |
| **DOC-002** | README tabla Testing: 10 suites | 11 archivos (falta `concurrency`) | BAJA |
| **DOC-003** | SKILL.md:126 "111 tests" | 117 | BAJA |
| **DOC-004** | ci.yml:30 `echo "Tests: 111 expected across 10 files"` | 117/11 — y es un echo estático que no mide nada (métricas falsas en CI) | BAJA |
| **DOC-005** | TEST_MATRIX.md:4 "75/75 PASS, bun test tests/mercadopago/" | Suite real: `bun test tests/` 117/11; estructura plana `tests/` | BAJA |
| **DOC-006** | OPERATIONS.md:76 `bun test tests/mercadopago/` | Ídem | BAJA |
| **DOC-007** | ARCHITECTURE.md §8 "75/75", árbol `tests/mercadopago/` | Ídem | BAJA |

**Nota**: CHANGELOG 0.1.0 "111 tests across 10 files" era correcto EN su momento (histórico válido); SECURITY_MODEL §5 "117" correcto.

## 5. Verificación adicional del artefacto

- **`prepublishOnly`**: `build && typecheck && test` — gate de publicación correcto (falla el publish si algo rompe). ✅
- **Versionado**: 0.1.1 en package.json, CHANGELOG actualizado a 0.1.1, sin tag git aún para 0.1.1 (el tag `v0.1.0` existe; **pendiente**: taggear v0.1.1 al publicar). ⚠️ nota operativa.
- **README badge** `tests-117%2F117` ✅ correcto.
- **Homepage/repo/bugs URLs** apuntan al repo correcto. ✅
- **Licencia**: MIT + archivo LICENSE incluido en tarball. ✅

## 6. Hallazgos de FASE 5

| ID | Severidad | Título | Clasificación |
|---|---|---|---|
| DOC-001 | MEDIA | Claim "17 currencies / all of Latin America" en 3 READMEs vs 9 monedas reales + BUG-002 (solo UY en producción) | Confirmado |
| DOC-002…007 | BAJA | Métricas obsoletas (111/75 tests, paths tests/mercadopago/, suite concurrency omitida) en 6 archivos | Confirmado |
| — | INFORMATIVA | v0.1.1 sin git tag aún (publicación pendiente) | Operativa |

## 7. Conclusión de la FASE 5

El artefacto es estructuralmente correcto y ejecutable en los runtimes prometidos (verificado con import real). La deuda está en las **afirmaciones publicadas**: el claim central de marketing ("17 monedas, toda LatAm") no se sostiene contra el código (9 monedas) ni contra la allowlist (solo UY productivo) — en un paquete financiero, sobreprometer cobertura es un riesgo de confianza y soporte, no solo cosmético.

**Estado**: FASE 5 completa → procediendo a FASE 6 (CI/CD).
