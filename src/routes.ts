/**
 * Mercado Pago wrapper routes (merged into the DashCommerce core routes).
 *
 * Routes added by the wrapper (see entry.ts):
 *   - `checkout/webhook-mercadopago` (PUBLIC, response:"raw") — the endpoint
 *     MP's notification_url points to. Validates the real MP x-signature,
 *     live-retrieves the payment, verifies binding, and re-injects a trusted
 *     enriched event into the core's `checkout/webhook` pipeline.
 *   - `admin/mercadopago/settings` (ADMIN) — GET/POST the MP credentials.
 *     GET returns {isSet, hint} only — never the values. POST validates
 *     token prefixes (TEST-/APP_USR-) and writes via ctx.kv.set so emdash
 *     encrypts them (settingsSchema declares them as secrets).
 *
 * EMDASH ROUTE CONTRACT (verified against emdash 1.2.0 dist):
 *   - Non-raw routes MUST return a JSON-serializable value (plain object) —
 *     returning a `Response` gets it wrapped by apiSuccess() and the
 *     status/body are silently lost (200 {"success":true,"data":{}}).
 *   - Raw routes MUST declare `response: "raw"` and return `pluginResponse()`
 *     from `emdash/plugin` (the wire layer rejects bare `Response` objects).
 *   - Errors: throw `PluginRouteError` (or return it) — the route registry
 *     maps it to {success:false, error:{code,message}, status}.
 *
 * Route handler shape: emdash calls native routes with a single ctx that is
 * BOTH the route context (request, input, user) and the plugin context
 * (kv, http, log, storage). The core's authored handlers use
 * `(routeCtx, ctx)`; `toNativeRoutes` passes the one ctx as both args.
 */
import type { PluginRouteContext } from "./types.js";
import coreEntry from "@dashcommerce/core/sandbox";
import { pluginResponse } from "emdash/plugin";
import { PluginRouteError } from "emdash";

import { verifyMpWebhook, signEnrichedEvent } from "./webhook.js";
import { MERCADOPAGO_PROVIDER_ID } from "./provider.js";

/** The core's `checkout/webhook` handler (authored two-arg format). */
const coreWebhookHandler = coreEntry.routes["checkout/webhook"].handler as unknown as (
	routeCtx: PluginRouteContext,
	ctx: PluginRouteContext,
) => Promise<Response>;

/** Masked-secret sentinel (same convention as the core's admin settings). */
const MASKED_SECRET_PREFIX = "••••";

/** Valid access-token prefixes: TEST- (sandbox) or APP_USR- (production). */
const MP_TOKEN_PREFIXES = ["TEST-", "APP_USR-"];

/** Valid webhook-secret format: MP gives a plain string; require length. */
const MIN_WEBHOOK_SECRET_LENGTH = 8;

/** Explicit delete sentinel: POST this value to remove a secret. */
const DELETE_FLAG = "__DELETE__";

/**
 * Build a raw JSON response through emdash's wire layer.
 *
 * MP retries webhooks based on the HTTP status we return, so the status
 * MUST survive the dispatch layer — hence response:"raw" + pluginResponse.
 * The wire layer only allows the headers in its allowlist (content-type is
 * one) and blocks script-y content types; application/json is fine.
 */
function rawJson(body: unknown, status = 200) {
	return pluginResponse({
		status,
		headers: { "Content-Type": "application/json" },
		body: { kind: "text", value: JSON.stringify(body) },
	});
}

/** Secret hint: first 4 chars + length — enough to identify, not to use. */
function secretHint(value: string): string {
	return `${value.slice(0, 4)}…${value.length} chars`;
}

