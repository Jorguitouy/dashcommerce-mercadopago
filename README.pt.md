<div align="center">

# dashcommerce-mercadopago

**Provedor de pagamentos Mercado Pago (Checkout Pro) para [DashCommerce](https://github.com/emdashCommerce/dashcommerce)**

Aceite pagamentos em toda a América Latina — Argentina, Brasil, Chile, Colômbia,
México, Peru, Uruguai e mais — diretamente na sua loja DashCommerce.
Um `bun add`. Uma linha de config. Pronto.

[![npm](https://img.shields.io/npm/v/dashcommerce-mercadopago.svg)](https://www.npmjs.com/package/dashcommerce-mercadopago)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-151%2F151-brightgreen.svg)](#testes)

[English](README.md) · [Español](README.es.md) · **Português**

</div>

---

## Por quê

O DashCommerce vem apenas com Stripe. A cobertura do Stripe na América Latina é
limitada e seu Checkout não suporta os métodos de pagamento dominantes da
região. Enquanto isso, **o Mercado Pago processa milhões de pagamentos por dia**
em toda a América Latina e é a forma padrão de pagar online na região:
cartões locais, redes de dinheiro (OXXO, Pago Fácil, Servipag), transferências
bancárias, parcelamento e a carteira Mercado Pago.

Este pacote adiciona o Mercado Pago como provedor de pagamentos first-class a
qualquer loja DashCommerce — sem modificar o core, sem forks.

## Características

- **Checkout Pro (API de Preferências)** — o checkout hosted que os clientes
  latino-americanos já conhecem e confiam.
- **9 moedas** — ARS, BRL, CLP, COP, MXN, PEN, UYU, mais USD e EUR
  para vendas cross-border. Nota: são as moedas que este pacote *sabe
  tratar*; as que a sua conta Mercado Pago pode efetivamente *cobrar*
  dependem do país da conta. Os hosts de checkout dos 7 países do
  Mercado Pago (UY, AR, BR, MX, CL, CO, PE) estão na allowlist.
- **Segurança de webhooks reforçada** — validação de assinatura
  HMAC-SHA256 com limite de drift de timestamp, rate limiting por IP
  (30 req/min), proteção anti-replay via deduplicação de eventos, e
  defaults fail-closed.
- **Reembolsos race-safe** — locks atômicos em KV (CAS a nível de banco de
  dados) previnem reembolsos duplicados concorrentes; comprovado por testes
  de concorrência dedicados.
- **Segurança monetária** — aritmética inteira exclusivamente em minor units.
  Nenhum float nunca toca um preço. Testado com property-based tests.
- **Expiração alinhada** — as preferências de pagamento expiram junto com o
  draft do pedido (15 min + 5 min de graça para o webhook), então o dinheiro
  nunca fica preso numa aba velha do checkout.
- **Gates de capabilities fail-closed** — cupons e assinaturas são rejeitados
  de forma limpa (409) em vez de cobrados errado em silêncio. O Stripe continua
  disponível em paralelo; trocar de provedor é um toggle de settings.
- **Integração admin completa** — configure credenciais e webhook secret pelo
  painel admin do DashCommerce. Os segredos são mascarados, nunca retornados
  em claro.

## Requisitos

| | |
|---|---|
| DashCommerce | `@dashcommerce/core@^0.3.0` |
| EmDash CMS | `emdash@^1.2.0` |
| Runtime | Node 20+, ou Bun 1.2+ |
| Conta Mercado Pago | [Crie uma grátis](https://www.mercadopago.com/developers/panel/app) |

## Instalação

```sh
bun add dashcommerce-mercadopago
# ou: npm install dashcommerce-mercadopago
```

## Configuração

**1. Registre o plugin** no `astro.config.mjs` — substitua `dashcommerce()`
por `dashcommerceWithMercadoPago()`:

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

**2. Crie uma aplicação Mercado Pago** em
[developers.mercadopago.com](https://www.mercadopago.com/developers/panel/app)
e pegue o **Access Token** (produção: `APP_USR-…`, sandbox: `TEST-…`).

**3. Configure as credenciais** no admin do DashCommerce →
**Settings → Payment Provider → Mercado Pago**:

| Campo | Valor |
|---|---|
| Access token | `APP_USR-…` (ou `TEST-…` para sandbox) |
| Webhook secret | Uma string aleatória, mín. 8 caracteres — coloque o mesmo valor na configuração de webhook da sua aplicação MP |

**4. Aponte o webhook da sua aplicação MP** para:

```
https://SEU-DOMINIO/_emdash/api/plugins/dashcommerce/checkout/webhook-mercadopago
```

**5. Troque o provedor de pagamentos** no admin do DashCommerce →
**Settings → paymentProvider** → `mercadopago`. O Stripe fica configurado e
pode ser reativado a qualquer momento.

### Testando em sandbox

Use credenciais de teste MP (token `TEST-…`) e os
[usuários de teste](https://www.mercadopago.com/developers/panel/test-cards)
que o Mercado Pago fornece. O plugin se comporta de forma idêntica em sandbox
e produção — só as credenciais mudam.

## Testes

151 testes. Tolerância zero a bugs de dinheiro.

```sh
bun test tests/
```

| Suite | Cobre |
|---|---|
| money | Matemática inteira em minor units, arredondamento, round-trips |
| money-properties | Property-based: valores aleatórios nunca perdem um centavo |
| provider | Capability gates, allowlist de moedas, mapeamento de estados |
| security | Sem vazamento de segredos, respostas admin mascaradas, allowlist de hosts de checkout por país |
| signature | Construção de manifest HMAC + verificação round-trip, regra de omissão do MP |
| webhook | Pipeline completo de notificações, limites de drift, anti-replay |
| webhook-defensive | Payloads malformados, headers faltando, erros internos |
| refund-dedup | Corrida de reembolsos concorrentes, roubo de locks, ownership |
| concurrency | Reembolsos/dedup em paralelo real sob CAS com KV estilo fidelign |
| admin-settings | Validação de credenciais, masking, delete flag |
| rate-limit-stress | Janelas de 30 req/min/IP sob carga |

## Arquitetura

```
Sua app DashCommerce
└── dashcommerce-mercadopago          ← este pacote
    ├── src/index.ts                  factory do descriptor (astro.config)
    ├── src/entry.ts                  entrypoint do plugin (wrapper runtime)
    ├── src/provider.ts               PaymentProvider: sessões, reembolsos,
    │                                 mapeamento de estados, capability gates
    ├── src/webhook.ts                pipeline de processamento de notificações
    ├── src/routes.ts                 rota webhook + rotas admin de settings
    ├── src/signature.ts              manifest HMAC-SHA256 + verificação
    ├── src/money.ts                  matemática de moeda só-inteira
    └── src/types.ts                  tipos compartilhados

Dependências: @dashcommerce/core (peer), emdash (peer)
Modificações ao core/emdash necessárias: NENHUMA
```

O pacote é um **wrapper**: re-exporta o descriptor do plugin DashCommerce do
core com o provedor Mercado Pago injetado. Mesmo id de plugin, mesmo storage,
mesma UI admin — Stripe e Mercado Pago coexistem, e trocar é um toggle de
settings.

## Segurança

- Webhooks são rejeitados a menos que o header `x-signature` verifique contra
  seu secret com drift de timestamp ≤5 min.
- Rate limit por IP (30 req/min). Replays retornam `{"duplicate":true}` e
  nunca são reprocessados.
- Valor e moeda são revalidados server-side em cada notificação — uma
  preferência adulterada não pode cobrar a mais nem a menos.
- Estados de pagamento desconhecidos **nunca** são tratados como sucesso.
- Reembolsos pegam um lock KV atômico por referência de pagamento (CAS a
  nível de banco de dados); clique duplo concorrente não pode duplicar o
  reembolso, e um request lento jamais apaga um lock que já não é seu.
  Comprovado por tests/concurrency.test.ts (dois reembolsos simultâneos
  → exatamente um chega ao Mercado Pago).
- Credenciais são armazenadas criptografadas, mascaradas em respostas admin
  (`••••`), e nunca logadas.

Reporte vulnerabilidades na [política de segurança](SECURITY.md).

## Licença

MIT © Jorge Ferreira

---

<div align="center">

**Feito no Uruguai 🇺🇾 para toda a América Latina**

</div>
