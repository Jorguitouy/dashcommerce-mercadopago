# FASE 9 — Matriz de Hallazgos y Priorización

> **Auditoría integral** — `dashcommerce-mercadopago` @ `7dd257d`
> Fase: **SOLO LECTURA** · Consolidación de los hallazgos de FASES 0-8
> Severidades: CRÍTICA / ALTA / MEDIA / BAJA / INFORMATIVA · Clasificación: Confirmado / Probable / Potencial / No aplicable

---

## 1. Matriz consolidada

| ID | Título | Categoría | Severidad | Estado | Archivo | CWE/OWASP |
|---|---|---|---|---|---|---|
| **BUG-002** | Allowlist de hosts de checkout de producción incompleta — solo Uruguay funciona; 6 de 9 mercados soportados rompen en producción (AR/BR/MX/CL/CO/PE; Chile usa `mercadopago.cl`, ni siquiera el patrón `.com.cl` asumido) | Error funcional | **ALTA** | Confirmado (doc oficial MP + verificación empírica UY en vivo) | [src/provider.ts:90-108](file:///c:/Users/servi/Desktop/servicedecalefones/dashcommerce-mercadopago/src/provider.ts#L90-L108) `MP_CHECKOUT_HOSTS` | CWE-693 (protection mechanism failure — allowlist incompleta) |
| **SEC-004** | Manifest de firma de webhook: segmentos con valor vacío en vez de OMITIDOS cuando falta `x-request-id` — desvío de la spec oficial de MP → notificaciones legítimas rechazadas → pago aprobado sin orden (fail-closed excesivo con impacto financiero operacional) | Seguridad (integridad operacional) | **MEDIA** | Probable (desvío de spec confirmado; frecuencia del header ausente no medible sin tráfico productivo) | [src/signature.ts:58-74](file:///c:/Users/servi/Desktop/servicedecalefones/dashcommerce-mercadopago/src/signature.ts#L58-L74) `buildManifest` + [src/webhook.ts:115](file:///c:/Users/servi/Desktop/servicedecalefones/dashcommerce-mercadopago/src/webhook.ts#L115) | CWE-841 (improper behavior); OWASP A08 (integridad de datos) |
| **BUG-003** | Contadores de rate-limit (`state:mpWebhookRate:<ip>:<window>`) nunca se eliminan — el KV de emdash no tiene TTL; el comentario "self-expire by window rotation" es incorrecto → crecimiento no acotado de la tabla options (vector DoS de almacenamiento con IPs spoofeadas vía x-forwarded-for) | Error funcional / DoS de disponibilidad | **MEDIA** | Confirmado (código + dist emdash `createKVAccess` sin TTL verificado) | [src/routes.ts:104-150](file:///c:/Users/servi/Desktop/servicedecalefones/dashcommerce-mercadopago/src/routes.ts#L104-L150) `webhookRateLimit` | CWE-770 (allocated resource without limit); OWASP API4 |
| **CI-002** | `permissions:` no declarado en ci.yml → GITHUB_TOKEN con los permisos por defecto del repo (potencialmente write) — eslabón de supply chain si el árbol dev (548 paquetes) es comprometido durante `bun install` | Seguridad CI/CD | **MEDIA** | Probable (depende del setting del repo, no verificable read-only) | [.github/workflows/ci.yml](file:///c:/Users/servi/Desktop/servicedecalefones/dashcommerce-mercadopago/.github/workflows/ci.yml) | CWE-250 (execution with unnecessary privileges) |
| **DOC-001** | Claim "17 currencies — ARS, BRL, CLP, COP, MXN, PEN, UYU, BOB, PYG, plus USD/EUR" en 3 READMEs vs `SUPPORTED_CURRENCIES` = 9 (sin BOB/PYG); combinado con BUG-002, el claim "Accept payments across all of Latin America" es funcionalmente falso en producción | Calidad / riesgo de confianza | **MEDIA** | Confirmado | README.md:37 + README.es.md + README.pt.md | — |
| **CI-003** | Actions pinnadas por tag major (v4/v2), no por commit SHA | Seguridad CI/CD | **BAJA** | Confirmado | ci.yml:12,15 | CWE-1357 |
| **DOC-002** | README tabla Testing: 10 suites listadas (falta `concurrency`) | Calidad | **BAJA** | Confirmado | README×3 | — |
| **DOC-003** | SKILL.md: "111 tests" (real: 117) | Calidad | **BAJA** | Confirmado | skills/.../SKILL.md:126 | — |
| **DOC-004** | ci.yml paso "Test summary": `echo "Tests: 111 expected across 10 files"` — métrica hardcodeada obsoleta que no mide nada | Calidad CI | **BAJA** | Confirmado | ci.yml:28-30 | — |
| **DOC-005** | TEST_MATRIX.md: "75/75 PASS, bun test tests/mercadopago/" (real: 117/11, `bun test tests/`) | Calidad | **BAJA** | Confirmado | docs/TEST_MATRIX.md:4 | — |
| **DOC-006** | OPERATIONS.md: `bun test tests/mercadopago/` (path obsoleto) | Calidad | **BAJA** | Confirmado | docs/OPERATIONS.md:76 | — |
| **DOC-007** | ARCHITECTURE.md §8: "75/75", árbol `tests/mercadopago/` obsoleto | Calidad | **BAJA** | Confirmado | docs/ARCHITECTURE.md §8 | — |
| **AUD-006** | Sin gate de auditoría de vulnerabilidades del árbol dev en CI (`bun audit`) | Mejora preventiva | **INFORMATIVA** | Confirmado (ausencia) | ci.yml | — |
| **AUD-007** | v0.1.1 sin git tag (publicación npm pendiente) | Operativa | **INFORMATIVA** | Confirmado | git tags | — |
| **AUD-008** | Redactor de logs de emdash solo conoce secrets que pasaron por `settings.set` del plugin — un token escrito directamente en DB no se redactaría | Riesgo residual de plataforma | **INFORMATIVA** | Confirmado (dist emdash secret-redactor.mjs) | (emdash, fuera de alcance del plugin) | — |

**Nota sobre hallazgos del ciclo previo**: SEC-001, SEC-002, SEC-003, BUG-001, CI-001 de la auditoría externa anterior están **CORREGIDOS Y VERIFICADOS** en el código auditado (evidencia: tests/concurrency.test.ts, dist/ compilado, ci.yml branches) — se listan en el informe final como cerrados, no se duplican en esta matriz.

## 2. Detalle de los hallazgos de severidad ≥ MEDIA

### BUG-002 — Detalle completo
- **Evidencia**: doc oficial MP Checkout Pro — "The TLD of the init_point will automatically match the marketplace country of the Access Token owner": AR→`mercadopago.com.ar`, BR→`.com.br`, MX→`.com.mx`, CO→`.com.co`, PE→`.com.pe`, CL→**`mercadopago.cl`**, UY→`.com.uy`. Allowlist actual: solo UY + genéricos + sandbox. Verificación empírica previa con token UY: `init_point = https://www.mercadopago.com.uy/checkout/v1/redirect?pref_id=…`.
- **Escenario de explotación/fallo**: comercio argentino/brasilero/etc. configura token `APP_USR-` → checkout pasa `supportsCurrency` (ARS/BRL/MXN… están soportadas) → MP devuelve `init_point` en su dominio nacional → `validateCheckoutUrl` → null → `initCheckout` lanza error genérico → **checkout roto**. No es ataque: es el caso de uso principal del plugin fallando.
- **Requisitos previos**: token de producción no-UY.
- **Impacto técnico y comercial**: el plugin no cumple su promesa central (LATAM); error genérico dificulta el diagnóstico; daño reputacional para un paquete financiero.
- **Probabilidad**: ALTA (cualquier comercio no-UY en producción).
- **Reproducción segura**: unit test — `validateCheckoutUrl("https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=1")` → null (hoy) — sin tocar MP.
- **Solución**: añadir los 12+ hosts productivos (www. y apex por país, incl. `mercadopago.cl`) + tests paramétricos por país.
- **Prueba de verificación**: GAP-1 (FASE 7).
- **Riesgo residual**: MP podría cambiar dominios en el futuro → mitigar con log del host rechazado (sin datos sensibles).

### SEC-004 — Detalle completo
- **Evidencia**: spec oficial MP (webhook signature): "If any of these fields (data.id or x-request-id) are missing from the incoming request, omit that entire segment completely rather than leaving it blank". Código: `buildManifest` SIEMPRE emite `request-id:${params.requestId};` aunque `requestId === ""`.
- **Escenario**: MP envía notificación legítima sin `x-request-id` → manifest MP: `id:123;ts:…;` vs manifest local: `id:123;request-id:;ts:…;` → HMAC distinto → 400 "Invalid signature" → la orden no se crea aunque el pago fue aprobado → dinero cobrado sin orden (reconciliación manual). MP reintenta, pero si el header falta consistentemente en ese tipo de notificación, ningún reintento pasa.
- **Requisitos previos**: que MP omita el header en alguna notificación real (la regla existe en la doc porque el caso ocurre).
- **Probabilidad**: MEDIA (fallo fail-closed; no explotable para fraude — al revés, demasiado estricto).
- **Impacto**: financiero operacional (órdenes perdidas), soporte, confianza.
- **CVSS 4.0 (aproximación documentada)**: vector indicativo `AV:N/AC:L/AT:P/PR:N/UI:N/VC:N/VI:N/VA:H` — la dimensión afectada es disponibilidad del proceso de órdenes (VA) con prerequisites de timing (AT:P: requiere que MP omita el header). **No se fuerza un score numérico sin la calculadora oficial; se documenta el vector y el razonamiento.**
- **Reproducción segura**: unit test — firmar `id:123;ts:…;` (sin request-id) con el secret; verificar con `verifyMercadoPagoSignature({requestId: ""})` → hoy `{ok:false}`; tras el fix `{ok:true}`.
- **Solución**: omitir el segmento `request-id:` cuando requestId esté vacío, en `buildManifest` (afecta igualmente al canal interno: sign y verify usan la misma función → round-trip consistente).
- **Prueba de verificación**: GAP-2 + regresión completa (requestId presente sigue funcionando).
- **Riesgo residual**: si MP variara el orden de segmentos o añadiese segmentos nuevos, el manifest fijo fallaría — mitigar con log del reason (ya existe, sin secret).

### BUG-003 — Detalle completo
- **Evidencia**: `createKVAccess` (emdash dist, context-CvhgHgSH.mjs) — `set()` escribe sin TTL; no existe API de expiración en el KV de plugins. El core barre SOLO `lock:` (cron `sweepExpiredLocks`); nadie barre `state:mpWebhookRate:*`.
- **Escenario**: atacante bombardea el webhook con `x-forwarded-for` aleatorios (válido tras proxy sin `cf-connecting-ip`) → cada IP×ventana (60s) crea una clave permanente → tras días: millones de filas en options → SQLite degrada (archivo único) → DoS de disponibilidad de TODA la app (el KV es compartido).
- **Requisitos previos**: despliegue tras proxy sin cf-connecting-ip, o botnet con muchas IPs reales.
- **Probabilidad**: MEDIA (requiere ataque sostenido; el vector es trivial de ejecutar).
- **CVSS 4.0 (aproximación documentada)**: `AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:L` — degradación gradual de disponibilidad (VA:L: requiere acumulación). Vector documentado, score numérico no forzado.
- **Reproducción segura**: unit test con FakeKV — 3 ventanas × N IPs → contar claves tras rotación (hoy: crecen sin límite).
- **Solución**: barrido oportunista en `webhookRateLimit` — al admitir un request en la ventana W, eliminar (best-effort, sin bloquear el camino caliente) contadores de ventanas ≤ W-2 para esa IP; opcionalmente un sweep por prefijo con `kv.list()` acotado.
- **Prueba de verificación**: GAP-3.
- **Riesgo residual**: el barrido por IP no acota el TOTAL de IPs activas recientes (espacio = IPs activas × ~3 ventanas) — aceptable y documentable.

### CI-002 — Detalle completo
- **Evidencia**: ci.yml sin bloque `permissions:` → token con default del repo. Para repos personales con el default "Read and write", el job CI (que ejecuta `bun install` de 548 paquetes dev) obtiene un token con write.
- **Escenario**: dependencia dev maliciosa ejecuta código en el job → usa el token para pushear commits/tags al repo → compromete la cadena de publicación.
- **Solución**: `permissions: { contents: read }` explícito + verificar el default en Settings.
- **Prueba de verificación**: inspección del workflow tras el cambio + (manual) Settings → Actions → Workflow permissions = Read-only.
- **Riesgo residual**: nulo tras el fix (el CI no necesita write).

### DOC-001 — Detalle completo
- **Evidencia**: `SUPPORTED_CURRENCIES` (provider.ts:111-113) = {UYU, ARS, BRL, CLP, COP, MXN, PEN, USD, EUR} = 9. README×3 dice "17 currencies" y lista BOB/PYG (no soportadas).
- **Impacto**: un comercio BOB/PYG instala el paquete → checkout falla con "Currency not supported by payment provider" — sobrepromesa con costo de soporte y confianza.
- **Solución**: corregir los 3 READMEs a 9 monedas reales (o ampliar el Set si se decide soportarlas — decisión de producto; el fix de docs es lo honesto hoy).
- **Riesgo residual**: ninguno tras corregir.

## 3. Conteo por severidad

| Severidad | Hallazgos |
|---|---|
| CRÍTICA | 0 |
| ALTA | 1 (BUG-002 — funcional) |
| MEDIA | 4 (SEC-004, BUG-003, CI-002, DOC-001) |
| BAJA | 6 (CI-003, DOC-002…007) |
| INFORMATIVA | 3 (AUD-006, AUD-007, AUD-008) |

## 4. Plan de remediación priorizado (input a FASE 10 §D)

- **P1 (antes de producción)**: BUG-002, SEC-004, DOC-001
- **P2 (robustez/operación)**: BUG-003, CI-002, DOC-002…007
- **P3 (preventivas)**: CI-003, AUD-006, AUD-007 (tag al publicar), AUD-008 (documentar en SECURITY_MODEL)

**Estado**: FASE 9 completa → procediendo a FASE 10 (informe ejecutivo y dictamen).
