/**
 * Mercado Pago PaymentProvider adapter for DashCommerce — Checkout Pro
 * (Preferences API).
 *
 * Implements the `PaymentProvider` interface from @dashcommerce/core so MP
 * Checkout (hosted) plugs into the core's checkout/webhook/refund pipeline
 * without forking it.
 *
 * API: POST /checkout/preferences (Mercado Pago Checkout Pro). Chosen over
 * the newer Orders API because (verified empirically 2026-10-13 against
 * api.mercadopago.com with the merchant's TEST credentials):
 *   - Orders API POST /v1/orders REJECTS TEST- tokens with 401
 *     invalid_credentials ("Test credentials are not supported").
 *   - Preferences API accepts TEST- tokens and returns 201 with init_point +
 *     sandbox_init_point, plus per-preference `notification_url` (Orders API
 *     has no per-order notification_url — webhooks are configured globally).
 *   - When the merchant upgrades to production credentials (APP_USR-), the
 *     same Preferences flow works unchanged.
 *
 * Key API facts (verified):
 *   - POST /checkout/preferences: body { items:[{title,quantity,currency_id,
 *     unit_price}], external_reference, payer:{email}, back_urls:{success,
 *     failure,pending}, auto_return:"approved", notification_url }.
 *     `auto_return` is REJECTED (400 invalid_auto_return) unless every
 *     back_url is https — we set it only when all back_urls are https.
 *   - Response 201: { id, init_point, sandbox_init_point, external_reference,
 *     notification_url, back_urls }.
 *   - Webhooks (topic "payment") POST to notification_url with
 *     `?data.id=<paymentId>` and header `x-signature`.
 *   - GET /v1/payments/{id}: { id, status, status_detail, external_reference,
 *     transaction_amount, currency_id, payer:{email} }.
 *   - Refund: POST /v1/payments/{id}/refunds (PLURAL — unlike the Orders API
 *     singular /refund).
 *
 * SECURITY (bank-grade):
 * - All MP API calls go through `ctx.http.fetch` (sandboxed, host-allowlisted).
 * - The access token is passed as a Bearer credential and NEVER logged.
 * - `getPaymentStatus` performs a live retrieve of the PAYMENT from MP so a
 *   spoofed webhook payload cannot create an order with a fake amount.
 * - Amounts are converted MP decimal ⇄ minor units with EXACT string
 *   arithmetic (money.ts) — floats are never used in the money path.
 * - The `init_point`/`sandbox_init_point` returned by MP is validated
 *   (https + allowlisted MP hosts) before being handed to the browser as a
 *   redirect target.
 *
 * WEBHOOK FLOW (two layers):
 *   1. MP → our public route `checkout/webhook-mercadopago` (routes.ts):
 *      validates the real `x-signature` HMAC header, live-retrieves the
 *      payment, verifies binding (external_reference, status, amount,
 *      currency), dedupes, and re-injects a trusted enriched event into the
 *      core pipeline.
 *   2. The re-injected event flows through the core's `checkout/webhook`
 *      route with an INTERNAL HMAC signature (header `x-mercadopago-signature`)
 *      that this adapter's `verifyWebhook` validates. The core then runs its
 *      own live-retrieve via `getPaymentStatus` and creates the order.
 */
import type {
	CreateRefundInput,
	InitCheckoutInput,
	InitCheckoutResult,
	NormalizedPaymentEvent,
	PaymentProvider,
	PaymentProviderCredentials,
	PaymentProviderRuntimeContext,
	PaymentStatusResult,
	RefundResult,
	VerifyWebhookInput,
	VerifyWebhookResult,
} from "@dashcommerce/core/payment-provider";

import { verifyMercadoPagoSignature, sha256Hex } from "./signature.js";
import {
	currencyMinorUnitDigits,
	decimalStringToMinorUnits,
	minorUnitsToDecimalNumber,
	minorUnitsToDecimalString,
} from "./money.js";
import type { PluginKV } from "./types.js";

export const MERCADOPAGO_PROVIDER_ID = "mercadopago";

const MP_API_BASE = "https://api.mercadopago.com";

