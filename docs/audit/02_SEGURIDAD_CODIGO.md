# FASE 2 — Seguridad de Código (OWASP)

> **Auditoría integral** — `dashcommerce-mercadopago` @ `7dd257d`
> Fase: **SOLO LECTURA** · Metodología: OWASP Top 10 (2021), API Security Top 10 (2023), ASVS 4.0.3 (V1-V14 aplicables)

---

## 1. Metodología

Escaneo dirigido de patrones OWASP sobre los 8 módulos src/ (2.636 líneas TS), verificación de cada sink/entrada, y contraste con los controles que emdash impone en runtime (sandbox HTTP, redactor de logs, settings cifrados). Cada veredicto cita evidencia.

## 2. Resultado del escaneo de patrones

| Patrón buscado | Resultado |
|---|---|
| `eval` / `new Function` | ✅ 0 ocurrencias |
| `innerHTML` / `document.write` / sinks DOM | ✅ 0 ocurrencias (el plugin es 100% server-side; sin UI) |
| `process.env` / `import.meta.env` en src | ✅ 0 ocurrencias — secretos solo vía settings cifrados |
| `Math.random` en camino cripto/dinero | ✅ 0 ocurrencias (solo `crypto.subtle` / `crypto.getRandomValues` en emdash) |
| `console.*` en src | ✅ 0 — solo `ctx.log` (redactado por emdash) |
| Timers con string | ✅ 0 |
| `encodeURIComponent` en IDs hacia MP | ✅ provider.ts:239 (live-retrieve) y :774 (refunds) — SSRF/path-injection cerrado contra `MP_API_BASE` fijo |
| JSON.parse | ✅ 6 usos, todos en try/catch o con validación de forma; sin revivers peligrosos |

## 3. Análisis OWASP Top 10

### A01:2021 Broken Access Control — ✅ SIN hallazgos
- Rutas admin (`admin/mercadopago/settings`) declaradas sin `public: true` → emdash exige sesión admin (verificado E2E: 401 sin auth, TEST_MATRIX §6.13).
- La ruta pública webhook solo acepta notificaciones firmadas; el estado muta únicamente tras firma válida + live-retrieve + binding.
- No hay rutas que lean/escriban por userId sin verificación.

### A02:2021 Cryptographic Failures — ✅ SIN hallazgos nuevos
- HMAC-SHA256 con `crypto.subtle`, timing-safe compare (signature.ts:92-104).
- Secrets en reposo: AES-GCM por emdash (SEC-003 verificado en ciclo previo — `createSettingsAccess` → `encryptPluginSetting` para `type:"secret"`).
- Sin TLS propio (el plugin corre tras el host de la app; HTTPS es responsabilidad del despliegue).

### A03:2021 Injection — ✅ SIN hallazgos
- Sin SQL (KV API de emdash parametrizada), sin HTML render, sin shell.
- `data.id` del webhook solo se usa en `GET /v1/payments/${encodeURIComponent(id)}` contra host fijo — probado con payloads adversariales (TEST_MATRIX §6.15: 10/10 clean).

### A04:2021 Insecure Design — ⚠️ 1 hallazgo transferido
- **BUG-003** (FASE 1): contadores de rate-limit sin mecanismo de expiración → diseño de limitación con estado no acotado. Detalle en 01_ERRORES_FUNCIONALES.md.

### A05:2021 Security Misconfiguration — ✅ SIN hallazgos
- Fail-closed en todos los defaults (status desconocido → failed; URL inválida → error duro; firma ausente → 400).
- `auto_return` solo con todas las back_urls https (verificado empíricamente contra MP).

### A06:2021 Vulnerable Components — FASE 4 (dependencias)

### A07:2021 Identification & Authentication Failures — ✅ SIN hallazgos
- El plugin no gestiona sesiones; delega en emdash admin auth.

### A08:2021 Software & Data Integrity Failures — ✅ SIN hallazgos
- `verifyWebhook` interno cubre el body completo (bodyHash SHA-256) — tampering del evento reinyectado falla firma (test round-trip + tampering).
- 4 capas de verificación financiera (firma MP → binding → firma interna → live-retrieve del core + reconcile).

