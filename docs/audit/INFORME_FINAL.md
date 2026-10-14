# INFORME FINAL — Auditoría Integral de Seguridad, Vulnerabilidades y Calidad

> **Proyecto**: `dashcommerce-mercadopago` v0.1.1 @ commit `7dd257d` (master)
> **Alcance**: código del plugin + integración MP + artefacto npm + CI/CD + docs (read-only)
> **Fecha**: 2026-10-14 · **Metodología**: OWASP Top 10 / API Security Top 10 / ASVS 4.0.3 / STRIDE / SSDLC
> **Documentos de fase**: [00](00_INVENTARIO.md) · [01](01_ERRORES_FUNCIONALES.md) · [02](02_SEGURIDAD_CODIGO.md) · [03](03_MERCADO_PAGO.md) · [04](04_DEPENDENCIAS_CADENA_SUMINISTRO.md) · [05](05_DISTRIBUCION_PAQUETE.md) · [06](06_CICD_REPOSITORIO.md) · [07](07_PLAN_PRUEBAS.md) · [08](08_MODELO_AMENAZAS.md) · [09](09_MATRIZ_VULNERABILIDADES.md)

---

## A. Resumen ejecutivo

### Estado general

El plugin está **técnicamente sólido en su núcleo financiero**: la arquitectura de 4 capas de verificación del webhook (firma MP → binding server-side → firma interna con bodyHash → live-retrieve + reconcile del core) está correctamente implementada, documentada y probada (117 tests, 2.807 aserciones, property-based, concurrencia real con CAS fideligno, payloads adversariales verificados en vivo contra MP sandbox). Los 5 hallazgos de la auditoría externa previa están cerrados y verificados.

La auditoría encontró **14 hallazgos nuevos**, ninguno crítico, concentrados en tres áreas: **conformidad con la realidad de MP** (dominios por país, regla de omisión del manifest), **sostenibilidad del estado** (contadores sin expiración) y **afirmaciones publicadas** (claims de monedas/mercados). Ninguno compromete la confidencialidad ni permite fraude; el de mayor impacto es funcional (checkout roto fuera de Uruguay en producción).

### Número de hallazgos por severidad

| Severidad | Cantidad | IDs |
|---|---|---|
| CRÍTICA | 0 | — |
| ALTA | 1 | BUG-002 (funcional) |
| MEDIA | 4 | SEC-004, BUG-003, CI-002, DOC-001 |
| BAJA | 6 | CI-003, DOC-002…DOC-007 |
| INFORMATIVA | 3 | AUD-006, AUD-007, AUD-008 |

### Riesgos principales

1. **BUG-002**: allowlist de dominios de checkout productivos incompleta → **el checkout rompe para comercios de AR/BR/MX/CL/CO/PE** (6 de 9 mercados). Chile ni siquiera sigue el patrón asumido (`mercadopago.cl`, no `.com.cl`).
2. **SEC-004**: desvío de la spec de firma de MP (segmentos vacíos vs omitidos) → notificaciones legítimas sin `x-request-id` se rechazan → **pago aprobado sin orden** (impacto financiero operacional).
3. **BUG-003**: contadores de rate-limit sin mecanismo de expiración → crecimiento no acotado del KV (vector DoS de almacenamiento).
4. **CI-002**: GITHUB_TOKEN del CI sin permisos explícitos (potencialmente write) — eslabón de supply chain.
5. **DOC-001**: claim "17 currencies / all of LatAm" insostenible (9 monedas; solo UY productivo) — riesgo de confianza en un paquete financiero.

### Problemas que bloquean una publicación

**Ninguno bloquea la publicación del paquete en sí** (el artefacto es correcto y ejecutable), PERO la publicación en el estado actual publicaría un plugin que **no funciona en producción fuera de Uruguay** y con un claim de cobertura insostenible. Recomendación explícita: **corregir P1 (BUG-002, SEC-004, DOC-001) ANTES de `npm publish`** — es trabajo de ~1-2 horas con tests.

### Aspectos que requieren investigación adicional

- Frecuencia real de notificaciones MP sin `x-request-id` (solo medible con tráfico productivo).
- Setting real de Workflow permissions del repo GitHub (no verificable read-only).
- E2E sandbox completo (pago real → orden → thank-you) — bloqueado por reCAPTCHA manual (documentado en TEST_MATRIX §7).

