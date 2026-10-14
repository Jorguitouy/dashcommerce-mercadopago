/**
 * Mercado Pago webhook verification logic (pure, testable).
 *
 * The MP-facing route (routes.ts) receives the webhook, then this module's
 * `verifyMpWebhook` performs the full bank-grade verification sequence:
 *
 *   1. Method check (POST only) — MP only ever POSTs.
 *   2. Extract `data.id` from the query string (`?data.id=<paymentId>`).
 *   3. Validate the real MP `x-signature` header:
 *        manifest = id:[data.id];request-id:[x-request-id];ts:[ts];
 *      HMAC-SHA256 with the MP webhook secret, timing-safe compare,
 *      ±5min replay window.
 *   4. LIVE-RETRIEVE the payment from api.mercadopago.com (never trust the
 *      webhook body — it only contains the id).
 *   5. BINDING CHECKS against the order draft stored in KV:
 *        - external_reference === orderDraftId (the payment belongs to a
 *          checkout session WE created)
 *        - status is a success state (approved)
 *        - transaction_amount (exact minor units) === draft cart total
 *        - currency matches
 *   6. On success, produce an ENRICHED event for re-injection into the
 *      core pipeline, signed with an internal HMAC so the core's
 *      verifyWebhook accepts it.
 *
 * The enriched event is then POSTed (in-process) to the core's
 * `checkout/webhook` route with header `x-mercadopago-signature`.
 */
import type { PaymentProviderRuntimeContext } from "@dashcommerce/core/payment-provider";

import { verifyMercadoPagoSignature, buildManifest, sha256Hex } from "./signature.js";
import {
	fetchMpPayment,
	mpPaymentPayerEmail,
	type MpPayment,
} from "./provider.js";
import { decimalStringToMinorUnits } from "./money.js";

/** MP payment statuses that mean "money moved" for webhook purposes. */
const MP_SUCCESS_STATUSES = new Set(["approved"]);

/** Header the core's webhook route looks for when provider = mercadopago. */
export const INTERNAL_SIGNATURE_HEADER = "x-mercadopago-signature";

export interface MpWebhookInput {
	/** The incoming Request (already body-consumed by emdash; we only read headers/url). */
	request: Request;
	/** Plugin context (kv, http, log). */
	ctx: PaymentProviderRuntimeContext & {
		kv: {
			get(key: string): Promise<unknown>;
		};
	};
	/** MP webhook secret (from settings:mercadopagoWebhookSecret). */
	webhookSecret: string;
	/** MP access token (from settings:mercadopagoSecretKey). */
	accessToken: string;
}

export type MpWebhookOutcome =
	| { kind: "invalid"; status: 400 | 405 | 502; body: Record<string, unknown> }
	| { kind: "duplicate"; status: 200; body: Record<string, unknown> }
	| {
			kind: "verified";
			status: 200;
			body: Record<string, unknown>;
			/** The enriched event to re-inject into the core pipeline. */
			enrichedEvent: {
				type: "charge.succeeded" | "charge.failed";
				orderDraftId: string;
				providerId: "mercadopago";
				providerEventId: string;
				paymentReference: string;
				checkoutReference: string;
				amount: number;
				currency: string;
				customerEmail: string | null;
				customerName: string | null;
				reason?: string;
				/** data.id + requestId for the internal signature manifest. */
				dataId: string;
				requestId: string;
			};
	  };

/**
 * Verify an MP webhook end-to-end. Pure with respect to the request; all
 * effects (KV reads, HTTP) go through ctx. Returns a discriminated union so
 * routes.ts can map outcomes to HTTP responses without duplicating logic.
 */