/**
 * IP-based fixed-window rate limit for the public MP webhook (H-6).
 *
 * Counter lives in KV under `state:mpWebhookRate:<ip>:<windowStart>` —
 * one counter per 60s window, so keys self-expire by window rotation
 * (emdash KV persists small state like the core's portal-link timestamps).
 * Limit: 30 requests/min/IP. Legit MP retries are a handful per payment
 * state change; anything above that is a flood. Returns the 429 response
 * when exceeded, null when allowed.
 *
 * ATOMICITY (SEC-002): when the KV exposes emdash's compareAndSet, the
 * counter increment is a compare-and-swap loop on the observed revision —
 * concurrent requests can no longer overwrite each other's increments, so
 * the effective limit under concurrency is exactly 30 (previously two
 * simultaneous requests could both read N and both write N+1, letting
 * more than 30 through). Without CAS (plain get/set/delete KVs), we fall
 * back to the read-then-write counter — best-effort, documented in
 * SECURITY_MODEL.md.
 *
 * TRUST MODEL for the IP: `cf-connecting-ip` is set by Cloudflare and is
 * trustworthy when the app runs behind CF. `x-forwarded-for` is client
 * controllable when NOT set by a trusted reverse proxy — we only use it
 * as a fallback so self-hosted deployments still get per-client limits;
 * behind an untrusted proxy the limit degrades to per-spoofed-IP, which
 * is still strictly better than no limit. Documented in SECURITY_MODEL.
 */
const MP_WEBHOOK_RATE_LIMIT = 30;
const MP_WEBHOOK_RATE_WINDOW_MS = 60_000;

/**
 * Best-effort sweep of this IP's stale rate-limit counters (windows ≤ W-2).
 *
 * WHY (BUG-003): emdash's plugin KV has NO TTL — every `state:mpWebhookRate:
 * <ip>:<window>` counter lives forever unless deleted. A spoofed-IP flood
 * (x-forwarded-for behind a non-CF proxy) would grow the options table
 * unboundedly: gradual DoS on the shared KV. The core's cron only sweeps
 * `lock:*` keys, so the plugin owns its garbage.
 *
 * HOW: runs once per IP×window — only on the FIRST request of a new window
 * (when the current window's counter doesn't exist yet), so it stays off the
 * per-request hot path. Uses kv.list(prefix) when available (full history
 * cleanup); otherwise deletes just W-2 (bounded fallback — with the list
 * path unavailable, W-2 is the oldest window that can still matter for
 * debugging). Failures are swallowed: a sweep error must never 500 a
 * webhook that would otherwise be admitted.
 */
async function sweepStaleRateCounters(
	kv: PluginRouteContext["kv"],
	ip: string,
	windowStart: number,
): Promise<void> {
	try {
		const prefix = `state:mpWebhookRate:${ip}:`;
		if (typeof kv.list === "function") {
			const entries = await kv.list(prefix);
			for (const entry of entries) {
				const rest = entry.key.slice(prefix.length);
				if (!/^\d+$/.test(rest)) continue;
				const entryWindow = Number(rest);
				if (windowStart - entryWindow >= 2) await kv.delete(entry.key);
			}
		} else {
			await kv.delete(`${prefix}${windowStart - 2}`);
		}
	} catch {
		// Best-effort by design — never fail the request over cleanup.
	}
}

async function webhookRateLimit(ctx: PluginRouteContext): Promise<ReturnType<typeof rawJson> | null> {
	const ip =
		ctx.request.headers.get("cf-connecting-ip") ??
		ctx.request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		"unknown";
	const windowStart = Math.floor(Date.now() / MP_WEBHOOK_RATE_WINDOW_MS);
	const key = `state:mpWebhookRate:${ip}:${windowStart}`;
	const kv = ctx.kv;

	// ATOMIC PATH: CAS loop on the counter (SEC-002).
	if (typeof kv.compareAndSet === "function" && typeof kv.getVersioned === "function") {
		for (let attempt = 0; attempt < 8; attempt++) {
			const versioned = await kv.getVersioned(key);
			if (!versioned) {
				// First request in the window: exclusive create. A lost
				// race (someone else inserted first) retries the loop.
				const created = await kv.compareAndSet(key, null, 1);
				if (created?.applied) {
					// First request of a NEW window → sweep this IP's stale
					// counters (BUG-003). Fire-and-forget: never block or
					// fail the admitted request on cleanup.
					void sweepStaleRateCounters(kv, ip, windowStart).catch(() => {});
					return null;
				}
				continue;
			}
			const current = Number(versioned.value);
			if (Number.isFinite(current) && current >= MP_WEBHOOK_RATE_LIMIT) {
				return rawJson({ error: "Too many requests" }, 429);
			}
			// Increment via CAS on the observed revision. If another
			// request bumped the counter in between, applied:false →
			// retry with the fresh value (no lost increments).
			const updated = await kv.compareAndSet(key, versioned.revision, current + 1);
			if (updated?.applied) return null;
		}
		// CAS contention beyond 8 attempts: treat as allowed. The counter
		// is hot but every retry re-reads the fresh value, so a burst
		// cannot push the count backwards — failing open here cannot
		// exceed the limit by more than the in-flight retry races.
		return null;
	}

	// FALLBACK (no CAS): read-then-write. Under high concurrency two
	// requests may read the same count and overwrite each other's +1,
	// letting slightly more than the limit through. Best-effort only.
	const current = Number((await kv.get(key)) ?? 0);
	if (Number.isFinite(current) && current >= MP_WEBHOOK_RATE_LIMIT) {
		return rawJson({ error: "Too many requests" }, 429);
	}
	if (current === 0) {
		// First request of a new window → sweep stale counters (BUG-003),
		// fire-and-forget — same rationale as the CAS path.
		void sweepStaleRateCounters(kv, ip, windowStart).catch(() => {});
	}
	await kv.set(key, String(current + 1));
	return null;
}