/**
 * Hosts allowed for MP checkout redirects. MP returns `init_point` /
 * `sandbox_init_point` on preference creation; we validate them against this
 * allowlist so a compromised or misbehaving API response can't turn our
 * checkout into an open redirect.
 */
const MP_CHECKOUT_HOSTS = new Set([
	// Production hosts per country — MP's official doc: "The TLD of the
	// init_point will automatically match the marketplace country of the
	// Access Token owner". Both www and apex forms are allowed because
	// init_point URLs have been observed with either.
	"www.mercadopago.com.uy",
	"mercadopago.com.uy",
	"www.mercadopago.com.ar",
	"mercadopago.com.ar",
	"www.mercadopago.com.br",
	"mercadopago.com.br",
	"www.mercadopago.com.mx",
	"mercadopago.com.mx",
	// CL is the special case: NO `.com` — the Chilean checkout domain is
	// mercadopago.cl (verified against MP's official domains list).
	"www.mercadopago.cl",
	"mercadopago.cl",
	"www.mercadopago.com.co",
	"mercadopago.com.co",
	"www.mercadopago.com.pe",
	"mercadopago.com.pe",
	// Generic MP hosts (served for some account configurations).
	"www.mercadopago.com",
	"mercadopago.com",
	"www.mercadolibre.com",
	"mercadolibre.com",
	// Sandbox-hosted checkout pages (meli) — MP serves test checkouts here.
	"meli.com",
	"www.meli.com",
	"sandbox.mercadopago.com.uy",
	"sandbox.mercadopago.com",
	"sandbox.mercadopago.com.ar",
	"sandbox.mercadopago.com.br",
	"sandbox.mercadopago.com.mx",
	// CL sandbox follows the same no-.com rule as production.
	"sandbox.mercadopago.cl",
	"sandbox.mercadopago.com.cl",
	"sandbox.mercadopago.com.co",
	"sandbox.mercadopago.com.pe",
]);

/** Currencies MP supports in this deployment (Latin America + USD/EUR). */
const SUPPORTED_CURRENCIES = new Set([
	"UYU", "ARS", "BRL", "CLP", "COP", "MXN", "PEN", "USD", "EUR",
]);

/**
 * Validate that a checkout URL returned by MP is an https URL on an MP host.
 * Returns null when invalid — callers must treat that as a hard failure.
 */
export function validateCheckoutUrl(rawUrl: string | undefined | null): string | null {
	if (!rawUrl || typeof rawUrl !== "string") return null;
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return null;
	}
	if (url.protocol !== "https:") return null;
	if (!MP_CHECKOUT_HOSTS.has(url.hostname.toLowerCase())) return null;
	// No embedded credentials (user:pass@host) — classic open-redirect trick.
	if (url.username || url.password) return null;
	return url.toString();
}

/**
 * Stable idempotency key for preference creation, derived from the
 * orderDraftId. MP's Preferences API ignores X-Idempotency-Key, but sending
 * it is harmless and documents intent; retries of the same draft reuse the
 * same key.
 */
export function orderCreateIdempotencyKey(orderDraftId: string): string {
	// MP expects a UUID-shaped key. Derive a stable UUID v4 from four
	// independent FNV-1a hashes of the draft id so retries of the same draft
	// converge on the same key. Deterministic, no external deps.
	const h1 = fnv1a32(orderDraftId);
	const h2 = fnv1a32(`${orderDraftId}:mp-order`);
	const h3 = fnv1a32(`${orderDraftId}:tail`);
	const h4 = fnv1a32(`${orderDraftId}:uuid4`);
	// UUID v4 layout: 8-4-4-4-12 with version nibble 4 and variant bits 10xx.
	const seg2 = ((h2 >>> 16) & 0xffff).toString(16).padStart(4, "0");
	const seg3 = (0x4000 | ((h3 >>> 16) & 0x0fff)).toString(16).padStart(4, "0");
	const seg4 = (0x8000 | (h4 & 0x3fff)).toString(16).padStart(4, "0");
	const seg5 =
		`${(h3 & 0xffff).toString(16).padStart(4, "0")}` +
		`${(h4 >>> 16).toString(16).padStart(4, "0")}` +
		`${((h1 >>> 28) & 0xffff).toString(16).padStart(4, "0")}`;
	return `${hex8(h1)}-${seg2}-${seg3}-${seg4}-${seg5}`;
}