export async function verifyMpWebhook(input: MpWebhookInput): Promise<MpWebhookOutcome> {
	const { request, ctx, webhookSecret, accessToken } = input;

	// 1. Method check.
	if (request.method !== "POST") {
		return {
			kind: "invalid",
			status: 405,
			body: { error: "Method not allowed" },
		};
	}

	// 2. Extract data.id from query (?data.id=<paymentId>).
	const url = new URL(request.url);
	const dataId = url.searchParams.get("data.id") ?? "";
	if (!dataId) {
		return {
			kind: "invalid",
			status: 400,
			body: { error: "Missing data.id" },
		};
	}

	// 3. Validate the real MP x-signature header.
	const signatureHeader = request.headers.get("x-signature") ?? "";
	const requestId = request.headers.get("x-request-id") ?? "";
	if (!signatureHeader) {
		return {
			kind: "invalid",
			status: 400,
			body: { error: "Missing x-signature header" },
		};
	}
	const sigResult = await verifyMercadoPagoSignature({
		signatureHeader,
		dataId,
		requestId,
		secret: webhookSecret,
	});
	if (!sigResult.ok) {
		ctx.log.warn("MP webhook signature invalid", {
			dataId,
			reason: sigResult.reason,
		});
		return {
			kind: "invalid",
			status: 400,
			body: { error: `Invalid signature: ${sigResult.reason}` },
		};
	}

	// 4. LIVE-RETRIEVE the payment. The webhook body only carries the id —
	// we never trust it; we fetch authoritative state from MP.
	let payment: MpPayment | null = null;
	try {
		payment = await fetchMpPayment(
			ctx,
			{ secretKey: accessToken, webhookSecret },
			dataId,
		);
	} catch (err) {
		ctx.log.error("MP live-retrieve failed", {
			dataId,
			error: err instanceof Error ? err.message : String(err),
		});
		// 5xx so MP retries the webhook.
		return {
			kind: "invalid",
			status: 502,
			body: { error: "Live retrieve failed" },
		};
	}
	if (!payment) {
		return {
			kind: "invalid",
			status: 400,
			body: { error: "Payment not found at provider" },
		};
	}

	// 5. BINDING CHECKS against the draft snapshot in KV.
	const orderDraftId = payment.external_reference ?? "";
	if (!orderDraftId) {
		ctx.log.warn("MP payment has no external_reference", { mpPaymentId: payment.id });
		return {
			kind: "invalid",
			status: 400,
			body: { error: "Payment missing external_reference" },
		};
	}
	const draft = await ctx.kv.get(`draft:${orderDraftId}`) as
		| { cart?: { total?: { amount?: number; currency?: string } } }
		| null
		| undefined;
	if (!draft) {
		// Draft already consumed (order already created) or expired.
		// This is the normal duplicate-delivery case — answer 200 so MP
		// stops retrying.
		ctx.log.info("MP webhook for consumed/expired draft", {
			orderDraftId,
			mpPaymentId: payment.id,
		});
		return {
			kind: "duplicate",
			status: 200,
			body: { received: true, duplicate: true },
		};
	}

	const draftTotal = draft.cart?.total;
	const expectedAmount = typeof draftTotal?.amount === "number" ? draftTotal.amount : null;
	const expectedCurrency = draftTotal?.currency ?? null;

	// Status check — only success statuses create orders.
	if (!MP_SUCCESS_STATUSES.has(payment.status)) {
		const isFailure = payment.status === "rejected" || payment.status === "cancelled";
		ctx.log.info("MP webhook for non-success status", {
			mpPaymentId: payment.id,
			status: payment.status,
			detail: payment.status_detail,
		});
		if (isFailure) {
			return {
				kind: "verified",
				status: 200,
				body: { received: true, status: payment.status },
				enrichedEvent: {
					type: "charge.failed",
					orderDraftId,
					providerId: "mercadopago",
					providerEventId: `${payment.id}:${payment.status}`,
					paymentReference: String(payment.id),
					checkoutReference: String(payment.id),
					amount: 0,
					currency: expectedCurrency ?? "UYU",
					customerEmail: mpPaymentPayerEmail(payment),
					customerName: null,
					reason: `mp status ${payment.status}${payment.status_detail ? ` (${payment.status_detail})` : ""}`,
					dataId,
					requestId,
				},
			};
		}
		// Pending/unknown statuses: 200 + no-op (MP will re-notify on change).
		// The enriched event is typed charge.failed so the core releases the
		// stock lock for this draft; a later approved webhook re-creates it.
		return {
			kind: "verified",
			status: 200,
			body: { received: true, status: payment.status, pending: true },
			enrichedEvent: {
				type: "charge.failed",
				orderDraftId,
				providerId: "mercadopago",
				providerEventId: `${payment.id}:${payment.status}`,
				paymentReference: String(payment.id),
				checkoutReference: String(payment.id),
				amount: 0,
				currency: expectedCurrency ?? "UYU",
				customerEmail: mpPaymentPayerEmail(payment),
				customerName: null,
				reason: `mp status ${payment.status}`,
				dataId,
				requestId,
			},
		};
	}

	// Currency binding FIRST — comparing minor units across different
	// currencies is semantically wrong (2099.00 UYU ≠ 2099 USD in minor
	// units), so a currency swap must fail with "Currency mismatch", not a
	// misleading amount error.
	if (expectedCurrency === null) {
		return {
			kind: "invalid",
			status: 400,
			body: { error: "Draft snapshot missing total" },
		};
	}
	if (!payment.currency_id) {
		return {
			kind: "invalid",
			status: 400,
			body: { error: "Payment missing amount/currency" },
		};
	}
	if (payment.currency_id.toUpperCase() !== expectedCurrency.toUpperCase()) {
		return {
			kind: "invalid",
			status: 400,
			body: { error: "Currency mismatch" },
		};
	}

	// Amount binding (exact minor units, same currency now guaranteed).
	if (payment.transaction_amount === undefined) {
		return {
			kind: "invalid",
			status: 400,
			body: { error: "Payment missing amount/currency" },
		};
	}
	let paymentAmount: number;
	try {
		paymentAmount = decimalStringToMinorUnits(payment.transaction_amount, payment.currency_id);
	} catch {
		return {
			kind: "invalid",
			status: 400,
			body: { error: "Malformed payment amount" },
		};
	}
	if (expectedAmount === null) {
		return {
			kind: "invalid",
			status: 400,
			body: { error: "Draft snapshot missing total" },
		};
	}
	if (paymentAmount !== expectedAmount) {
		ctx.log.error("MP webhook amount mismatch", {
			mpPaymentId: payment.id,
			paymentAmount,
			expectedAmount,
		});
		return {
			kind: "invalid",
			status: 400,
			body: { error: "Amount mismatch" },
		};
	}

	// 6. Enriched event for re-injection.
	return {
		kind: "verified",
		status: 200,
		body: { received: true },
		enrichedEvent: {
			type: "charge.succeeded",
			orderDraftId,
			providerId: "mercadopago",
			providerEventId: `${payment.id}:approved`,
			paymentReference: String(payment.id),
			checkoutReference: String(payment.id),
			amount: paymentAmount,
			currency: payment.currency_id.toUpperCase(),
			customerEmail: mpPaymentPayerEmail(payment),
			customerName: null,
			dataId,
			requestId,
		},
	};
}

