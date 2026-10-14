# FASE 4 — Dependencias y Cadena de Suministro

> **Auditoría integral** — `dashcommerce-mercadopago` @ `7dd257d`
> Fase: **SOLO LECTURA** · Foco: grafo de dependencias, lockfile, install scripts, artefacto publicado, typosquatting

---

## 1. Grafo de dependencias del paquete publicado

| Categoría | Contenido | Verificación |
|---|---|---|
| `dependencies` | **NINGUNA** (0 runtime deps) | package.json verificado |
| `peerDependencies` | `@dashcommerce/core@^0.3.0`, `emdash@^1.2.0` (ambas `optional:false`) | Correcto: el host ya las provee |
| `devDependencies` | core 0.3.0 (pinnada), emdash 1.2.0 (pinnada), typescript ^5.9.0 | Solo build/test — no se publican |
| `bin` | `dashcommerce-mercadopago-setup` → `scripts/setup.mjs` | Incluido en tarball (verificado npm pack) |

**Cero dependencias runtime propias** es la postura de supply chain más fuerte posible: el tarball publicado no arrastra NINGÚN paquete transitivo. El `node_modules` local (548 paquetes) es exclusivamente el árbol dev de emdash/core (Astro, React, CodeMirror…) — irrelevante para el consumidor.

## 2. Lockfile (bun.lock)

| Check | Resultado |
|---|---|
| Fuentes no-registry (git+/http) | ✅ 0 — todas desde registry npm |
| Hashes de integridad | ✅ sha512 presentes por paquete (formato bun.lock, 4º elemento del array — verificado en `typescript@5.9.3`) |
| `bun install --frozen-lockfile` | ✅ En CI (ci.yml:20) — instalación reproducible |
| Pinnado de peers en dev | ✅ core 0.3.0 y emdash 1.2.0 exactas — los tests corren contra las versiones del contrato |

## 3. Install scripts (vector clásico de supply chain)

- package.json del paquete: **sin `preinstall`/`postinstall`/`prepare`** — solo `prepublishOnly` (build+typecheck+test, corre en el LADO DEL PUBLICADOR, no del instalador). ✅
- Verificado que ningún script del paquete ejecuta código en la máquina del consumidor al instalar. El `bin` setup.mjs es **opt-in explícito** (`bunx dashcommerce-mercadopago-setup`), no se ejecuta solo.

## 4. Typosquatting / confusión de nombres

- Nombre `dashcommerce-mercadopago`: verificada disponibilidad en npm (ciclo previo). Sin paquetes similares publicados que puedan confundir (`mercadopago` oficial de MP existe — el prefijo `dashcommerce-` lo desambigua correctamente).

## 5. Vulnerabilidades conocidas en el árbol dev

- **Limitación de entorno**: `npm audit`/`bun audit` no ejecutado en esta fase (requiere red de advisory; el árbol dev es de emdash/core, fuera del alcance del paquete publicado). Los 548 paquetes dev NO se distribuyen — su exposición es solo la máquina de desarrollo/CI.
- **Acción recomendada (no bloqueante)**: añadir `bun audit` o `npm audit --omit=dev` a CI como gate informativo para el árbol dev.

## 6. Hallazgos de FASE 4

| ID | Severidad | Título | Clasificación |
|---|---|---|---|
| — | — | **Sin hallazgos de supply chain.** Cero deps runtime, lockfile íntegro, sin install scripts, sin fuentes no-registry. | ✅ |
| AUD-006 | INFORMATIVA | Sin gate de auditoría de vulnerabilidades dev-tree en CI (bun audit) | Mejora recomendada |

## 7. Conclusión de la FASE 4

La postura de dependencias es **excelente para un paquete financiero**: cero superficie transitiva en el artefacto publicado, integridad verificada por lockfile, pares declarados como contract testing con versiones pinnadas en dev. El único gap es la ausencia de un gate de audit del árbol dev en CI — recomendación informativa.

**Estado**: FASE 4 completa → procediendo a FASE 5 (distribución y paquete).
