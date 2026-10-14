/**
 * Contract tests for the wrapper's public seams (audit P2-4: GAP-4/5/6).
 *
 * These pin behaviors that are currently TRUE but only implicitly exercised
 * (or not exercised at all), so a future refactor cannot silently change them:
 *
 *  - GAP-4 (refund contract): when the core does NOT pass `amount` (full
 *    refund) and MP's response omits `amount`, the adapter must return
 *    amount 0 rather than crash or fabricate a value.
 *  - GAP-5 (parseWebhookEvent defaults): the enriched-event defaults
 *    `amount ?? 0` / `currency ?? "UYU"` are contract — routes.ts always
 *    enriches, but the adapter must stay total on missing fields.
 *  - GAP-6 (createPlugin smoke): the wrapper's createPlugin must merge the
 *    2 MP routes on top of the core's, keep the core's routes intact, add
 *    api.mercadopago.com to allowedHosts, and declare the 2 MP secrets in
 *    the settings schema — the wrapper's entire reason to exist.
 */
import { describe, expect, test } from "bun:test";
import { mercadopagoProvider } from "../src/provider.js";
import { createPlugin } from "../src/entry.js";
import type { CreateRefundInput, RefundResult } from "@dashcommerce/core/payment-provider";

// ---------------------------------------------------------------------------
// Shared fakes (same shape as refund-dedup.test.ts).
// ---------------------------------------------------------------------------

class FakeKV {
	store = new Map<string, unknown>();
	async get(key: string): Promise<unknown> {
		return this.store.get(key);
	}
	async set(key: string, value: unknown): Promise<void> {
		this.store.set(key, value);
	}
	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}
}

function makeCtx(kv?: FakeKV, fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>) {
	return {
		kv,
		http: { fetch: fetchImpl ?? (async () => new Response("{}", { status: 200 })) },
		log: { info: () => {}, warn: () => {}, error: () => {} },
	} as unknown as Parameters<typeof mercadopagoProvider.refund>[0];
}

const CREDENTIALS = { secretKey: "TEST-mp-contract" } as never;

// ---------------------------------------------------------------------------
// GAP-4 — executeMpRefund contract: full refund (no input.amount) + MP
// response WITHOUT amount → result amount is 0, not a crash, not fabricated.
// ---------------------------------------------------------------------------

