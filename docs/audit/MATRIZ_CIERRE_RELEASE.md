# Matriz de Cierre — Release 0.1.2 (post auditoría final de hardening)

> Generada: 2026-10-14 · Formato: Control | Riesgo | Prueba | Resultado | Evidencia | Pendiente
> Estado del árbol: cambios de la auditoría final (RES-001 + DOC-002~005) sobre `86e05da`, pendientes de commit/publish.
> Convención de resultados: ✅ CERRADO · 🟡 ACEPTADO CON LIMITACIONES (documentado) · ⛔ BLOQUEO EXTERNO · 🔵 NO VERIFICABLE (requiere acción owner)

## 1. Reembolsos e idempotencia

| Control | Riesgo | Prueba | Resultado | Evidencia | Pendiente |
|---|---|---|---|---|---|
| Lock per-payment, adquisición CAS atómica (`compareAndSet(key,null,…)`) | Doble reembolso por double-click concurrente | tests/concurrency.test.ts: 2 simultáneos → 1 llega a MP | ✅ | 155/0 suite; test verde | Ninguno |
| Stale takeover race-free (CAS sobre revision) | Dos thieves simultáneos duplican reembolso | tests/concurrency.test.ts: 2 thieves → 1 gana | ✅ | Suite verde | Ninguno |
| Release ownership-checked (`compareAndDelete` por revision) | Slow winner borra lock del nuevo dueño | tests/concurrency.test.ts: slow winner no borra lock ajeno | ✅ | Suite verde | Ninguno |
| Timeout duro 20s por llamada MP (`MP_API_TIMEOUT_MS < MP_REFUND_LOCK_STALE_MS`) | Llamada colgada sobrevive al robo del lock → doble reembolso | tests/mp-api-timeout.test.ts: hung-call aborta y libera lock; invariante; **mutación `40_000` detectada** | ✅ (nuevo — RES-001) | 4 tests nuevos; repro empírico Bun abort-listener | Ninguno |
| Crash entre envío a MP y write a KV | Reembolso aplicado sin registro local | No automatizable (transacción distribuida inexistente) | 🟡 | Backstop MP monto restante + timeout acota vuelo a 20s; SECURITY_MODEL §1.1 | Documentado; sin fix posible sin saga |
| Respuesta MP perdida tras procesar (abort tardío) | Reintento con nuevo id duplica reembolso | No automatizable contra MP real | 🟡 | Backstop MP; refund full → segundo intento rechazado por monto 0 | Documentado |

## 2. Rate limiting y concurrencia

| Control | Riesgo | Prueba | Resultado | Evidencia | Pendiente |
|---|---|---|---|---|---|
| Contador CAS loop (SEC-002) | Burst concurrente supera 30/min | tests/concurrency.test.ts: burst 60 → exactamente 30 admitidos, contador exacto | ✅ | Suite verde | Ninguno |
| Fail-open tras 8 intentos CAS | Contención extrema admite de más | Comentario de diseño + análisis | 🟡 | "cannot exceed limit by more than in-flight retry races"; documentado | Ninguno (trade-off consciente) |
| IP trust (`cf-connecting-ip` ?? XFF ?? unknown) | Spoofing tras proxy no-CF | Revisión + docs | 🟡 | Degrada a per-spoofed-IP; SECURITY_MODEL | Ninguno |
| Sweep de contadores stale (BUG-003) | Crecimiento no acotado KV (DoS storage) | tests/rate-limit-stress.test.ts + revisión kv.list vs dist emdash | ✅ | Suite verde | Ninguno |

## 3. Webhooks y firma (ciclo de pago)

| Control | Riesgo | Prueba | Resultado | Evidencia | Pendiente |
|---|---|---|---|---|---|
| Firma MP x-signature HMAC timing-safe ±5min | Webhook forjado / replay | tests/signature.test.ts (15 casos) + webhook.test.ts | ✅ | Suite verde | Ninguno |
| Manifest SEC-004 (omisión segmento vacío) | Notificaciones legítimas sin x-request-id rechazadas | tests/signature.test.ts | ✅ | Suite verde | Ninguno |
| Binding server-side (ext_ref, status, monto exacto, moneda) | Pago ajeno/monto manipulado crea orden | tests/webhook.test.ts + webhook-defensive.test.ts | ✅ | Suite verde | Ninguno |
| Firma interna con bodyHash SHA-256 | Body alterado en reinyección | Round-trip + tampering test | ✅ | Suite verde | Ninguno |
| Live-retrieve + reconcile core (capa 4) | Estado spoofed llega a orden | tests/webhook.test.ts + e2e-full-checkout.mjs | ✅ | Suite verde | Ninguno |
| Fail-closed estados desconocidos | Estado no mapeado → aprobado | tests/webhook.test.ts: unknown → failed | ✅ | Suite verde | Ninguno |
| Allowlist checkout hosts (7 mercados + sandbox + lookalikes) | Open redirect vía init_point | tests/security.test.ts (14 casos) | ✅ | Suite verde | Ninguno |

