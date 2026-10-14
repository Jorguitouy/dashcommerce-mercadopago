import { describe, expect, it } from "bun:test";

import { verifyMpWebhook, signEnrichedEvent } from "../src/webhook.js";
import { mercadopagoProvider } from "../src/provider.js";
import { buildManifest } from "../src/signature.js";

const WEBHOOK_SECRET = "test-webhook-secret";
const ACCESS_TOKEN = "TEST-fake-access-token";

/** HMAC-SHA256 hex of a manifest — mirrors MP's signing algorithm. */
async function hmacHex(manifest: string, secret: string = WEBHOOK_SECRET): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(manifest));
	let hex = "";
	for (const b of new Uint8Array(sig)) hex += b.toString(16).padStart(2, "0");
	return hex;
}

/** Build a signed MP webhook Request. */
async function makeWebhookRequest(params: {
	dataId: string;
	requestId?: string;
	secret?: string;
	method?: string;
	omitSignature?: boolean;
}): Promise<Request> {
	const requestId = params.requestId ?? "req-001";
	const ts = String(Math.floor(Date.now() / 1000));
	const headers = new Headers({ "x-request-id": requestId });
	if (!params.omitSignature) {
		const manifest = buildManifest({ dataId: params.dataId, requestId, ts });
		const v1 = await hmacHex(manifest, params.secret ?? WEBHOOK_SECRET);
		headers.set("x-signature", `ts=${ts},v1=${v1}`);
	}
	return new Request(
		`https://store.example.com/_emdash/api/plugins/dashcommerce/checkout/webhook-mercadopago?data.id=${encodeURIComponent(params.dataId)}`,
		{ method: params.method ?? "POST", headers },
	);
}

/** A live-retrieved MP payment (as GET /v1/payments/{id} returns). */
function mpPayment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "12345678901",
		status: "approved",
		status_detail: "accredited",
		transaction_amount: "20.99",
		currency_id: "USD",
		external_reference: "draft-abc",
		payer: { email: "buyer@example.com" },
		...overrides,
	};
}

/** The order draft snapshot stored in KV. */
function draftSnapshot(total: { amount: number; currency: string }): Record<string, unknown> {
	return { cart: { total } };
}

/** Build a mock ctx: sandboxed http.fetch (returns the given payment), kv, log. */
function makeCtx(opts: {
	paymentResponse?: Record<string, unknown> | null | "throw";
	draft?: Record<string, unknown> | null;
}): {
	ctx: Parameters<typeof verifyMpWebhook>[0]["ctx"];
	fetchCalls: Array<{ url: string; headers: Record<string, string> }>;
} {
	const fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];
	const http = {
		fetch: async (url: string, init?: RequestInit) => {
			fetchCalls.push({
				url,
				headers: Object.fromEntries(
					Object.entries((init?.headers as Record<string, string>) ?? {}),
				),
			});
			if (opts.paymentResponse === "throw") {
				throw new Error("network down");
			}
			if (opts.paymentResponse === null) {
				// MP returns 404 with a JSON error body for unknown ids
				return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
			}
			return new Response(JSON.stringify(opts.paymentResponse ?? {}), { status: 200 });
		},
	};
	const kv = {
		get: async (key: string) => {
			if (key === "draft:draft-abc") {
				return opts.draft === undefined
					? draftSnapshot({ amount: 2099, currency: "USD" })
					: opts.draft;
			}
			return null;
		},
	};
	const log = {
		warn: () => {},
		info: () => {},
		error: () => {},
		debug: () => {},
	} as unknown as Parameters<typeof verifyMpWebhook>[0]["ctx"]["log"];
	return {
		ctx: { http, kv, log } as unknown as Parameters<typeof verifyMpWebhook>[0]["ctx"],
		fetchCalls,
	};
}

