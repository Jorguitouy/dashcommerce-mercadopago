# FASE 1 — Errores Funcionales

> **Auditoría integral** — `dashcommerce-mercadopago` @ `7dd257d`
> Fase: **SOLO LECTURA** · Metodología: análisis estático + verificación contra core/emdash dist + transcript de evidencia empírica previa

---

## 1. Alcance y método

Análisis funcional de los 8 módulos src/, contrastando cada punto de integración con `@dashcommerce/core@0.3.0` dist y `emdash@1.2.0` dist (los contratos reales que ejecuta el código publicado). Cada hallazgo cita archivo:línea, escenario y requisito previo.

## 2. Hallazgos

### BUG-002 (ALTA) — Allowlist de hosts de checkout de PRODUCCIÓN incompleta: solo Uruguay funciona

- **Archivo**: [src/provider.ts:90-108](../../src/provider.ts#L90-L108) (`MP_CHECKOUT_HOSTS`)
- **Evidencia**: la allowlist incluye `www.mercadopago.com.uy`, `mercadopago.com.uy`, `mercadopago.com`, `mercadolibre.com` para producción, y `sandbox.mercadopago.com.{uy,com,ar,br,mx,cl,co,pe}` + `meli.com` para sandbox. **No incluye** `www.mercadopago.com.ar`, `.com.br`, `.com.mx`, `.com.cl`, `.com.co`, `.com.pe` (los dominios productivos de Argentina, Brasil, México, Chile, Colombia y Perú).
- **Escenario**: un comercio argentino con token `APP_USR-` (MLA) crea una preferencia; MP responde `init_point: https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=…`; `validateCheckoutUrl` devuelve `null` → `initCheckout` lanza `"Mercado Pago returned an invalid checkout URL"` → **checkout roto para 6 de los 9 mercados soportados** en producción. El error es genérico y no diagnostica el país.
- **Requisitos previos**: token de producción `APP_USR-` de un comercio fuera de Uruguay.
- **Evidencia empírica del dominio real**: transcript de pruebas reales 2026-10-13 con credenciales UY: `sandbox_init_point = https://sandbox.mercadopago.com.uy/checkout/v1/redirect?pref_id=…` y `init_point = https://www.mercadopago.com.uy/checkout/v1/redirect?pref_id=…`. El patrón por país está confirmado; los dominios `.com.ar/.com.br/.com.mx/.com.cl/.com.co/.com.pe` productivos siguen el mismo esquema (documentación MP: checkout por país).
- **Clasificación**: Confirmado (código + patrón de dominio verificado en sandbox UY).
- **Solución propuesta**: extender `MP_CHECKOUT_HOSTS` con los 7 dominios productivos por país + `mercadolivre.com` (BR) + `www.mercadolibre.com.{ar,br,mx,cl,co,pe}` si aplica; añadir tests por país.
- **Prueba de verificación**: unit test que alimente `validateCheckoutUrl` con `init_point` de cada país productivo y espere no-null.
- **Riesgo residual**: MP podría servir `init_point` en un dominio no catalogado (p. ej. migración futura); mitigable con fail-closed + log del host rechazado para diagnóstico rápido.

### BUG-003 (MEDIA) — Contadores de rate-limit nunca se eliminan (crecimiento no acotado)

- **Archivo**: [src/routes.ts:104-150](../../src/routes.ts#L104-L150) (`webhookRateLimit`)
- **Evidencia**: el comentario dice "keys self-expire by window rotation" — **falso**: `createKVAccess` de emdash (context-CvhgHgSH.mjs, verificado) no implementa TTL en `set()`; las ventanas rotan pero las claves viejas persisten para siempre. El core sí barre sus propias claves (`sweepExpiredLocks` sobre prefijo `lock:`, cron `sweep-stock-locks`) pero no las del plugin.
- **Escenario**: atacante envía webhooks con `x-forwarded-for` spoofeado (IPs aleatorias) desde N IPs → cada IP×ventana crea una clave KV permanente → crecimiento lineal no acotado de la tabla options → degradación de la DB (SQLite en archivo único) y del rendimiento de `getByPrefix` del KV.
- **Requisitos previos**: despliegue tras proxy que NO fije `cf-connecting-ip` (el fallback x-forwarded-for es spoofeable) o atacante con botnet de IPs reales.
- **Clasificación**: Confirmado (código + dist emdash).
- **Solución propuesta**: (a) barrido oportunista: al escribir el contador de la ventana W, borrar contadores de W-2 o más antiguos para esa IP (o una muestra); o (b) un sweep por prefijo `state:mpWebhookRate:` con `kv.list()` + delete de claves con windowStart < W-2; o (c) documentar límite y usar hash de IP (reduce el espacio pero no el tiempo de retención).
- **Prueba de verificación**: test que simule 3 ventanas y verifique que las claves de ventanas pasadas se eliminan.
- **Riesgo residual**: con (a)/(b) el espacio queda acotado a ~2 ventanas × IPs activas recientes.

### BUG-004 (BAJA) — `npm pack` no incluye `skills/` ni `docs/audit/` (inconsistencia menor)

- **Archivo**: [package.json:69-76](../../package.json#L69-L76) (`files`)
- **Evidencia**: `npm pack --dry-run` (2026-10-14) incluye 37 archivos: dist/, src/, docs/ (6), READMEs, scripts/setup.mjs (auto por `bin`), CHANGELOG, LICENSE. `skills/dashcommerce-mercadopago-setup/SKILL.md` **no se publica** — el README no lo referencia como instalable, así que es aceptable; se documenta como decisión.
- **Clasificación**: Confirmado (artefacto verificado).
- **Decisión**: mantener fuera del tarball (skill para uso con agentes en el repo, no runtime). Sin acción.

### Observaciones funcionales verificadas SIN hallazgo (no-bugs)

| Punto investigado | Resultado |
|---|---|
| `toMpOffsetIso` hardcodea -03:00 | ✅ No bug: el instante representado es `Date.now()+20min` exacto; el offset es solo etiqueta ISO. MP interpreta el offset → correcto en cualquier huso del servidor. |
| Placeholder `{CHECKOUT_SESSION_ID}` en successUrl | ✅ El core lo añade (verificado sandbox-entry.js); el provider lo elimina con regex exacta `\?session_id=\{CHECKOUT_SESSION_ID\}$` — test dedicado (H-9). |
| Contrato de credenciales core↔plugin | ✅ `loadPaymentProviderCredentials` lee `settings:${providerId}SecretKey`/`...WebhookSecret` → coincide con nuestras keys. |
| Contrato de reinyección | ✅ `resolveWebhookProvider` resuelve `?provider=mercadopago` + header `x-mercadopago-signature` — exactamente lo que routes.ts envía. |
| `RefundResult.amount=0` cuando MP no devuelve amount | ✅ El core siempre pasa `input.amount` definido (verificado providerRefundWithDedup) — el fallback es solo defensivo. |
| Draft sin dirección → 500 del core | ✅ El checkout DashCommerce recoge billing/shipping antes de create-session; el 500 del core es fail-closed correcto. |
| Pending→approved: charge.failed libera stock lock, no el draft | ✅ El draft persiste 15 min; MP re-notifica approved → el webhook crea la orden. Verificado el flujo en webhook.ts:233-255 y handler del core. |
| Rate limit fail-open tras 8 intentos CAS | ✅ Documentado y razonado (cada retry relee el valor fresco; no puede exceder el límite por más de las carreras en vuelo). Aceptable. |
| `parseWebhookEvent` amount/currency defaults (`?? 0`, `?? "UYU"`) | ⚠️ Observación: los defaults solo aplican en el path enriquecido donde routes.ts SIEMPRE setea amount/currency reales (verificado webhook.ts:327-341) — el core luego sobrescribe con live-retrieve. No es bug, pero los defaults podrían ocultar un futuro refactor; nota menor. |
| `minorUnitsToDecimalNumber` → float en wire | ✅ Aceptado y documentado: MP Preferences API exige JSON number; el valor es exacto (string exacto → Number() → serialización JSON shortest round-trip). Property tests cubren round-trips. |

## 3. Discrepancias documentación vs código (se detallan en FASE 5)

| Doc | Claim | Realidad |
|---|---|---|
| README.md:37 + 3 idiomas | "17 currencies — ARS, BRL, CLP, COP, MXN, PEN, UYU, BOB, PYG, plus USD/EUR" | `SUPPORTED_CURRENCIES` = **9**: UYU ARS BRL CLP COP MXN PEN USD EUR. BOB/PYG no soportados. |
| README.md tabla Testing | 10 suites listadas | 11 archivos reales (falta `concurrency`) |
| SKILL.md:126 | "111 tests" | 117 |
| ci.yml:30 | "111 expected across 10 files" | 117/11 — y es un echo estático, no mide nada |
| TEST_MATRIX.md:4 | "bun test tests/mercadopago/ (75/75 PASS)" | Suite real: `bun test tests/` 117/11 |
| OPERATIONS.md:76 | `bun test tests/mercadopago/` | Ídem |
| ARCHITECTURE.md §8 | "75/75 PASS", árbol `tests/mercadopago/` | Ídem — estructura actual es `tests/` plana |
| SECURITY_MODEL.md §5 | "117 tests" ✅ | Correcto |
| CHANGELOG 0.1.0 | "111 tests across 10 files" | Correcto históricamente (era verdad en 0.1.0) |

## 4. Conclusión de la FASE 1

Un defecto funcional **ALTO** real (BUG-002: allowlist de producción incompleta — rompe el checkout en 6 de 9 mercados objetivo), un **MEDIO** de sostenibilidad operativa (BUG-003: contadores sin limpieza), y un conjunto de discrepancias de documentación que serán consolidadas en FASE 5. Los puntos de integración con el core/emdash están todos verificados y correctos.

**Estado**: FASE 1 completa → procediendo a FASE 2 (seguridad de código).