/**
 * Sign the enriched event body with the internal HMAC so the core's
 * verifyWebhook (provider.verifyWebhook of the MP adapter) accepts it.
 *
 * The internal signature uses the SAME manifest format as MP
 * (id:[data.id];request-id:[requestId];ts:[ts];) with a fresh `ts` of NOW,
 * signed with the MP webhook secret. The adapter's verifyWebhook extracts
 * data.id + requestId from the body itself, so the re-injected request is
 * self-consistent.
 */
export async function signEnrichedEvent(
	enrichedEvent: Record<string, unknown>,
	webhookSecret: string,
): Promise<{ body: string; signatureHeader: string }> {
	const ts = String(Date.now());
	const dataId = String(enrichedEvent.dataId ?? enrichedEvent.paymentReference ?? "");
	const requestId = String(enrichedEvent.requestId ?? "");

	// Strip internal-only fields from the event, then build the re-injected
	// body. The body carries data.id + requestId so verifyWebhook can rebuild
	// the manifest.
	const { dataId: _d, requestId: _r, ...event } = enrichedEvent as Record<string, unknown>;
	const body = JSON.stringify({
		...event,
		data: { id: dataId },
		requestId,
	});

	// DEFENSE IN DEPTH: the internal signature covers the FULL body via its
	// SHA-256 hash, not just id/request-id/ts. A body tampered by one byte
	// (amount, orderDraftId, customer…) fails verification even though the
	// core's own live-retrieve would also catch it (layer 2).
	const bodyHash = await sha256Hex(body);
	const manifest = buildManifest({ dataId, requestId, ts, bodyHash });

	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(webhookSecret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(manifest));
	const hex = bytesToHex(new Uint8Array(sig));

	return { body, signatureHeader: `ts=${ts},v1=${hex}` };
}

function bytesToHex(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i++) {
		out += bytes[i].toString(16).padStart(2, "0");
	}
	return out;
}

export { mpPaymentToStatus } from "./provider.js";
