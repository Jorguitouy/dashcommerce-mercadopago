# FASE 8 — Modelo de Amenazas (STRIDE) con 10 Escenarios

> **Auditoría integral** — `dashcommerce-mercadopago` @ `7dd257d`
> Fase: **SOLO LECTURA** · Foco: STRIDE sobre el flujo de dinero + 10 escenarios de ataque específicos

---

## 1. Modelo STRIDE del sistema

| Componente | Spoofing | Tampering | Repudiation | Info Disclosure | DoS | Elevation of Privilege |
|---|---|---|---|---|---|---|
| **Webhook público** | Firma HMAC x-signature (timing-safe) — MP autenticado por conocimiento del secret | Live-retrieve SIEMPRE desde MP; body nunca confiado; binding 4 capas | Logs estructurados con paymentId en cada rechazo | 500 genéricos; reason strings sin secretos; sin stack traces | Rate limit 30/min/IP (CAS) — pero ver BUG-003 | Ruta solo crea órdenes tras firma+binding; sin funciones admin |
| **Reinyección interna** | HMAC interno con bodyHash SHA-256 del body completo | Cualquier byte alterado rompe la firma (test tampering) | — | — | — | La ruta core es pública pero exige la misma firma interna |
| **Checkout (create-session)** | — | Total SIEMPRE del draft server-side; body cliente sin montos | — | init_point validado contra allowlist (no open redirect) | — | Capability gates 409 (coupons/subscriptions/connect) |
| **Admin settings** | Auth emdash (401 sin sesión verificado) | Prefijos TEST-/APP_USR- validados; keys desconocidas 400 | — | GET solo {isSet,hint}; valores jamás devueltos; AES-GCM en reposo | — | Solo 2 keys aceptadas; DELETE explícito |
| **Refunds** | Solo desde admin autenticado del core | Lock CAS per payment; X-Idempotency-Key | Logs MP + refund store del core | — | Lock 30s stale + steal race-free | Ruta admin del core (auth) |
| **KV/DB** | — | CAS emdash (INSERT ON CONFLICT / UPDATE WHERE rev) | Revisions auditables | Settings cifrados; secretos redactados en logs | ⚠️ BUG-003: contadores sin TTL → crecimiento no acotado | Prefijo plugin: aislado por emdash |

## 2. Los 10 escenarios de ataque (análisis detallado)

### Escenario 1 — Atacante envía webhook forjado con firma inválida
**Resultado**: 400 en el check de firma (signature.ts:131-184), ANTES de cualquier live-retrieve (0 fetch calls — test verificado). El rate limit (30/min/IP) absorbe el flood de CPU. **Bloqueado.** ✅

### Escenario 2 — Atacante roba el webhook secret y envía webhooks firmados válidos
**Resultado**: la firma pasa, PERO: (a) live-retrieve: el paymentId debe existir en la cuenta MP del comercio; (b) binding: external_reference debe matchear un draft vivo con amount/currency exactos; (c) dedupe por `${paymentId}:${status}`; (d) el core re-retrievea y reconcilea. Para crear una orden fraudulenta el atacante necesitaría además un pago REAL aprobado en la cuenta del comercio con amount exacto del draft — es decir, pagar de verdad. **El robo del secret solo no basta** (así fue diseñado: 4 capas). Rotación del secret = reconfigurar settings. **Mitigado por diseño.** ✅
**Nota**: con secret robado el atacante SÍ puede quemar rate-limit/live-retrieves (coste API MP) — acotado a 30/min/IP y las capas siguen validando.

### Escenario 3 — Replay de un webhook legítimo capturado
**Resultado**: (a) ventana ±5min del ts; (b) draft consumido → 200 duplicate; (c) dedupe recordStripeEvent; (d) findOrderByPaymentIntent. Verificado E2E con replay 10x y con pago REAL 3x (TEST_MATRIX §6.17). **Bloqueado.** ✅

### Escenario 4 — Atacante manipula el monto en el body del webhook
**Resultado**: el body del webhook MP solo contiene `data.id` — no hay montos que manipular. El monto viene SIEMPRE del live-retrieve contra MP y se compara con el draft (minor units exactos). Un "amount" alterado en la reinyección rompe el bodyHash (capa 2) y el live-retrieve del core (capa 3) lo sobrescribe igual. **Bloqueado.** ✅

### Escenario 5 — Pago de otro comercio inyectado (cross-merchant)
**Resultado**: external_reference del payment debe ser el orderDraftId de un draft VIVO en el KV de ESTA tienda. Un pago de otra cuenta MP tiene ext_ref ajeno o vacío → 400 "Payment missing external_reference" o draft no encontrado → 200 duplicate (fail-closed sin orden). **Bloqueado.** ✅ (verificado con pago REAL de la tienda en TEST_MATRIX §6.16 — 0 órdenes creadas para estado no-aprobado)

