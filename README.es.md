<div align="center">

# dashcommerce-mercadopago

**Proveedor de pagos Mercado Pago (Checkout Pro) para [DashCommerce](https://github.com/emdashCommerce/dashcommerce)**

Acepta pagos en toda Latinoamérica — Argentina, Brasil, Chile, Colombia,
México, Perú, Uruguay y más — directamente en tu tienda DashCommerce.
Un `bun add`. Una línea de config. Listo.

[![npm](https://img.shields.io/npm/v/dashcommerce-mercadopago.svg)](https://www.npmjs.com/package/dashcommerce-mercadopago)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-117%2F117-brightgreen.svg)](#pruebas)

[English](README.md) · **Español** · [Português](README.pt.md)

</div>

---

## Por qué

DashCommerce viene solo con Stripe. La cobertura de Stripe en Latinoamérica es
limitada y su Checkout no soporta los métodos de pago dominantes de la región.
Mientras tanto, **Mercado Pago procesa millones de pagos por día** en toda
Latinoamérica y es la forma predeterminada en que la gente paga online:
tarjetas locales, redes de efectivo (OXXO, Pago Fácil, Servipag), transferencias
bancarias, cuotas y la billetera Mercado Pago.

Este paquete agrega Mercado Pago como proveedor de pagos de primera clase a
cualquier tienda DashCommerce — sin modificar el core, sin forks.

## Características

- **Checkout Pro (API de Preferencias)** — el checkout hosted que los
  clientes de LATAM ya conocen y confían.
- **17 monedas** — ARS, BRL, CLP, COP, MXN, PEN, UYU, BOB, PYG, más USD
  y EUR para ventas cross-border.
- **Seguridad de webhooks grado bancario** — validación de firma
  HMAC-SHA256 con límite de drift de timestamp, rate limiting por IP
  (30 req/min), protección anti-replay vía deduplicación de eventos, y
  defaults fail-closed.
- **Reembolsos race-safe** — locks atómicos en KV (CAS a nivel base de
  datos) previenen dobles reembolsos concurrentes; probado con tests de
  concurrencia dedicados.
- **Seguridad monetaria** — aritmética entera exclusivamente en minor units.
  Ningún float toca un precio jamás. Testeado con property-based tests.
- **Expiración alineada** — las preferencias de pago expiran junto con el
  draft de la orden (15 min + 5 min de gracia para el webhook), así el
  dinero nunca queda atrapado en una pestaña vieja del checkout.
- **Gates de capabilities fail-closed** — cupones y suscripciones se
  rechazan limpiamente (409) en vez de cobrarse mal en silencio. Stripe
  sigue disponible en paralelo; cambiar de proveedor es un toggle de
  settings.
- **Integración admin completa** — configura credenciales y webhook secret
  desde el panel admin de DashCommerce. Los secretos se enmascaran, nunca
  se devuelven en claro.

## Requisitos

| | |
|---|---|
| DashCommerce | `@dashcommerce/core@^0.3.0` |
| EmDash CMS | `emdash@^1.2.0` |
| Runtime | Node 20+, o Bun 1.2+ |
| Cuenta Mercado Pago | [Creá una gratis](https://www.mercadopago.com/developers/panel/app) |

## Instalación

```sh
bun add dashcommerce-mercadopago
# o: npm install dashcommerce-mercadopago
```

## Configuración

**1. Registrá el plugin** en `astro.config.mjs` — reemplazá `dashcommerce()`
con `dashcommerceWithMercadoPago()`:

```ts
import { emdash } from "emdash/astro";
import { dashcommerceWithMercadoPago } from "dashcommerce-mercadopago";

export default defineConfig({
  integrations: [
    emdash({
      database: …,
      storage:  …,
      plugins: [dashcommerceWithMercadoPago()],
    }),
  ],
});
```

**2. Creá una aplicación Mercado Pago** en
[developers.mercadopago.com](https://www.mercadopago.com/developers/panel/app)
y obtené el **Access Token** (producción: `APP_USR-…`, sandbox: `TEST-…`).

**3. Configurá las credenciales** en el admin de DashCommerce →
**Settings → Payment Provider → Mercado Pago**:

| Campo | Valor |
|---|---|
| Access token | `APP_USR-…` (o `TEST-…` para sandbox) |
| Webhook secret | Un string aleatorio, mín. 8 caracteres — poné el mismo valor en la configuración de webhook de tu aplicación MP |

**4. Apuntá el webhook de tu aplicación MP** a:

```
https://TU-DOMINIO/_emdash/api/plugins/dashcommerce/checkout/webhook-mercadopago
```

**5. Cambiá el proveedor de pagos** en el admin de DashCommerce →
**Settings → paymentProvider** → `mercadopago`. Stripe queda configurado y
podés reactivarlo cuando quieras.

### Probando en sandbox

Usá credenciales de prueba MP (token `TEST-…`) y los
[usuarios de prueba](https://www.mercadopago.com/developers/panel/test-cards)
que provee Mercado Pago. El plugin se comporta idéntico en sandbox y
producción — solo cambian las credenciales.

## Pruebas

117 tests. Tolerancia cero a bugs de dinero.

```sh
bun test
```

| Suite | Cubre |
|---|---|
| money | Matemática entera en minor units, redondeo, round-trips |
| money-properties | Property-based: montos aleatorios nunca pierden un centavo |
| provider | Capability gates, allowlist de monedas, mapeo de estados |
| security | Sin fuga de secretos, respuestas admin enmascaradas |
| signature | Construcción de manifest HMAC + verificación round-trip |
| webhook | Pipeline completo de notificaciones, límites de drift, anti-replay |
| webhook-defensive | Payloads malformados, headers faltantes, errores internos |
| refund-dedup | Carrera de reembolsos concurrentes, robo de locks, ownership |
| admin-settings | Validación de credenciales, masking, delete flag |
| rate-limit-stress | Ventanas de 30 req/min/IP bajo carga |

## Arquitectura

```
Tu app DashCommerce
└── dashcommerce-mercadopago          ← este paquete
    ├── src/index.ts                  factory del descriptor (astro.config)
    ├── src/entry.ts                 entrypoint del plugin (wrapper runtime)
    ├── src/provider.ts               PaymentProvider: sesiones, reembolsos,
    │                                 mapeo de estados, capability gates
    ├── src/webhook.ts                pipeline de procesamiento de notificaciones
    ├── src/routes.ts                 ruta webhook + rutas admin de settings
    ├── src/signature.ts              manifest HMAC-SHA256 + verificación
    ├── src/money.ts                  matemática de moneda solo-entera
    └── src/types.ts                  tipos compartidos

Dependencias: @dashcommerce/core (peer), emdash (peer)
Modificaciones al core/emdash requeridas: NINGUNA
```

El paquete es un **wrapper**: re-exporta el descriptor del plugin DashCommerce
del core con el proveedor Mercado Pago inyectado. Mismo id de plugin, mismo
storage, misma UI admin — Stripe y Mercado Pago coexisten, y cambiar es un
toggle de settings.

## Seguridad

- Los webhooks se rechazan salvo que el header `x-signature` verifique contra
  tu secret con drift de timestamp ≤5 min.
- Rate limit por IP (30 req/min). Los replays devuelven `{"duplicate":true}` y
  nunca se reprocesan.
- Monto y moneda se re-validan server-side en cada notificación — una
  preferencia alterada no puede cobrar de más ni de menos.
- Estados de pago desconocidos **nunca** se tratan como éxito.
- Los reembolsos toman un lock KV atómico por referencia de pago (CAS a
  nivel base de datos); el doble clic concurrente no puede duplicar el
  reembolso, y un request lento jamás borra un lock que ya no es suyo.
  Verificado por tests/concurrency.test.ts (dos reembolsos simultáneos
  → exactamente uno llega a Mercado Pago).
- Las credenciales se guardan encriptadas, enmascaradas en respuestas admin
  (`••••`), y nunca se loguean.

Reportá vulnerabilidades en la [política de seguridad](SECURITY.md).

## Licencia

MIT © Jorge Ferreira

---

<div align="center">

**Hecho en Uruguay 🇺🇾 para toda Latinoamérica**

</div>