function fnv1a32(input: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

function hex8(n: number): string {
	return (n >>> 0).toString(16).padStart(8, "0");
}

/** HTTP helper — always via sandboxed ctx.http, Bearer auth, no secret logging. */
async function mpApi(
	ctx: PaymentProviderRuntimeContext,
	credentials: PaymentProviderCredentials,
	path: string,
	init?: { method?: string; body?: unknown; idempotencyKey?: string },
): Promise<unknown> {
	if (!ctx.http) {
		throw new Error("ctx.http unavailable — declare network:request capability");
	}
	const headers: Record<string, string> = {
		Authorization: `Bearer ${credentials.secretKey}`,
	};
	if (init?.body !== undefined) headers["Content-Type"] = "application/json";
	if (init?.idempotencyKey) headers["X-Idempotency-Key"] = init.idempotencyKey;
	const res = await ctx.http.fetch(`${MP_API_BASE}${path}`, {
		method: init?.method ?? "GET",
		headers,
		...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
	});
	const text = await res.text();
	let parsed: unknown = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		// Never include the response body in errors — it could contain echoes
		// of request data. Status code only.
		throw new Error(`Non-JSON Mercado Pago response (${res.status})`);
	}
	if (!res.ok) {
		const message =
			typeof parsed === "object" && parsed !== null && "message" in parsed
				? String((parsed as { message?: unknown }).message)
				: `Mercado Pago API error ${res.status}`;
		throw new Error(message);
	}
	return parsed;
}

/**
 * Shape of the MP payment object we care about (subset of
 * GET /v1/payments/{id} and webhook live-retrieves).
 */
export interface MpPayment {
	id: string | number;
	status: string;
	status_detail?: string;
	/** Decimal string or number — MP returns strings in most responses. */
	transaction_amount?: string | number;
	currency_id?: string;
	external_reference?: string;
	payer?: { email?: string; first_name?: string; last_name?: string };
}

function asMpPayment(value: unknown): MpPayment | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	if (v.id === undefined || typeof v.status !== "string") return null;
	return value as MpPayment;
}

/** Fetch a payment from the MP API (live retrieve). */
export async function fetchMpPayment(
	ctx: PaymentProviderRuntimeContext,
	credentials: PaymentProviderCredentials,
	paymentId: string,
): Promise<MpPayment | null> {
	const raw = await mpApi(ctx, credentials, `/v1/payments/${encodeURIComponent(paymentId)}`);
	return asMpPayment(raw);
}

/**
 * Map an MP payment status to the core's PaymentStatusResult.
 *
 * MP payment statuses (Checkout Pro / Payments API):
 *   approved    → money moved → succeeded
 *   authorized  → approved for later capture → pending
 *   in_process  → under review → pending
 *   in_mediation / pending_contingency / pending_review_manual → pending
 *   rejected    → failed (terminal)
 *   cancelled   → failed (terminal)
 *
 * UNKNOWN STATUSES ARE NEVER TREATED AS SUCCESS. Default is "failed" with
 * the raw status in the reason so operators can diagnose.
 */
export function mpPaymentToStatus(payment: MpPayment): PaymentStatusResult {
	const status = payment.status;
	let mapped: "succeeded" | "pending" | "failed";
	let reason: string | undefined;

	if (status === "approved") {
		mapped = "succeeded";
	} else if (
		status === "authorized" ||
		status === "in_process" ||
		status === "in_mediation" ||
		status === "pending_contingency" ||
		status === "pending_review_manual"
	) {
		mapped = "pending";
		reason = `mp status ${status}${payment.status_detail ? ` (${payment.status_detail})` : ""}`;
	} else if (status === "rejected" || status === "cancelled") {
		mapped = "failed";
		reason = `mp status ${status}${payment.status_detail ? ` (${payment.status_detail})` : ""}`;
	} else {
		// Unknown status → fail closed. NEVER approve on an unmapped status.
		mapped = "failed";
		reason = `unrecognized mp payment status: ${status}`;
	}

	const result: PaymentStatusResult = { status: mapped };
	if (payment.transaction_amount !== undefined && payment.currency_id) {
		try {
			result.amount = decimalStringToMinorUnits(payment.transaction_amount, payment.currency_id);
			result.currency = payment.currency_id.toUpperCase();
		} catch {
			// Malformed amount in the live-retrieve response — do not guess.
			// Report the failure; the core will 500 and MP will retry.
			return { status: "failed", reason: `malformed amount in mp payment ${payment.id}` };
		}
	}
	if (reason) result.reason = reason;
	if (payment.id !== undefined) result.paymentReference = String(payment.id);
	return result;
}

