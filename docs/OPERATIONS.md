# Mercado Pago — Guía de Operaciones

> Cómo configurar, operar y diagnosticar la integración MP en DashCommerce.

## 1. Configuración inicial (admin)

1. **Acceder al admin**: `/_emdash/admin` → DashCommerce → settings de pago.
2. **Seleccionar proveedor**: `settings:paymentProvider` = `mercadopago`
   (o `stripe` para volver al proveedor anterior — conviven).
3. **Credenciales MP** (vía `admin/mercadopago/settings`):
   - `mercadopagoSecretKey`: access token. Sandbox empieza con `TEST-`,
     producción con `APP_USR-`. Validado por prefijo al guardar.
   - `mercadopagoWebhookSecret`: secret de firma de webhooks de la app MP.
     Mínimo 8 caracteres.
4. **Verificar**: GET settings devuelve `{isSet, hint}` — ej.
   `"TEST…70 chars"`. Los valores NUNCA se muestran completos.

> ⚠️ **Pre-producción obligatorio**: reemplazar el webhook secret placeholder
> por el secret real de la aplicación MP (panel MP → Tu integración →
> Webhooks). Sin él, la validación de firma usa el placeholder.

## 2. Entornos

| Modo | Detección | Comportamiento |
|---|---|---|
| Sandbox | token `TEST-` | redirect a `sandbox_init_point`; checkout en sandbox.mercadopago |
| Producción | token `APP_USR-` | redirect a `init_point`; checkout real |
| Dev (http) | back_urls no-https | `auto_return` omitido (MP lo rechaza con http); retorno vía botón |

## 3. Monitoreo

### Logs del server (prefix `[plugin:dashcommerce]`)

| Mensaje | Significado | Acción |
|---|---|---|
| `MP webhook signature invalid` | Firma rechazada | Verificar webhook secret en settings vs panel MP |
| `MP live-retrieve failed` | MP no respondió / error red | Transitorio: MP reintenta. Si persiste, verificar token |
| `MP webhook for consumed/expired draft` | Notificación de draft ya procesado | Normal (duplicado) — sin acción |
| `MP webhook for non-success status` | Pago pending/rejected | Revisar en panel MP si es inesperado |
| `MP webhook amount mismatch` | **Monto pagado ≠ draft** | INVESTIGAR: posible manipulación o preferencia obsoleta |
| `MP credentials not configured` | Falta token o secret | Configurar en admin |

### Códigos de respuesta del webhook

| Status | Significado | MP reintenta? |
|---|---|---|
| 200 | Procesado o duplicado | No |
| 400 | Firma/binding inválido | No (reenvíos idénticos fallarán igual) |
| 405 | Método no POST | No |
| 502 | Live-retrieve falló | **Sí** (correcto: estado transitorio) |
| 500 | Error interno | Sí |

## 4. Reembolsos

- Endpoint: `POST /v1/payments/{paymentId}/refunds` (PLURAL).
- Body vacío = reembolso total; `{amount: "20.99"}` = parcial (decimal string).
- El refund usa el `paymentReference` de la orden (= MP payment id).
- `X-Idempotency-Key` = refundRequestId del core (reintentos no duplican).
- Respuesta `status:"approved"` → succeeded; cualquier otra → pending
  (el core consulta luego; nunca se declara completado antes de approved).

## 5. Diagnóstico rápido

```powershell
# 1. ¿Está el provider activo?
curl http://localhost:4324/_emdash/api/plugins/dashcommerce/checkout/mode
# → {"mode":"hosted"}

# 2. ¿Credenciales seteadas? (requiere auth admin)
# GET admin/mercadopago/settings → {isSet, hint}

# 3. Webhook vivo (firma válida, id falso → 502 = pipeline OK)
bun scratch/sim-webhook.mjs 123456789012345

# 4. Suite de regresión del plugin
bun test tests/

# 5. Typecheck
bun run typecheck
```

## 6. Estados de orden y su significado

| Estado interno | Origen MP | Acción operativa |
|---|---|---|
| paid | payment approved | Enviar/fulfill |
| pending | in_process, authorized, in_mediation… | Esperar webhook de transición |
| failed/canceled | rejected, cancelled | Contactar cliente si pagó |
| on-hold (integrityHold) | amount/currency mismatch del core | **Revisar manualmente** — posible fraude o bug de pricing |

## 7. Cambio de proveedor (stripe ⇄ mercadopago)

1. Cambiar `settings:paymentProvider` en el admin.
2. No requiere restart (se lee por request en `resolveProvider`).
3. Órdenes existentes mantienen su provider original — los refunds usan el
   provider correcto por orden.
4. Ambos providers permanecen registrados siempre (no se desinstala nada).