### Escenario 6 — Doble reembolso por doble-click admin o reintento concurrente
**Resultado**: lock CAS atómico per paymentReference — exactamente 1 refund llega a MP (test: 2 simultáneos → 1 MP call); steal de stale race-free; release por revisión. Backstops: check `remaining` del core (secuencial) y rechazo de MP por monto excedido. **Bloqueado.** ✅

### Escenario 7 — Atacante agota recursos (DoS) del webhook
**Resultado**: 30 req/min/IP con contador CAS; firma inválida se rechaza antes del live-retrieve (barata). PERO: **BUG-003** — los contadores nunca se borran → un atacante con IPs spoofeadas (tras proxy sin cf-connecting-ip) o botnet crea claves KV ilimitadas → degradación de storage a largo plazo. **Parcialmente bloqueado** ⚠️ — el límite de tasa funciona, la retención de estado es el defecto. Recomendación adicional ya en SECURITY_MODEL §4.3: rate limit de borde (WAF/CDN) como capa exterior.

### Escenario 8 — Atacante explota open redirect vía init_point
**Resultado**: `validateCheckoutUrl` exige https + allowlist de hosts MP + sin credenciales embebidas (14 tests: evil.com, sufijos .evil.com, javascript:, data:, user:pass@). Un MP compromiso que devolviera un host malicioso es el único bypass teórico — la allowlist lo bloquea. **Bloqueado.** ✅

### Escenario 9 — Compromiso de la DB (lectura del KV en reposo)
**Resultado**: settings cifrados AES-GCM (EMDASH_ENCRYPTION_KEY) — el lector de DB ve ciphertext. Los drafts (carritos) y contadores son datos no sensibles. **Mitigado** (depende de la clave del host; fuera del alcance del plugin). ✅
**Nota**: si el atacante tiene la EMDASH_ENCRYPTION_KEY + DB, tiene el token MP — rotación de credenciales MP requerida (documentar en OPERATIONS como runbook de incidente).

### Escenario 10 — Atacante con acceso a la red interna altera la reinyección
**Resultado**: la firma interna cubre el body completo (bodyHash SHA-256) — cualquier byte alterado falla la verificación del core. Antes del fix H-1 solo id/request-id/ts estaban cubiertos; ahora el body entero. **Bloqueado.** ✅ (test tampering)

## 3. Escenarios adicionales identificados por el auditor (más allá de los 10)

| # | Escenario | Análisis |
|---|---|---|
| 11 | **Notificación MP legítima SIN x-request-id** | **SEC-004**: el manifest del código incluye `request-id:;` vacío; MP firmó sin el segmento → webhook legítimo rechazado → pago aprobado sin orden (impacto financiero operacional, no fraude). Fail-closed excesivo. ⚠️ |
| 12 | **Comercio no-UY en producción** | **BUG-002**: init_point de AR/BR/MX/CL/CO/PE rechazado por allowlist → checkout roto. No es ataque, pero es el mayor riesgo funcional del paquete. ⚠️ |
| 13 | **MP envía status nuevo desconocido** | Fail-closed → failed con reason diagnóstico; nunca succeeded. El pago real quedaría sin orden → operador ve el log "unrecognized mp payment status". ✅ correcto con runbook |

## 4. Matriz de riesgo residual

| Riesgo residual | Severidad | Dueño |
|---|---|---|
| Contadores rate-limit sin expiración (BUG-003) | MEDIA | Plugin (fix mecánico) |
| Webhook sin x-request-id rechazado (SEC-004) | MEDIA | Plugin (fix mecánico) |
| Allowlist productiva incompleta (BUG-002) | ALTA funcional | Plugin (fix mecánico) |
| Redactor de logs solo conoce secrets viajados por settings.set | BAJA | Plataforma (emdash) — documentado |
| Rate limit de borde (WAF) ausente | BAJA | Infraestructura del host — recomendado en docs |
| E2E sandbox real completo (pago→orden→thank-you) | INFORMATIVA | Requiere interacción manual |

## 5. Conclusión de la FASE 8

El modelo de amenazas del dinero está cerrado: los 10 escenarios clásicos están bloqueados o mitigados por diseño multicapa, con evidencia de tests y verificación en vivo. Los tres defectos reales encontrados por la auditoría (BUG-002, SEC-004, BUG-003) son de conformidad con la realidad de MP y de sostenibilidad del estado, no de diseño de seguridad — todos con fix mecánico y test de regresión definido.

**Estado**: FASE 8 completa → procediendo a FASE 9 (matriz de vulnerabilidades).