/** Extract payer email from a payment (for receipts). */
export function mpPaymentPayerEmail(payment: MpPayment): string | null {
	return payment.payer?.email ?? null;
}

/**
 * The MP provider adapter.
 *
 * `verifyWebhook` here validates the INTERNAL re-injected signature used by
 * the app-level webhook route (routes.ts) to feed trusted events into the
 * core pipeline. The real MP `x-signature` validation happens in routes.ts
 * before any event is trusted.
 */
export const mercadopagoProvider: PaymentProvider = {
	id: MERCADOPAGO_PROVIDER_ID,
	label: "Mercado Pago",
	capabilities: { coupons: false, connect: false, subscriptions: false },

	supportsCurrency(currency: string): boolean {
		return SUPPORTED_CURRENCIES.has(currency.toUpperCase());
	},

	async initCheckout(
		ctx: PaymentProviderRuntimeContext,
		input: InitCheckoutInput,
		credentials: PaymentProviderCredentials,
	): Promise<InitCheckoutResult> {
		const currency = input.currency.toUpperCase();

		// Build line items in MP Preferences format. unit_price MUST be a
		// JSON number (the Preferences API rejects decimal strings with
		// "unit_price must be a number" — verified empirically); the value
		// is still produced by exact integer arithmetic, never float math.
		const items = input.lineItems.map((li) => ({
			title: li.name,
			quantity: li.quantity,
			currency_id: currency,
			unit_price: minorUnitsToDecimalNumber(li.amount, currency),
			...(li.description ? { description: li.description } : {}),
		}));

		// Back URLs. MP calls the cancel URL "failure"; pending is a separate
		// state (e.g. offline methods) that should also land on thank-you so
		// the customer sees a "pending" order rather than a dead end.
		//
		// The core appends Stripe's `{CHECKOUT_SESSION_ID}` placeholder to the
		// success URL (Stripe substitutes it on redirect). Mercado Pago does
		// NOT substitute it — the customer would land on
		// `/thank-you/<draft>?session_id={CHECKOUT_SESSION_ID}` with the
		// literal placeholder in the address bar. Strip it: the thank-you
		// page only needs the draft id from the path.
		const successUrl = input.successUrl.replace(/\?session_id=\{CHECKOUT_SESSION_ID\}$/, "");
		const back_urls = {
			success: successUrl,
			failure: input.cancelUrl,
			pending: successUrl,
		};

		// `auto_return` requires ALL back_urls to be https (MP rejects the
		// preference with 400 invalid_auto_return otherwise — verified
		// empirically). Worse: MP silently DROPS http:// back_urls entirely
		// (stores them as empty strings — verified empirically), so in dev
		// (http://localhost) the customer is stranded on MP's page after
		// paying; the order is still created via the webhook. Production
		// (https) keeps back_urls and auto_return works as intended.
		const allHttps = [back_urls.success, back_urls.failure, back_urls.pending].every(
			(u) => u.startsWith("https://"),
		);

		// notification_url: our own public webhook route. MP POSTs
		// `?data.id=<paymentId>` here on every payment state change.
		// Derived from the success URL's origin so dev/prod just work.
		const origin = new URL(input.successUrl).origin;
		const notificationUrl = `${origin}/_emdash/api/plugins/dashcommerce/checkout/webhook-mercadopago`;

		const prefRequest = {
			items,
			external_reference: input.orderDraftId,
			...(input.customer.email ? { payer: { email: input.customer.email } } : {}),
			back_urls,
			...(allHttps ? { auto_return: "approved" } : {}),
			notification_url: notificationUrl,
			// Align the preference's life with the order draft's life. The
			// core's draft TTL is 15 minutes (DRAFT_TTL_MS = 900_000); an MP
			// preference without an expiry lives ~6 months. A stale open tab
			// could otherwise be paid long after the draft expired — the
			// webhook would reject it (draft gone) but the customer's money
			// would be stranded, forcing a manual refund. 20 minutes = draft
			// TTL + 5 min grace for the webhook to process.
			//
			// FIELD NAME: `date_of_expiration` — NOT `expiration_date` (MP
			// silently drops unknown fields; verified empirically in sandbox:
			// expiration_date → dropped, date_of_expiration → stored and
			// echoed back with delta <1s).
			//
			// FORMAT: ISO 8601 with offset (-03:00, America/Montevideo).
			// MP stores and echoes this format verbatim (verified in
			// sandbox); the UTC "Z" form was also accepted but the offset
			// form matches MP's own date_created format.
			date_of_expiration: toMpOffsetIso(new Date(Date.now() + 20 * 60 * 1000)),
		};

		const raw = await mpApi(ctx, credentials, "/checkout/preferences", {
			method: "POST",
			body: prefRequest,
			idempotencyKey: orderCreateIdempotencyKey(input.orderDraftId),
		});
		const pref = raw as {
			id?: string;
			init_point?: string;
			sandbox_init_point?: string;
		} | null;
		if (!pref || typeof pref.id !== "string") {
			throw new Error("Mercado Pago preference response missing id");
		}

		// Redirect target: sandbox_init_point when the credentials are TEST-
		// (sandbox checkout), init_point for production. Validate against the
		// allowlist either way — an invalid URL is a hard failure.
		const isSandbox = credentials.secretKey.startsWith("TEST-");
		const rawUrl = isSandbox ? pref.sandbox_init_point ?? pref.init_point : pref.init_point;
		const checkoutUrl = validateCheckoutUrl(rawUrl);
		if (!checkoutUrl) {
			throw new Error("Mercado Pago returned an invalid checkout URL");
		}

		return {
			kind: "redirect",
			checkoutReference: pref.id,
			redirectUrl: checkoutUrl,
		};
	},

	async verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
		// Internal re-injection path: the signature header here is an HMAC
		// produced by our own webhook route (routes.ts) using the MP webhook
		// secret, over the manifest built from the enriched body — INCLUDING
		// the SHA-256 of the raw body (bodyHash), so any body tampering fails.
		// The real MP x-signature validation happens in routes.ts before any
		// event is trusted.
		const bodyHash = await sha256Hex(input.rawBody);
		return verifyMercadoPagoSignature({
			signatureHeader: input.signatureHeader,
			dataId: extractDataIdFromBody(input.rawBody),
			requestId: extractRequestIdFromBody(input.rawBody),
			secret: input.secret,
			bodyHash,
		});
	},

	parseWebhookEvent(rawBody: string): NormalizedPaymentEvent {
		// The body our webhook route re-injects is a fully-enriched event
		// (orderDraftId, amounts, customer) built from the live-retrieved
		// payment — see routes.ts.
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawBody);
		} catch {
			return { type: "unhandled", providerEventType: "unparseable", raw: rawBody };
		}
		if (typeof parsed !== "object" || parsed === null) {
			return { type: "unhandled", providerEventType: "unparseable", raw: parsed };
		}
		const event = parsed as {
			type?: string;
			data?: { id?: string };
			// Enriched fields (present only in re-injected events):
			orderDraftId?: string;
			providerEventId?: string;
			amount?: number;
			currency?: string;
			customerEmail?: string;
			customerName?: string;
			paymentReference?: string;
			checkoutReference?: string;
			reason?: string;
		};
		if (event.type === "charge.succeeded" && event.orderDraftId && event.paymentReference) {
			return {
				type: "charge.succeeded",
				orderDraftId: event.orderDraftId,
				providerId: MERCADOPAGO_PROVIDER_ID,
				// Dedupe key: the enriched event's providerEventId
				// (`${paymentId}:${status}`) — NOT the bare paymentReference.
				// MP payments transition (in_process → approved); keying on
				// the bare payment id would mark the approved webhook as a
				// duplicate of the earlier in_process one and never create
				// the order.
				providerEventId: event.providerEventId ?? event.paymentReference,
				...(event.checkoutReference ? { checkoutReference: event.checkoutReference } : {}),
				paymentReference: event.paymentReference,
				amount: event.amount ?? 0,
				currency: event.currency ?? "UYU",
				customer: {
					email: event.customerEmail ?? "",
					...(event.customerName ? { name: event.customerName } : {}),
				},
				raw: parsed,
			};
		}
		if (event.type === "charge.failed" && event.orderDraftId) {
			return {
				type: "charge.failed",
				orderDraftId: event.orderDraftId,
				providerId: MERCADOPAGO_PROVIDER_ID,
				providerEventId: event.providerEventId ?? event.paymentReference ?? event.orderDraftId,
				...(event.checkoutReference ? { checkoutReference: event.checkoutReference } : {}),
				...(event.paymentReference ? { paymentReference: event.paymentReference } : {}),
				...(event.reason ? { reason: event.reason } : {}),
				raw: parsed,
			};
		}
		return {
			type: "unhandled",
			providerEventType: event.type ?? "unknown",
			...(event.data?.id ? { providerEventId: String(event.data.id) } : {}),
			raw: parsed,
		};
	},

	/**
	 * KV-backed refund race guard, keyed on the PAYMENT (the resource being
	 * mutated), not on the idempotency key. Rationale: the core's refund
	 * pipeline generates a fresh random key per HTTP request
	 * (`refund:${orderId}:${randomId()}`), so keying on refundRequestId can
	 * never catch a double-click — two clicks are two different keys. MP
	 * also ignores X-Idempotency-Key, and the core's `remaining refundable`
	 * check is read-before-write, so two concurrent requests both pass it.
	 *
	 * Protection stack (defense in depth):
	 *  1. Core: `remaining` check — catches SEQUENTIAL double-clicks once
	 *     the first refund has committed.
	 *  2. THIS lock — catches CONCURRENT double-clicks/retries while an MP
	 *     refund call for the same payment is in flight (the 1-3s window).
	 *     With emdash's production KV the acquisition is ATOMIC
	 *     (compareAndSet → INSERT … ON CONFLICT DO NOTHING): exactly one
	 *     concurrent caller acquires; the rest are rejected. See
	 *     acquireRefundLock() for the full semantics.
	 *  3. MP: rejects refunds exceeding the payment's remaining amount —
	 *     final backstop.
	 *
	 * Lock semantics:
	 *  - Value: { at: ISO timestamp, refundRequestId }.
	 *  - A lock older than MP_REFUND_LOCK_STALE_MS (crash leftover) is
	 *    stolen — availability over strict mutual exclusion. The steal is
	 *    itself a compare-and-swap on the observed revision, so two
	 *    would-be thieves cannot both win.
	 *  - Released in finally via compareAndDelete on OUR revision (or
	 *    ownership-checked delete in the fallback), so a stolen lock is
	 *    never deleted out from under its new owner.
	 */
	async refund(
		ctx: PaymentProviderRuntimeContext,
		input: CreateRefundInput,
		credentials: PaymentProviderCredentials,
	): Promise<RefundResult> {
		// MP Payments API refund: POST /v1/payments/{id}/refunds (PLURAL).
		// Empty body = full refund; partial = { amount: "..." } decimal string.
		const currency = input.currency.toUpperCase();

		const refundRequestId = input.refundRequestId?.trim() ?? "";
		if (!refundRequestId) {
			throw new Error("Refund requires a refundRequestId (idempotency key)");
		}

		// ctx is the full emdash PluginContext at runtime even though the
		// declared PaymentProviderRuntimeContext type only lists http/log.
		const kv = (ctx as { kv?: PluginKV }).kv;
		if (!kv) {
			// No KV available (unit tests, exotic runtimes): proceed without
			// the race guard rather than breaking refunds entirely.
			return executeMpRefund(ctx, input, credentials, currency);
		}

		const lockKey = `mp:refund:lock:${input.paymentReference}`;
		const lockValue = {
			at: new Date().toISOString(),
			refundRequestId,
		};

		// --- ATOMIC ACQUISITION (SEC-001) --------------------------------
		// emdash's KV exposes compareAndSet(key, null, v) which compiles to
		// INSERT … ON CONFLICT DO NOTHING — a DATABASE-ATOMIC exclusive
		// create. Two concurrent requests CANNOT both acquire: exactly one
		// INSERT wins, the other sees applied:false. This closes the
		// check-then-write race the previous best-effort lock had.
		const acquired = await acquireRefundLock(kv, lockKey, lockValue);
		if (!acquired) {
			throw new Error(
				"A refund for this payment is already in progress — retry shortly",
			);
		}
		try {
			return await executeMpRefund(ctx, input, credentials, currency);
		} finally {
			// Release only if we still own the lock — it may have been
			// stolen by a later request if we were stuck past the stale
			// window (e.g. a very slow MP call).
			await releaseRefundLock(kv, lockKey, lockValue);
		}
	},

	formatAmount(amount: number, currency: string): string {
		return minorUnitsToDecimalString(amount, currency);
	},

	async getPaymentStatus(
		ctx: PaymentProviderRuntimeContext,
		paymentReference: string,
		credentials: PaymentProviderCredentials,
	): Promise<PaymentStatusResult> {
		// paymentReference is the MP PAYMENT id (numeric string) — the core
		// stores whatever we set as paymentReference in the normalized event.
		const payment = await fetchMpPayment(ctx, credentials, paymentReference);
		if (!payment) {
			return { status: "failed", reason: "payment not found at provider" };
		}
		return mpPaymentToStatus(payment);
	},
};