/**
 * PUBLIC: MP webhook receiver (raw response).
 *
 * MP POSTs here with `?data.id=<orderId>` and header `x-signature`.
 * Full verification sequence lives in webhook.ts (verifyMpWebhook):
 * signature → live-retrieve → binding checks → dedupe → enrich.
 */
export const mercadopagoWebhookRoutes = {
	"checkout/webhook-mercadopago": {
		public: true,
		response: "raw" as const,
		handler: async (ctx: PluginRouteContext) => {
			// Rate limit BEFORE anything else (H-6): a flood of bogus
			// signatures must not reach the HMAC check or the MP API.
			// Legit MP retries (a handful per payment state change) stay
			// far below the limit; floods get a cheap 429. MP backs off
			// on 429s, so this does not risk dropping real notifications.
			const rl = await webhookRateLimit(ctx);
			if (rl) return rl;

			// Load MP credentials from settings (decrypted by emdash when
			// EMDASH_ENCRYPTION_KEY is configured).
			const accessToken = (await ctx.kv.get("settings:mercadopagoSecretKey")) as
				| string
				| null;
			const webhookSecret = (await ctx.kv.get("settings:mercadopagoWebhookSecret")) as
				| string
				| null;
			if (!accessToken || !webhookSecret) {
				// 500: MP will retry. Credentials are a server-side config
				// problem, not a property of this particular notification.
				ctx.log.error("MP webhook received but credentials not configured");
				return rawJson({ error: "Mercado Pago credentials not configured" }, 500);
			}

			let outcome;
			try {
				outcome = await verifyMpWebhook({
					request: ctx.request,
					ctx,
					webhookSecret,
					accessToken,
				});
			} catch (err) {
				// Unexpected internal failure (KV corruption, network error
				// during live-retrieve, …). Log WITH the payment id so an
				// operator can trace exactly which notification failed, then
				// return 500 — MP retries 500s, so the notification is not
				// lost. Never include the error message in the response
				// body: it could leak internal details (paths, hostnames).
				const paymentId = new URL(ctx.request.url).searchParams.get("data.id");
				ctx.log.error("MP webhook internal failure", {
					paymentId: paymentId ?? null,
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
				return rawJson({ error: "Webhook processing failed" }, 500);
			}

			if (outcome.kind === "invalid") {
				return rawJson(outcome.body, outcome.status);
			}
			if (outcome.kind === "duplicate") {
				return rawJson(outcome.body, outcome.status);
			}

			// verified → sign the enriched event and re-inject into the core
			// pipeline by invoking the core's `checkout/webhook` handler
			// in-process. The core route resolves the provider from the
			// `x-mercadopago-signature` header, validates the internal HMAC,
			// dedupes via recordStripeEvent, live-retrieves AGAIN via
			// getPaymentStatus, and creates the order.
			const { body, signatureHeader } = await signEnrichedEvent(
				outcome.enrichedEvent as unknown as Record<string, unknown>,
				webhookSecret,
			);

			// Build the internal request the core route will handle. The
			// core's readRawBody uses req.clone().text() — clone works on the
			// guarded proxy (bound to the real request).
			const internalRequest = new Request(
				"https://internal.invalid/_emdash/api/plugins/dashcommerce/checkout/webhook?provider=mercadopago",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-mercadopago-signature": signatureHeader,
					},
					body,
				},
			);

			// Invoke the core handler directly with a merged ctx: the core
			// handler expects (routeCtx, ctx) — we pass an object carrying
			// the internal request plus this route's plugin context.
			const coreWebhook = coreWebhookHandler;
			const response = await coreWebhook(
				{
					...ctx,
					request: internalRequest,
					input: JSON.parse(body),
				},
				ctx,
			);
			// The core handler returns a plain `Response` (its own contract
			// predates pluginResponse). Unwrap it into the raw wire format
			// so the status and body survive the dispatch layer.
			const text = await response.text();
			return rawJson(JSON.parse(text), response.status);
		},
	},
} as const;