## B. Estado de seguridad por dominio

| Dominio | Estado | Evidencia clave |
|---|---|---|
| **Seguridad del código** | ✅ Fuerte | 0 sinks peligrosos; fail-closed en todos los defaults; sin deps runtime; escaneo OWASP limpio (FASE 2) |
| **Seguridad del ciclo de pago** | ✅ Fuerte con 2 defectos de conformidad | Monto SIEMPRE server-side (draft); nunca se confía en body/URL; PERO BUG-002 (redirect roto no-UY) y SEC-004 (webhook legítimo rechazado) degradan el ciclo en casos reales (FASE 3) |
| **Seguridad de webhooks** | ✅ Muy fuerte | HMAC timing-safe ±5min; live-retrieve obligatorio; binding 4 capas; dedupe multi-capa; replay verificado con pago real; rate limit CAS. Gap: SEC-004 y BUG-003 |
| **Gestión de credenciales** | ✅ Fuerte | AES-GCM en reposo (SEC-003 verificado contra dist); GET solo {isSet,hint}; redactor de logs; sin secrets en artefacto (scan); sin env vars en src |
| **Dependencias** | ✅ Excelente | 0 runtime deps; lockfile sha512; sin fuentes git/http; sin install scripts (FASE 4) |
| **Cadena de suministro** | ✅ Fuerte con gaps de hardening | CI-002 (permissions) y CI-003 (pin por SHA) — mejoras estándar pendientes |
| **Publicación del paquete** | ✅ Estructuralmente correcto | dist/ compilado ejecutable en Node puro (verificado); exports map + entrypoint resolution verificados contra emdash dist; prepublishOnly gate. Gap: DOC-001 (claims) |
| **Cobertura de pruebas** | ✅ Inusualmente sólida | 117/117; property-based; concurrencia; adversarial E2E en vivo. Gaps: GAP-1/GAP-2 (exactamente donde están los 2 hallazgos principales) |

## C. Dictamen de preparación para producción

# ⚠️ APTO CONDICIONADO

**Justificación**: No existen bloqueos críticos ni vulnerabilidades que permitan fraude, falsificación de confirmaciones o exposición de credenciales. La integridad del flujo de pago (el activo crítico) está demostrada por diseño multicapa con evidencia de tests y verificación en vivo. SIN EMBARGO, el proyecto **no debe considerarse listo para producción general** hasta resolver:

- **P1-1 (BUG-002)**: sin esto, el plugin no cumple su propósito declarado fuera de Uruguay — es un defecto funcional ALTO en el mercado objetivo.
- **P1-2 (SEC-004)**: sin esto, existe una clase de notificaciones legítimas que se rechazan con impacto financiero (pago sin orden).
- **P1-3 (DOC-001)**: sin esto, la promesa publicada es falsa.

**Condiciones formales de aptitud**:
1. Corregir BUG-002 + test paramétrico por país (GAP-1).
2. Corregir SEC-004 + test de manifest sin request-id (GAP-2).
3. Corregir DOC-001 (READMEs honestos).
4. Corregir BUG-003 (limpieza de contadores) + CI-002 (permissions read) — recomendado en el mismo ciclo.
5. Suite completa verde (≥117 + tests nuevos), typecheck 0, build OK, `npm pack` limpio.

**Alcance del dictamen**: este dictamen NO es una certificación de seguridad. Cubre el código del plugin y su integración con `@dashcommerce/core@0.3.0` + `emdash@1.2.0` en la versión auditada, con verificación estática, tests locales y evidencia empírica previa contra MP sandbox. NO cubre: el despliegue del host (SITE_URL, TLS, WAF), la configuración del repo GitHub (settings), tráfico productivo real, ni PCI DSS (el plugin nunca toca datos de tarjeta — Checkout Pro hosted; una evaluación SAQ-A del comercio sigue siendo necesaria por separado).

## D. Plan de remediación

### P0 — Bloqueantes de seguridad y fraude
**Ninguno.** No se identificaron hallazgos que permitan fraude o falsificación de confirmaciones.

### P1 — Correcciones importantes antes de producción