### A09:2021 Logging & Monitoring Failures — ✅ SIN hallazgos, 1 nota
- 8 llamadas log, todas con contexto estructurado (paymentId/dataId) y sin secretos.
- **Nota (riesgo residual)**: el redactor de emdash (`createPluginSecretRedactor`) solo redacta strings que contienen el secret **completo** y solo conoce secrets que pasaron por `settings.set` del plugin. Si el token MP se hubiera escrito directamente en DB (bypass del admin), el log no lo redactaría. En el flujo normal (admin UI → settings.set) el redactor queda correctamente poblado. Documentado como riesgo residual de la plataforma, no del plugin.

### A10:2021 SSRF — ✅ SIN hallazgos
- Todo fetch via `ctx.http.fetch` sandboxeado con allowlist de hosts (api.mercadopago.com añadido por el wrapper; verificado `createPlugin` en entry.ts:187-192).
- `validateCheckoutUrl` bloquea redirect a hosts no-MP (14 tests security.test.ts).

## 4. OWASP API Security Top 10 (2023)

| API# | Título | Veredicto |
|---|---|---|
| API1 | BOLA | ✅ Sin objetos por userId; draft lookup por id firmado+bound |
| API2 | Broken Authentication | ✅ Delegado a emdash admin (401 verificado) |
| API3 | Property-level authorization | ✅ POST settings rechaza keys desconocidas (test "Unknown key") |
| API4 | Unrestricted resource consumption | ⚠️ **BUG-003** (contadores) + nota: el live-retrieve por webhook legítimo es 1 llamada MP por notificación — acotado por rate limit 30/min/IP |
| API4 | (cont.) | El rate limiter ES el control API4; su estado no acotado es el defecto |
| API5 | BFLA | ✅ Solo admin settings; sin funciones de nivel de objeto expuestas |
| API6 | Sensitive business flows | ✅ Firma + rate limit + binding amount/currency |
| API7 | Security misconfiguration | ✅ Idem A05 |
| API8 | Lack of errors handling | ✅ try/catch con 500 genérico; sin stack en body (tests webhook-defensive) |
| API9 | Inventory management | ✅ 1 ruta pública + 1 admin, documentadas en SECURITY_MODEL |
| API10 | Unsafe consumption of APIs | ✅ Live-retrieve SIEMPRE desde MP (nunca del body); respuesta MP validada (asMpPayment) |

## 5. ASVS 4.0.3 (selección aplicable)

| ASVS | Requisito | Estado |
|---|---|---|
| V2.9 | Defensa contra credential stuffing en admin | Delegado a emdash (fuera de alcance del plugin) |
| V3.2 | Sesión no expone token | ✅ Sin sesión propia; tokens nunca serializados al browser |
| V5.2 | Sanitización de salida | ✅ Sin render HTML; JSON puro con validación de forma |
| V7.4 | Logging de eventos de seguridad | ✅ firma inválida, amount mismatch, live-retrieve fallido — todos logueados con contexto |
| V8.1 | Protección de datos en reposo | ✅ AES-GCM (SEC-003) |
| V8.3 | Datos sensibles no en logs | ✅ Verificado por tests + redactor emdash |
| V12.3 | Requerir re-autenticación para operaciones sensibles | ⚠️ Nota: emdash admin mantiene sesión; el POST de credenciales exige sesión admin activa — cumple por delegación |
| V13.2 | Validación de entrada en todos los endpoints | ✅ Method/data.id/firma/keys/binding — 400 tempranos |
| V14.4 | Seguridad del sandbox de red | ✅ ctx.http + allowlist |

## 6. Hallazgos de FASE 2

| ID | Severidad | Título | Estado |
|---|---|---|---|
| — | — | **Sin vulnerabilidades nuevas de código**. El único defecto de diseño (BUG-003) ya está catalogado en FASE 1. | ✅ |

**Conclusión**: la superficie de código del plugin es pequeña (2.636 líneas), sin dependencias runtime propias, con 4 capas de defensa en el camino del dinero y cobertura de tests exhaustiva (117). Los patrones OWASP clásicos están cerrados. La seguridad de la plataforma (auth admin, cifrado en reposo, sandbox de red) está correctamente delegada y verificada contra el dist de emdash.

**Estado**: FASE 2 completa → procediendo a FASE 3 (Mercado Pago específico).