/**
 * ADMIN: Mercado Pago settings management.
 *
 * GET  → { isSet, hint } for each secret — values are NEVER returned.
 * POST → { mercadopagoSecretKey?, mercadopagoWebhookSecret? } with prefix
 *        validation. Values starting with the masked sentinel are skipped
 *        (form was submitted without editing that field).
 *
 * Non-raw route: returns plain JSON objects; errors are thrown as
 * PluginRouteError so the registry maps them to proper status codes.
 */
export const mercadopagoAdminRoutes = {
	"admin/mercadopago/settings": {
		handler: async (ctx: PluginRouteContext) => {
			if (ctx.request.method === "POST") {
				const body = (ctx.input ?? {}) as Record<string, unknown>;
				const updates: { key: string; value: string }[] = [];
				const deletes: string[] = [];

				for (const [key, rawValue] of Object.entries(body)) {
					if (key !== "mercadopagoSecretKey" && key !== "mercadopagoWebhookSecret") {
						throw new PluginRouteError("BAD_REQUEST", `Unknown key: ${key}`, 400);
					}
					if (typeof rawValue !== "string") {
						throw new PluginRouteError("BAD_REQUEST", `${key} must be a string`, 400);
					}
					// Masked sentinel → user didn't edit this field; skip.
					if (rawValue.startsWith(MASKED_SECRET_PREFIX)) continue;
					// Delete flag: explicit removal of a configured secret.
					if (rawValue === DELETE_FLAG) {
						deletes.push(key);
						continue;
					}
					if (rawValue.length === 0) {
						throw new PluginRouteError(
							"BAD_REQUEST",
							`${key} cannot be empty — send "${DELETE_FLAG}" to remove it`,
							400,
						);
					}
					if (key === "mercadopagoSecretKey" && !MP_TOKEN_PREFIXES.some((p) => rawValue.startsWith(p))) {
						throw new PluginRouteError(
							"BAD_REQUEST",
							`mercadopagoSecretKey must start with ${MP_TOKEN_PREFIXES.join(" or ")}`,
							400,
						);
					}
					if (key === "mercadopagoWebhookSecret" && rawValue.length < MIN_WEBHOOK_SECRET_LENGTH) {
						throw new PluginRouteError(
							"BAD_REQUEST",
							`mercadopagoWebhookSecret must be at least ${MIN_WEBHOOK_SECRET_LENGTH} chars`,
							400,
						);
					}
					updates.push({ key, value: rawValue });
				}

				for (const key of deletes) {
					await ctx.kv.delete(`settings:${key}`);
				}
				for (const { key, value } of updates) {
					// settings:* keys flow through emdash's settings access →
					// AES-GCM encryption for keys declared type:"secret" in
					// the wrapper's settingsSchema.
					await ctx.kv.set(`settings:${key}`, value);
				}
				return { ok: true, ...(deletes.length ? { deleted: deletes } : {}) };
			}

			// GET — report isSet/hint only. Never the values.
			const accessToken = (await ctx.kv.get("settings:mercadopagoSecretKey")) as
				| string
				| null;
			const webhookSecret = (await ctx.kv.get("settings:mercadopagoWebhookSecret")) as
				| string
				| null;
			const paymentProvider = (await ctx.kv.get("settings:paymentProvider")) as
				| string
				| null;
			return {
				providerId: MERCADOPAGO_PROVIDER_ID,
				paymentProvider,
				_secrets: {
					mercadopagoSecretKey: {
						isSet: typeof accessToken === "string" && accessToken.length > 0,
						hint: accessToken ? secretHint(accessToken) : null,
					},
					mercadopagoWebhookSecret: {
						isSet: typeof webhookSecret === "string" && webhookSecret.length > 0,
						hint: webhookSecret ? secretHint(webhookSecret) : null,
					},
				},
			};
		},
	},
} as const;