| # | Origen | Corrección | Dependencias | Prueba de aceptación | Criterio de cierre |
|---|---|---|---|---|---|
| P1-1 | BUG-002 | Añadir hosts productivos por país a `MP_CHECKOUT_HOSTS` (12+: www/apex × AR/BR/MX/CL/CO/PE, incl. `mercadopago.cl`) + log del host rechazado | Ninguna | Test paramétrico por país (GAP-1): 7 TLDs × 2 formas → no-null | Tests verdes; `bun test` completo verde |
| P1-2 | SEC-004 | `buildManifest`: omitir segmento `request-id:` cuando requestId === "" (sign y verify comparten la función → round-trip consistente) | Ninguna | Test: firma MP sin request-id → verify ok (GAP-2) + regresión: con request-id sigue ok; suite signature completa verde | Tests verdes |
| P1-3 | DOC-001 | READMEs (EN/ES/PT): "9 currencies" con la lista real + nota de alcance de dominios hasta P1-1 | Ninguna | Revisión de texto | Los 3 READMEs consistentes con `SUPPORTED_CURRENCIES` |

### P2 — Robustez, cobertura y mantenimiento

| # | Origen | Corrección | Prueba de aceptación |
|---|---|---|---|
| P2-1 | BUG-003 | Barrido oportunista de contadores de ventanas ≤ W-2 en `webhookRateLimit` (best-effort, fuera del camino caliente) | Test de 3 ventanas → claves viejas eliminadas (GAP-3) |
| P2-2 | CI-002 | `permissions: {contents: read}` en ci.yml + verificación del setting del repo | Workflow válido; (manual) setting read-only |
| P2-3 | DOC-002…007 | Actualizar métricas (117/11), tabla de suites con `concurrency`, paths `tests/`, eliminar echo estático del CI | Docs consistentes con la suite real |
| P2-4 | GAP-4/5/6 | Tests de contrato: refund sin amount en respuesta MP; defaults de parseWebhookEvent; smoke test de createPlugin | Tests añadidos y verdes |

### P3 — Mejoras preventivas y optimizaciones

| # | Origen | Acción |
|---|---|---|
| P3-1 | CI-003 | Pin actions por commit SHA |
| P3-2 | AUD-006 | Añadir `bun audit` informativo a CI |
| P3-3 | AUD-007 | Tag `v0.1.1` + release notes al publicar |
| P3-4 | AUD-008 | Documentar en SECURITY_MODEL el riesgo residual del redactor (secrets solo se redactan si pasaron por settings.set) |
| P3-5 | — | Branch protection en GitHub (checks requeridos) — configuración del repo, no código |

## E. Limitaciones del análisis (transparencia)

1. **Read-only**: no se modificó código, no se publicó npm, no se ejecutaron operaciones financieras. Los tests ejecutados (117/117) son los existentes, con mocks — sin llamadas a MP en este ciclo.
2. **Verificación empírica previa**: las afirmaciones "verificado empíricamente" (dominios UY, comportamiento de campos MP) provienen del transcript de desarrollo del 2026-10-13 con credenciales TEST- reales — no re-ejecutadas en este ciclo.
3. **Dominios productivos no-UY**: inferidos de la doc oficial MP + patrón verificado UY; NO verificados con tokens de esos países (no disponibles).
4. **Frecuencia de x-request-id ausente**: no medible sin tráfico productivo.
5. **Settings de GitHub** (workflow permissions, branch protection): no verificables read-only desde el repo.
6. **CVSS 4.0**: vectores indicativos documentados; no se emiten scores numéricos sin la calculadora oficial — severidad cualitativa razonada.
7. **`bun audit` no ejecutado** (advisory DB requiere red); el árbol dev no se distribuye — riesgo limitado a la máquina de desarrollo/CI.

## F. Cierre

La auditoría de 12 fases se ejecutó completa en su porción read-only (FASES 0-10). El proyecto demuestra una **disciplina de ingeniería financiera inusual** para su tamaño: cada decisión de API verificada empíricamente, 4 capas de defensa en el camino del dinero, property-based money tests, y concurrencia probada con primitivas atómicas reales. Los defectos encontrados son de conformidad con la realidad de Mercado Pago (dominios, spec de firma) y de sostenibilidad operacional — todos con fix mecánico, test de regresión definido y ninguno en el camino del fraude.

**Siguiente paso**: FASE 11 (corrección controlada P1→P2) previa autorización del propietario, luego FASE 12 (reauditoría) y recién entonces `npm publish`.