/** Extract data.id from a re-injected body (helper for verifyWebhook). */
function extractDataIdFromBody(rawBody: string): string {
	try {
		const parsed = JSON.parse(rawBody) as { data?: { id?: string }; paymentReference?: string };
		return String(parsed.data?.id ?? parsed.paymentReference ?? "");
	} catch {
		return "";
	}
}

/** Extract request-id from a re-injected body (helper for verifyWebhook). */
function extractRequestIdFromBody(rawBody: string): string {
	try {
		const parsed = JSON.parse(rawBody) as { requestId?: string };
		return parsed.requestId ?? "";
	} catch {
		return "";
	}
}

/**
 * Format a Date as ISO 8601 with the -03:00 offset (America/Montevideo),
 * the form MP's own API uses (see date_created in responses) and the form
 * we verified in sandbox for date_of_expiration. Pure string building —
 * no external deps, no locale.
 */
function toMpOffsetIso(d: Date): string {
	const shifted = new Date(d.getTime() - 3 * 3600_000); // -03:00
	const pad = (n: number, w = 2) => String(n).padStart(w, "0");
	return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
		+ `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}.000-03:00`;
}

/**
 * A refund lock older than this is treated as a crash leftover and stolen.
 * 30s comfortably covers MP API latency (p99 well under 10s) plus retries.
 */
