import { describe, expect, it } from "bun:test";

import { mercadopagoProvider } from "../src/provider.js";

describe("mercadopagoProvider.parseWebhookEvent", () => {
	it("parses an enriched charge.succeeded event", () => {
		const body = JSON.stringify({
			type: "charge.succeeded",
			orderDraftId: "14ee623815acc3f1644a77c647f46e04",
			providerEventId: "12345678901:approved",
			paymentReference: "12345678901",
			checkoutReference: "pref-abc",
			amount: 2099,
			currency: "USD",
			customerEmail: "buyer@example.com",
			customerName: "Test Buyer",
			data: { id: "12345678901" },
		});
		const event = mercadopagoProvider.parseWebhookEvent(body);
		expect(event.type).toBe("charge.succeeded");
		if (event.type === "charge.succeeded") {
			expect(event.orderDraftId).toBe("14ee623815acc3f1644a77c647f46e04");
			expect(event.providerId).toBe("mercadopago");
			// Dedupe key must be the status-suffixed providerEventId, not the bare payment id
			expect(event.providerEventId).toBe("12345678901:approved");
			expect(event.paymentReference).toBe("12345678901");
			expect(event.checkoutReference).toBe("pref-abc");
			expect(event.amount).toBe(2099);
			expect(event.currency).toBe("USD");
			expect(event.customer.email).toBe("buyer@example.com");
			expect(event.customer.name).toBe("Test Buyer");
		}
	});

	it("falls back to paymentReference as providerEventId when missing", () => {
		const body = JSON.stringify({
			type: "charge.succeeded",
			orderDraftId: "draft-1",
			paymentReference: "pay-1",
			amount: 1000,
			currency: "UYU",
		});
		const event = mercadopagoProvider.parseWebhookEvent(body);
		expect(event.type).toBe("charge.succeeded");
		if (event.type === "charge.succeeded") {
			expect(event.providerEventId).toBe("pay-1");
		}
	});

	it("parses an enriched charge.failed event", () => {
		const body = JSON.stringify({
			type: "charge.failed",
			orderDraftId: "draft-2",
			providerEventId: "99:rejected",
			paymentReference: "99",
			reason: "mp status rejected (cc_rejected_other_reason)",
		});
		const event = mercadopagoProvider.parseWebhookEvent(body);
		expect(event.type).toBe("charge.failed");
		if (event.type === "charge.failed") {
			expect(event.orderDraftId).toBe("draft-2");
			expect(event.providerEventId).toBe("99:rejected");
			expect(event.paymentReference).toBe("99");
			expect(event.reason).toBe("mp status rejected (cc_rejected_other_reason)");
		}
	});

	it("returns unhandled for unknown event types", () => {
		const body = JSON.stringify({ type: "topic.heartbeat", data: { id: "1" } });
		const event = mercadopagoProvider.parseWebhookEvent(body);
		expect(event.type).toBe("unhandled");
		if (event.type === "unhandled") {
			expect(event.providerEventType).toBe("topic.heartbeat");
			expect(event.providerEventId).toBe("1");
		}
	});

	it("returns unhandled for unparseable JSON", () => {
		const event = mercadopagoProvider.parseWebhookEvent("not json {{{");
		expect(event.type).toBe("unhandled");
		if (event.type === "unhandled") {
			expect(event.providerEventType).toBe("unparseable");
		}
	});

	it("returns unhandled for non-object JSON", () => {
		const event = mercadopagoProvider.parseWebhookEvent("42");
		expect(event.type).toBe("unhandled");
	});

	it("returns unhandled for charge.succeeded missing required fields", () => {
		// No orderDraftId → must NOT be treated as a success event
		const body = JSON.stringify({ type: "charge.succeeded", paymentReference: "1" });
		const event = mercadopagoProvider.parseWebhookEvent(body);
		expect(event.type).toBe("unhandled");
	});

	it("never treats an unhandled event as success", () => {
		const adversarial = JSON.stringify({
			type: "charge.succeeded",
			// missing orderDraftId AND paymentReference
			amount: 999999,
		});
		const event = mercadopagoProvider.parseWebhookEvent(adversarial);
		expect(event.type).not.toBe("charge.succeeded");
	});
});

describe("mercadopagoProvider contract", () => {
	it("implements the full PaymentProvider contract", () => {
		expect(mercadopagoProvider.id).toBe("mercadopago");
		expect(typeof mercadopagoProvider.supportsCurrency).toBe("function");
		expect(typeof mercadopagoProvider.initCheckout).toBe("function");
		expect(typeof mercadopagoProvider.verifyWebhook).toBe("function");
		expect(typeof mercadopagoProvider.parseWebhookEvent).toBe("function");
		expect(typeof mercadopagoProvider.refund).toBe("function");
		expect(typeof mercadopagoProvider.formatAmount).toBe("function");
	});

	it("supports the deployment currencies only", () => {
		for (const c of ["UYU", "ARS", "BRL", "CLP", "COP", "MXN", "PEN", "USD", "EUR"]) {
			expect(mercadopagoProvider.supportsCurrency(c)).toBe(true);
		}
		expect(mercadopagoProvider.supportsCurrency("XYZ")).toBe(false);
		expect(mercadopagoProvider.supportsCurrency("usd")).toBe(true); // case-insensitive
	});

	it("formats amounts via exact decimal strings", () => {
		expect(mercadopagoProvider.formatAmount(150000, "UYU")).toBe("1500.00");
		expect(mercadopagoProvider.formatAmount(2099, "USD")).toBe("20.99");
	});

	it("strips the Stripe {CHECKOUT_SESSION_ID} placeholder from back_urls (H-9)", async () => {
		// The core appends Stripe's placeholder to the success URL; MP does
		// NOT substitute it, so the adapter must strip it before building
		// back_urls. Capture the preference request MP receives.
		let capturedBody: { back_urls?: { success?: string; pending?: string } } | null = null;
		const ctx = {
			http: {
				fetch: async (_url: string, init?: { body?: string }) => {
					capturedBody = JSON.parse(String(init?.body ?? "{}"));
					return new Response(JSON.stringify({
						id: "pref-test-123",
						init_point: "https://www.mercadopago.com.uy/checkout/x",
						sandbox_init_point: "https://sandbox.mercadopago.com.uy/checkout/x",
					}), { status: 201 });
				},
			},
		};
		const result = await mercadopagoProvider.initCheckout(
			ctx as never,
			{
				orderDraftId: "draft123",
				amount: 2099,
				currency: "USD",
				customer: { email: "x@y.z" },
				lineItems: [{ name: "Item", amount: 2099, currency: "USD", quantity: 1 }],
				successUrl: "https://shop.example.com/thank-you/draft123?session_id={CHECKOUT_SESSION_ID}",
				cancelUrl: "https://shop.example.com/checkout?canceled=1",
				mode: "payment",
				billingAddressCollection: "auto",
				allowPromotionCodes: false,
				clientReferenceId: "draft123",
			} as never,
			{ secretKey: "TEST-abc" },
		);
		expect(result.kind).toBe("redirect");
		expect((capturedBody as { back_urls?: { success?: string } } | null)?.back_urls?.success).toBe("https://shop.example.com/thank-you/draft123");
		expect((capturedBody as { back_urls?: { pending?: string } } | null)?.back_urls?.pending).toBe("https://shop.example.com/thank-you/draft123");
		expect((capturedBody as { back_urls?: { success?: string } } | null)?.back_urls?.success ?? "").not.toContain("{CHECKOUT_SESSION_ID}");
	});
});