## 4. Empaquetado e instalación

| Control | Riesgo | Prueba | Resultado | Evidencia | Pendiente |
|---|---|---|---|---|---|
| `npm pack --dry-run` | Artefacto roto/incompleto | Pack local post-fix | ✅ | 49 archivos, exit 0 | Ninguno |
| Exports/subpaths + bin normalizado | Import fallido en consumidor | E2E install previo (0.1.1) + contract.test.ts | ✅ | 69 rutas descriptor OK | Re-E2E tras publish 0.1.2 (owner) |
| Descripción npm factual (DOC-004) | Sobrepromesa de cobertura | Revisión de texto | ✅ | package.json: 7 mercados + 9 monedas con nota | Ninguno |

## 5. CI/CD y cadena de suministro

| Control | Riesgo | Prueba | Resultado | Evidencia | Pendiente |
|---|---|---|---|---|---|
| Workflow ci.yml válido, actions pineadas por SHA, permissions read | Supply chain / token excesivo | Revisión YAML + ls-remote SHAs (auditoría previa, re-confirmada) | ✅ | ci.yml sin cambios | Ninguno |
| Ejecución CI en master | Sin verificación independiente post-push | `gh run view` + anotaciones API | ⛔ | **"account is locked due to a billing issue"** (run 38578464909) | **Owner: resolver billing → `gh run rerun 38578464909`** |
| Branch protection (status check `test` strict, no force-push/delete) | Push directo rompe master | API branches/master/protection | ✅ | Config activa | Opcional: `enforce_admins` + firmas |
| Token npm expuesto en chat (sesión previa) | Publicación maliciosa del paquete | N/A — acción externa | 🔵 | Token removido del .npmrc local | **Owner: revocar en npmjs.com/settings/astrodesing/tokens** |

## 6. Documentación y claims

| Control | Riesgo | Prueba | Resultado | Evidencia | Pendiente |
|---|---|---|---|---|---|
| Sin claims "bank-grade" (DOC-002) | Marketing inflado en paquete financiero | Grep repo completo (src + dist regenerado + READMEs + docs) | ✅ | 0 ocurrencias; reemplazado por controles factuales | Ninguno |
| Links relativos en docs (DOC-003) | Links rotos `file:///C:/Users/...` para terceros | Grep `file:///` en docs/**: 0 | ✅ | 19 links convertidos (incl. typos `survi`/`mercadotones`/`sservi`) | Ninguno |
| Monedas conocidas vs operables (DOC-005) | Expectativa incorrecta de cobertura | Revisión 3 READMEs | ✅ | Nota de alcance en EN/ES/PT | Ninguno |
| Informes históricos preservados | Pérdida de evidencia de auditoría | Diff: solo formato de links cambió | ✅ | 00-09 + INFORME_* intactos en contenido | Ninguno |

## 7. Verificación de calidad final

| Control | Riesgo | Prueba | Resultado | Evidencia | Pendiente |
|---|---|---|---|---|---|
| Suite completa | Regresiones | `bun test tests/` | ✅ | **155 pass / 0 fail / 2.884 aserciones / 13 archivos** | CI en GitHub (bloqueado billing) |
| Typecheck | Errores de tipos | `bunx tsc --noEmit` | ✅ | Exit 0 | Ninguno |
| Build | Artefacto dist roto | `bun run build` | ✅ | Exit 0 | Ninguno |
| Mutación controlada (FASE 7) | Tests que no detectan nada | Invertir invariante timeout (`40_000`) | ✅ | Test de invariante falla → revertido | Ninguno |

---

## Decisión de release

**APTO CONDICIONADO** — el árbol local está completo y verificado; publicación como `0.1.2` requiere del owner:

1. Resolver billing GitHub y re-ejecutar el CI (`gh run rerun 38578464909`).
2. Commit de estos cambios + tag `v0.1.2` + `npm publish` + release GitHub.
3. Revocar el token npm expuesto.

Hasta entonces, `0.1.1` (publicado) permanece funcional; los fixes de esta auditoría (RES-001, DOC-002~005) quedan pendientes de release.