const MP_REFUND_LOCK_STALE_MS = 30_000;

/** Parse a refund lock value defensively (corrupt data → null → steal). */
function parseRefundLock(value: unknown): { at: number; refundRequestId: string } | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as { at?: unknown; refundRequestId?: unknown };
	if (typeof v.at !== "string" || typeof v.refundRequestId !== "string") return null;
	const at = Date.parse(v.at);
	if (Number.isNaN(at)) return null;
	return { at, refundRequestId: v.refundRequestId };
}

/**
 * Acquire the per-payment refund lock (SEC-001).
 *
 * FAST PATH — atomic, when the KV exposes emdash's CAS primitives:
 *   1. Try exclusive create: compareAndSet(key, null, value) → INSERT …
 *      ON CONFLICT DO NOTHING. Exactly one concurrent caller wins; all
 *      others get applied:false and are rejected. NO check-then-write
 *      race window exists in this path.
 *   2. If a lock exists and is STALE (> MP_REFUND_LOCK_STALE_MS, a crash
 *      leftover), steal it with a CAS on the revision we observed:
 *      compareAndSet(key, observedRevision, value). If another request
 *      replaced the lock meanwhile, our steal fails (applied:false) and
 *      we are rejected — the takeover itself is race-free.
 *
 * FALLBACK — best-effort, when the KV only has plain get/set/delete
 * (unit-test fakes, exotic runtimes): read the lock; if fresh, reject;
 * if stale/corrupt/absent, write ours. Two truly simultaneous requests
 * can in theory both pass this fallback (the auditor's SEC-001 finding).
 * emdash's production KV always provides CAS, so the fallback exists
 * for compatibility, not for production. Documented in SECURITY_MODEL.
 */
