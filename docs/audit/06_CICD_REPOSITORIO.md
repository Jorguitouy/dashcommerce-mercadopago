# FASE 6 — CI/CD y Repositorio

> **Auditoría integral** — `dashcommerce-mercadopago` @ `7dd257d`
> Fase: **SOLO LECTURA** · Foco: workflow CI, permisos GITHUB_TOKEN, supply chain del pipeline, superficie del repo

---

## 1. Workflow CI ([.github/workflows/ci.yml](../../.github/workflows/ci.yml))

```yaml
on:
  push: { branches: [master, main] }   # ✅ CI-001 corregido (rama default master cubierta)
  pull_request:                          # ✅ PRs también corren CI
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2 (bun-version: latest)
      - run: bun install --frozen-lockfile
      - run: bunx tsc --noEmit
      - run: bun test tests/
      - run: echo "Tests: 111 expected across 10 files"   # ⚠️ DOC-004
```

### Hallazgo CI-002 (MEDIA) — Permisos del GITHUB_TOKEN no restringidos

- **Evidencia**: el workflow NO declara `permissions:` → GitHub aplica los **permisos por defecto del repo**. Si el repo tiene el default "Read and write permissions" (configuración común en repos creados vía UI moderna), el token del job CI puede escribir contenidos, crear releases y (en repos con workflows permitidos) modificar workflows.
- **Riesgo**: un compromiso del pipeline (p. ej. vía dependencia maliciosa en el árbol dev que ejecuta código durante `bun install` — 548 paquetes) obtiene un token con write sobre el repo → puede publicar commits/tags directamente. Para un paquete financiero con publicación npm desde este repo, es un eslabón de supply chain.
- **Clasificación**: Probable (depende del setting del repo, no verificable read-only desde el código; el default de GitHub para repos nuevos es read-only en orgs con política, write en repos personales legacy).
- **Severidad**: MEDIA.
- **Solución**: añadir al workflow:
  ```yaml
  permissions:
    contents: read
  ```
  Y verificar en Settings → Actions → General → Workflow permissions que el default del repo sea read-only.

### Hallazgo CI-003 (BAJA) — Actions pinnadas por tag mayor, no por SHA

- `actions/checkout@v4` y `oven-sh/setup-bun@v2` — la práctica de supply chain dura es pin por commit SHA (`@<sha>`). Un tag major puede moverse dentro de su rango minor/patch; si la org actionscript fuera comprometida, el tag apuntaría a código malicioso.
- **Severidad**: BAJA (riesgo real bajo, pero es el estándar en pipelines financieros).
- **Solución**: pin por SHA + comentario con la versión.

### Observaciones positivas

| Punto | Estado |
|---|---|
| `bun install --frozen-lockfile` | ✅ Instalación reproducible — el lockfile es ley |
| Typecheck + tests como gates | ✅ Ambos fallan el CI |
| `pull_request` trigger | ✅ Los PRs no pueden merguear sin CI verde |
| Sin secrets en el workflow | ✅ Cero `secrets.*` usados — nada que exfiltrar desde el job |
| Sin `pull_request_target` | ✅ El patrón más peligroso de GH Actions no está presente |

## 2. Superficie del repositorio

| Elemento | Estado |
|---|---|
| SECURITY.md | ✅ Policy de disclosure responsable (email privado, 72h ack, sin issues públicos) |
| CONTRIBUTING.md | ✅ Presente |
| LICENSE (MIT) | ✅ |
| Issue templates (bug + feature) | ✅ |
| Branch protection / required checks | ⚠️ No verificable read-only; **recomendación**: exigir CI verde + 1 review para master |
| Default branch | master ✅ (CI cubierto tras CI-001) |
| Tags/releases | v0.1.0 ✅ · v0.1.1 pendiente (publicación npm pendiente) |
| Historial git | 3 commits limpios, sin secretos en el historial (scan de patrones en el diff de los 3 commits: solo fixtures TEST-) |

## 3. Hallazgos de FASE 6

| ID | Severidad | Título | Clasificación |
|---|---|---|---|
| **CI-002** | MEDIA | `permissions:` no declarado en ci.yml → GITHUB_TOKEN con permisos por defecto del repo (potencialmente write) | Probable |
| **CI-003** | BAJA | Actions pinnadas por tag (v4/v2), no por SHA | Confirmado |
| DOC-004 | BAJA | Paso "Test summary" con métricas hardcodeadas obsoletas (111/10) — no mide nada | Confirmado |

## 4. Conclusión de la FASE 6

El pipeline es minimalista y correcto en lo esencial (lockfile congelado, typecheck+tests como gates, triggers correctos). Las mejoras son las estándar de endurecimiento de supply chain para un proyecto financiero: token de solo lectura explícito, actions pinnadas por SHA, y (configuración del repo, no código) branch protection con checks requeridos.

**Estado**: FASE 6 completa → procediendo a FASE 7 (plan de pruebas).