describe("verifyMpWebhook", () => {
	it("accepts an approved payment with exact amount+currency and emits charge.succeeded", async () => {
		const request = await makeWebhookRequest({ dataId: "12345678901" });
		const { ctx, fetchCalls } = makeCtx({ paymentResponse: mpPayment() });
		const result = await verifyMpWebhook({ request, ctx, webhookSecret: WEBHOOK_SECRET, accessToken: ACCESS_TOKEN });

		expect(result.kind).toBe("verified");
		if (result.kind === "verified" && result.enrichedEvent.type === "charge.succeeded") {
			expect(result.status).toBe(200);
			expect(result.enrichedEvent.orderDraftId).toBe("draft-abc");
			expect(result.enrichedEvent.providerEventId).toBe("12345678901:approved");
			expect(result.enrichedEvent.paymentReference).toBe("12345678901");
			expect(result.enrichedEvent.amount).toBe(2099);
			expect(result.enrichedEvent.currency).toBe("USD");
			expect(result.enrichedEvent.customerEmail).toBe("buyer@example.com");
		}
		// Live-retrieve must hit the MP API with the Bearer token
		expect(fetchCalls.length).toBe(1);
		expect(fetchCalls[0].url).toContain("api.mercadopago.com/v1/payments/12345678901");
		expect(fetchCalls[0].headers["Authorization"]).toBe(`Bearer ${ACCESS_TOKEN}`);
	});

	it("rejects GET with 405", async () => {
		const request = await makeWebhookRequest({ dataId: "1", method: "GET" });
		const { ctx } = makeCtx({ paymentResponse: mpPayment() });
		const result = await verifyMpWebhook({ request, ctx, webhookSecret: WEBHOOK_SECRET, accessToken: ACCESS_TOKEN });
		expect(result.kind).toBe("invalid");
		if (result.kind === "invalid") expect(result.status).toBe(405);
	});

	it("rejects a missing data.id with 400", async () => {
		const request = new Request(
			"https://store.example.com/_emdash/api/plugins/dashcommerce/checkout/webhook-mercadopago",
			{ method: "POST", headers: { "x-signature": "ts=1,v1=x" } },
		);
		const { ctx } = makeCtx({ paymentResponse: mpPayment() });
		const result = await verifyMpWebhook({ request, ctx, webhookSecret: WEBHOOK_SECRET, accessToken: ACCESS_TOKEN });
		expect(result.kind).toBe("invalid");
		if (result.kind === "invalid") expect(result.status).toBe(400);
	});

	it("rejects a missing x-signature header with 400", async () => {
		const request = await makeWebhookRequest({ dataId: "1", omitSignature: true });
		const { ctx } = makeCtx({ paymentResponse: mpPayment() });
		const result = await verifyMpWebhook({ request, ctx, webhookSecret: WEBHOOK_SECRET, accessToken: ACCESS_TOKEN });
		expect(result.kind).toBe("invalid");
		if (result.kind === "invalid") {
			expect(result.status).toBe(400);
			expect(result.body.error).toContain("Missing x-signature");
		}
	});

	it("rejects an invalid signature with 400 (before any live retrieve)", async () => {
		const request = await makeWebhookRequest({ dataId: "12345678901", secret: "wrong-secret" });
		const { ctx, fetchCalls } = makeCtx({ paymentResponse: mpPayment() });
		const result = await verifyMpWebhook({ request, ctx, webhookSecret: WEBHOOK_SECRET, accessToken: ACCESS_TOKEN });
		expect(result.kind).toBe("invalid");
		if (result.kind === "invalid") expect(result.status).toBe(400);
		// Security: no external call may happen before the signature validates
		expect(fetchCalls.length).toBe(0);
	});

	it("returns 502 when the live retrieve fails (MP will retry)", async () => {
		const request = await makeWebhookRequest({ dataId: "12345678901" });
		const { ctx } = makeCtx({ paymentResponse: "throw" });
		const result = await verifyMpWebhook({ request, ctx, webhookSecret: WEBHOOK_SECRET, accessToken: ACCESS_TOKEN });
		expect(result.kind).toBe("invalid");
		if (result.kind === "invalid") expect(result.status).toBe(502);
	});

	it("rejects a payment missing external_reference with 400", async () => {
		const request = await makeWebhookRequest({ dataId: "12345678901" });
		const { ctx } = makeCtx({ paymentResponse: mpPayment({ external_reference: undefined }) });
		const result = await verifyMpWebhook({ request, ctx, webhookSecret: WEBHOOK_SECRET, accessToken: ACCESS_TOKEN });
		expect(result.kind).toBe("invalid");
		if (result.kind === "invalid") {
			expect(result.status).toBe(400);
			expect(result.body.error).toContain("external_reference");
		}
	});

	it("answers 200 duplicate when the draft was already consumed (order created)", async () => {
		const request = await makeWebhookRequest({ dataId: "12345678901" });
		const { ctx } = makeCtx({ paymentResponse: mpPayment(), draft: null });
		const result = await verifyMpWebhook({ request, ctx, webhookSecret: WEBHOOK_SECRET, accessToken: ACCESS_TOKEN });
		expect(result.kind).toBe("duplicate");
		if (result.kind === "duplicate") {
			expect(result.status).toBe(200);
			expect(result.body.duplicate).toBe(true);
		}
	});

	it("rejects an amount mismatch with 400 (financial binding)", async () => {
		const request = await makeWebhookRequest({ dataId: "12345678901" });
		// Payment for 0.99 — draft expects 20.99
		const { ctx } = makeCtx({ paymentResponse: mpPayment({ transaction_amount: "0.99" }) });
		const result = await verifyMpWebhook({ request, ctx, webhookSecret: WEBHOOK_SECRET, accessToken: ACCESS_TOKEN });
		expect(result.kind).toBe("invalid");
		if (result.kind === "invalid") {
			expect(result.status).toBe(400);
			expect(result.body.error).toBe("Amount mismatch");
		}
	});

	it("rejects a higher-than-expected amount too (no overpay acceptance)", async () => {
		const request = await makeWebhookRequest({ dataId: "12345678901" });
		const { ctx } = makeCtx({ paymentResponse: mpPayment({ transaction_amount: "25.00" }) });
		const result = await verifyMpWebhook({ request, ctx, webhookSecret: WEBHOOK_SECRET, accessToken: ACCESS_TOKEN });
		expect(result.kind).toBe("invalid");
		if (result.kind === "invalid") expect(result.body.error).toBe("Amount mismatch");
	});

	it("rejects a currency mismatch with 400", async () => {
		const request = await makeWebhookRequest({ dataId: "12345678901" });
		const { ctx } = makeCtx({ paymentResponse: mpPayment({ currency_id: "UYU", transaction_amount: "2099.00" }) });
		const result = await verifyMpWebhook({ request, ctx, webhookSecret: WEBHOOK_SECRET, accessToken: ACCESS_TOKEN });
		expect(result.kind).toBe("invalid");
		if (result.kind === "invalid") expect(result.body.error).toBe("Currency mismatch");
	});

	it("maps a rejected payment to charge.failed (no order created)", async () => {
		const request = await makeWebhookRequest({ dataId: "12345678901" });
		const { ctx } = makeCtx({
			paymentResponse: mpPayment({ status: "rejected", status_detail: "cc_rejected_other_reason" }),
		});
		const result = await verifyMpWebhook({ request, ctx, webhookSecret: WEBHOOK_SECRET, accessToken: ACCESS_TOKEN });
		expect(result.kind).toBe("verified");
		if (result.kind === "verified") {
			expect(result.enrichedEvent.type).toBe("charge.failed");
			expect(result.enrichedEvent.reason).toContain("rejected");
		}
	});

	it("maps a pending payment to charge.failed with pending flag (stock released, MP re-notifies)", async () => {
		const request = await makeWebhookRequest({ dataId: "12345678901" });
		const { ctx } = makeCtx({ paymentResponse: mpPayment({ status: "in_process" }) });
		const result = await verifyMpWebhook({ request, ctx, webhookSecret: WEBHOOK_SECRET, accessToken: ACCESS_TOKEN });
		expect(result.kind).toBe("verified");
		if (result.kind === "verified") {
			expect(result.enrichedEvent.type).toBe("charge.failed");
			expect(result.body.pending).toBe(true);
		}
	});

	it("never creates charge.succeeded for an unknown status", async () => {
		const request = await makeWebhookRequest({ dataId: "12345678901" });
		const { ctx } = makeCtx({ paymentResponse: mpPayment({ status: "weird_new_status" }) });
		const result = await verifyMpWebhook({ request, ctx, webhookSecret: WEBHOOK_SECRET, accessToken: ACCESS_TOKEN });
		if (result.kind === "verified") {
			expect(result.enrichedEvent.type).not.toBe("charge.succeeded");
		} else {
			expect(result.kind).toBe("invalid");
		}
	});
});