async function acquireRefundLock(
	kv: PluginKV,
	lockKey: string,
	lockValue: { at: string; refundRequestId: string },
): Promise<boolean> {
	if (typeof kv.compareAndSet === "function") {
		// 1. Exclusive create — database-atomic.
		const created = await kv.compareAndSet(lockKey, null, lockValue);
		if (created?.applied) return true;

		// 2. Existing lock — fresh or stale?
		const versioned = await kv.getVersioned?.(lockKey);
		const existing = parseRefundLock(versioned?.value ?? (await kv.get(lockKey)));
		if (existing && Date.now() - existing.at < MP_REFUND_LOCK_STALE_MS) {
			return false; // fresh lock owned by someone else → reject
		}
		// Stale (crash leftover) or corrupt → steal via CAS on the
		// revision we just observed. If the lock changed underneath us
		// (someone else stole it first), the CAS fails and we reject.
		if (versioned?.revision) {
			const stolen = await kv.compareAndSet(lockKey, versioned.revision, lockValue);
			return stolen?.applied === true;
		}
		// getVersioned unavailable but compareAndSet exists: rare
		// half-implemented KV — fall through to the best-effort path.
	}

	// Best-effort fallback (no CAS available).
	const existing = parseRefundLock(await kv.get(lockKey));
	if (existing && Date.now() - existing.at < MP_REFUND_LOCK_STALE_MS) {
		return false;
	}
	await kv.set(lockKey, lockValue);
	return true;
}