describe("GAP-4 — refund contract: MP response without amount (full refund)", () => {
	test("full refund (no input.amount) + MP response lacking amount → amount 0, status from MP", async () => {
		const kv = new FakeKV();
		let mpBody: unknown = {};
		const ctx = makeCtx(kv, async () => {
			return new Response(JSON.stringify(mpBody), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		const input: CreateRefundInput = {
			paymentReference: "987654321",
			refundRequestId: "refund:order-9:full",
			currency: "uyu",
			// amount deliberately omitted → adapter sends {} (full refund)
		};
		// MP returns an approved refund with NO amount field at all.
		mpBody = { id: "mp-rfd-full", status: "approved" };

		const result = await mercadopagoProvider.refund(ctx, input, CREDENTIALS);

		expect(result.status).toBe("succeeded");
		expect(result.providerRefundId).toBe("mp-rfd-full");
		expect(result.amount).toBe(0);
		expect(result.currency).toBe("UYU");
	});

	test("full refund + MP response WITH amount → amount parsed from MP (fallback path)", async () => {
		const kv = new FakeKV();
		const ctx = makeCtx(kv, async () => {
			return new Response(
				JSON.stringify({ id: "mp-rfd-amt", status: "approved", amount: "12.34" }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		const input: CreateRefundInput = {
			paymentReference: "987654322",
			refundRequestId: "refund:order-9:amt",
			currency: "uyu",
		};

		const result = await mercadopagoProvider.refund(ctx, input, CREDENTIALS);

		expect(result.amount).toBe(1234);
	});

	test("full refund request body sent to MP is {} (empty = full refund)", async () => {
		const kv = new FakeKV();
		let sentBody = "UNSET";
		const ctx = makeCtx(kv, async (_url: string, init?: RequestInit) => {
			sentBody = String(init?.body ?? "");
			return new Response(JSON.stringify({ id: "r", status: "approved" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		const input: CreateRefundInput = {
			paymentReference: "987654323",
			refundRequestId: "refund:order-9:body",
			currency: "uyu",
		};

		await mercadopagoProvider.refund(ctx, input, CREDENTIALS);

		expect(sentBody).toBe("{}");
	});
});

// ---------------------------------------------------------------------------
// GAP-5 — parseWebhookEvent defaults contract: enriched events always carry
// amount/currency from routes.ts, but the adapter must stay total: missing
// amount → 0, missing currency → "UYU" (never undefined, never a crash).
// ---------------------------------------------------------------------------

describe("GAP-5 — parseWebhookEvent defaults contract", () => {
	test("charge.succeeded without amount/currency → defaults 0 / UYU (total function)", () => {
		const event = {
			type: "charge.succeeded",
			orderDraftId: "draft-1",
			paymentReference: "pay-1",
			providerEventId: "pay-1:approved",
			// amount/currency deliberately omitted
		};
		const parsed = mercadopagoProvider.parseWebhookEvent(JSON.stringify(event));

		if (parsed.type !== "charge.succeeded") throw new Error("expected charge.succeeded");
		expect(parsed.amount).toBe(0);
		expect(parsed.currency).toBe("UYU");
		expect(parsed.orderDraftId).toBe("draft-1");
	});

	test("charge.succeeded with explicit amount/currency → passed through unchanged", () => {
		const event = {
			type: "charge.succeeded",
			orderDraftId: "draft-2",
			paymentReference: "pay-2",
			providerEventId: "pay-2:approved",
			amount: 3499,
			currency: "ARS",
			customerEmail: "buyer@example.com",
		};
		const parsed = mercadopagoProvider.parseWebhookEvent(JSON.stringify(event));

		if (parsed.type !== "charge.succeeded") throw new Error("expected charge.succeeded");
		expect(parsed.amount).toBe(3499);
		expect(parsed.currency).toBe("ARS");
		expect(parsed.customer?.email).toBe("buyer@example.com");
	});

	test("unparseable body → unhandled event (never throws)", () => {
		const parsed = mercadopagoProvider.parseWebhookEvent("not-json{{");
		expect(parsed.type).toBe("unhandled");
	});

	test("non-object JSON → unhandled event", () => {
		const parsed = mercadopagoProvider.parseWebhookEvent("42");
		expect(parsed.type).toBe("unhandled");
	});
});

// ---------------------------------------------------------------------------
// GAP-6 — createPlugin smoke: the wrapper's whole reason to exist.
// ---------------------------------------------------------------------------

describe("GAP-6 — createPlugin wrapper contract (smoke)", () => {
	test("registers the mercadopago provider in the shared registry", async () => {
		createPlugin({});
		const { getPaymentProvider } = await import("@dashcommerce/core/payment-provider");
		const provider = getPaymentProvider("mercadopago");
		expect(provider).toBeDefined();
		expect((provider as { id?: string }).id).toBe("mercadopago");
	});

	test("merges the 2 MP routes on top of the core's routes (core routes intact)", () => {
		const plugin = createPlugin({}) as unknown as {
			routes: Record<string, unknown>;
			admin: Record<string, unknown>;
			allowedHosts?: string[];
		};

		// MP wrapper routes present:
		expect(plugin.routes["checkout/webhook-mercadopago"]).toBeDefined();
		expect(plugin.routes["admin/mercadopago/settings"]).toBeDefined();

		// Core routes preserved:
		expect(plugin.routes["checkout/webhook"]).toBeDefined();
		expect(plugin.routes["checkout/create-session"]).toBeDefined();
		expect(plugin.routes["cart"]).toBeDefined();

		// MP webhook route is public + raw (wire contract):
		const mpRoute = plugin.routes["checkout/webhook-mercadopago"] as {
			public?: boolean;
			response?: string;
		};
		expect(mpRoute.public).toBe(true);
		expect(mpRoute.response).toBe("raw");

		// MP admin route is NOT public:
		const adminRoute = plugin.routes["admin/mercadopago/settings"] as { public?: boolean };
		expect(adminRoute.public).not.toBe(true);
	});

	test("adds api.mercadopago.com to allowedHosts (Stripe hosts preserved)", () => {
		const plugin = createPlugin({}) as unknown as { allowedHosts?: string[] };
		const hosts = plugin.allowedHosts ?? [];
		expect(hosts).toContain("api.mercadopago.com");
		expect(hosts).toContain("api.stripe.com");
		expect(hosts).toContain("files.stripe.com");
	});

	test("declares the 2 MP secrets in admin.settingsSchema", () => {
		const plugin = createPlugin({}) as unknown as {
			admin: { settingsSchema: Record<string, { type?: string }> };
		};
		const schema = plugin.admin.settingsSchema;
		expect(schema.mercadopagoSecretKey).toBeDefined();
		expect(schema.mercadopagoSecretKey.type).toBe("secret");
		expect(schema.mercadopagoWebhookSecret).toBeDefined();
		expect(schema.mercadopagoWebhookSecret.type).toBe("secret");
	});

	test("createPlugin is synchronous (returns plugin without await)", () => {
		const start = Date.now();
		const plugin = createPlugin({});
		expect(typeof plugin).toBe("object");
		// Synchronous contract: no meaningful elapsed time from awaiting.
		expect(Date.now() - start).toBeLessThan(1000);
	});
});