describe("signEnrichedEvent → provider.verifyWebhook round-trip", () => {
	it("produces a body + signature the MP adapter's verifyWebhook accepts", async () => {
		const enriched = {
			type: "charge.succeeded" as const,
			orderDraftId: "draft-abc",
			providerId: "mercadopago",
			providerEventId: "12345678901:approved",
			paymentReference: "12345678901",
			checkoutReference: "12345678901",
			amount: 2099,
			currency: "USD",
			customerEmail: "buyer@example.com",
			customerName: null,
			dataId: "12345678901",
			requestId: "req-001",
		};
		const { body, signatureHeader } = await signEnrichedEvent(enriched, WEBHOOK_SECRET);

		// The re-injected body must NOT contain the internal-only fields
		const parsedBody = JSON.parse(body);
		expect(parsedBody.dataId).toBeUndefined();
		expect(parsedBody.requestId).toBe("req-001");
		expect(parsedBody.data.id).toBe("12345678901");

		// The adapter's verifyWebhook (used by the core pipeline) must accept it
		const verify = await mercadopagoProvider.verifyWebhook({
			rawBody: body,
			signatureHeader,
			secret: WEBHOOK_SECRET,
		});
		expect(verify.ok).toBe(true);

		// And the parsed event must be a charge.succeeded with the dedupe key
		const event = mercadopagoProvider.parseWebhookEvent(body);
		expect(event.type).toBe("charge.succeeded");
		if (event.type === "charge.succeeded") {
			expect(event.providerEventId).toBe("12345678901:approved");
			expect(event.amount).toBe(2099);
		}

		// A tampered body must fail verification
		const tampered = JSON.stringify({ ...JSON.parse(body), amount: 999999 });
		const verifyTampered = await mercadopagoProvider.verifyWebhook({
			rawBody: tampered,
			signatureHeader,
			secret: WEBHOOK_SECRET,
		});
		expect(verifyTampered.ok).toBe(false);
	});
});