/**
 * Release the refund lock, deleting it ONLY when we still own it.
 *
 * With CAS: compareAndDelete(key, ourRevision) — a request that was stuck
 * past the stale window and had its lock stolen can NOT delete the new
 * owner's lock, because our revision no longer matches. Without CAS:
 * ownership check by refundRequestId (best-effort, same as before).
 */
async function releaseRefundLock(
	kv: PluginKV,
	lockKey: string,
	ourValue: { at: string; refundRequestId: string },
): Promise<void> {
	if (typeof kv.compareAndDelete === "function" && typeof kv.getVersioned === "function") {
		const versioned = await kv.getVersioned(lockKey);
		if (!versioned) return;
		const current = parseRefundLock(versioned.value);
		if (current?.refundRequestId === ourValue.refundRequestId) {
			await kv.compareAndDelete(lockKey, versioned.revision);
		}
		return;
	}
	// Best-effort fallback: ownership check by refundRequestId.
	const current = parseRefundLock(await kv.get(lockKey));
	if (current?.refundRequestId === ourValue.refundRequestId) {
		await kv.delete(lockKey);
	}
}

/**
 * The raw MP refund call, separated from refund() so the KV race guard
 * can wrap it. POST /v1/payments/{id}/refunds (PLURAL — unlike the Orders
 * API singular /refund). Empty body = full refund; partial = { amount }
 * decimal string.
 */
async function executeMpRefund(
	ctx: PaymentProviderRuntimeContext,
	input: CreateRefundInput,
	credentials: PaymentProviderCredentials,
	currency: string,
): Promise<RefundResult> {
	const body =
		input.amount !== undefined
			? { amount: minorUnitsToDecimalString(input.amount, currency) }
			: {};

	const raw = await mpApi(
		ctx,
		credentials,
		`/v1/payments/${encodeURIComponent(input.paymentReference)}/refunds`,
		{ method: "POST", body, idempotencyKey: input.refundRequestId },
	);
	const refund = raw as {
		id?: string | number;
		status?: string;
		amount?: string | number;
	};
	return {
		providerRefundId: String(refund.id ?? input.refundRequestId),
		refundRequestId: input.refundRequestId,
		status: refund.status === "approved" ? "succeeded" : "pending",
		amount: input.amount ?? (typeof refund.amount !== "undefined"
			? decimalStringToMinorUnits(refund.amount, currency)
			: 0),
		currency,
	};
}

export { currencyMinorUnitDigits, decimalStringToMinorUnits, minorUnitsToDecimalString };
