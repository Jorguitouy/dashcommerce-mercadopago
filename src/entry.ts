/**
 * Mercado Pago wrapper entrypoint for DashCommerce.
 *
 * ARCHITECTURE (see docs/payments/MERCADOPAGO_ARCHITECTURE.md):
 *
 * DashCommerce's plugin descriptor points at `@dashcommerce/core/sandbox`,
 * whose `createPlugin(options)` builds the ResolvedPlugin (id "dashcommerce").
 * emdash's `generatePluginsModule` imports `createPlugin` from the
 * descriptor's `entrypoint` and calls it with the descriptor's `options`.
 *
 * This module is a DROP-IN REPLACEMENT for that entrypoint:
 *   - It re-exports `createPlugin` (same contract, synchronous), but the
 *     returned ResolvedPlugin additionally:
 *       1. Registers the `mercadopago` PaymentProvider in the shared
 *          registry (import-time side effect — the same mechanism sibling
 *          packages are expected to use).
 *       2. Merges the MP wrapper routes into the core's route map
 *          (`checkout/webhook-mercadopago`, `admin/mercadopago/settings`).
 *       3. Extends `allowedHosts` with `api.mercadopago.com` (the ONLY
 *          additional host; Stripe hosts are preserved).
 *       4. Declares `admin.settingsSchema` with the MP secrets so emdash
 *          encrypts them at rest (AES-GCM via EMDASH_ENCRYPTION_KEY) and
 *          the plugin-manager settings UI can render them.
 *
 * Because the plugin id stays "dashcommerce", the plugin keeps the SAME
 * KV namespace, storage collections, admin pages, and settings — there is
 * exactly ONE plugin instance, not two.
 *
 * NO IMPORT CYCLES: this module imports the core entrypoint (default
 * export {hooks, routes}), the provider registry, and the MP adapter
 * modules. routes.ts does NOT import this file — it imports the core's
 * `checkout/webhook` handler from `@dashcommerce/core/sandbox` directly
 * (the same module instance the bundler resolves for this entrypoint).
 */
import coreEntry, { createPlugin as coreCreatePlugin } from "@dashcommerce/core/sandbox";
import {
	registerPaymentProvider,
	getPaymentProvider,
} from "@dashcommerce/core/payment-provider";
import { mercadopagoProvider, MERCADOPAGO_PROVIDER_ID } from "./provider.js";
import type { PaymentProvider } from "@dashcommerce/core/payment-provider";
import type { PluginCapability } from "emdash";
import { mercadopagoWebhookRoutes, mercadopagoAdminRoutes } from "./routes.js";
import type { PluginRouteContext } from "./types.js";

// ---------------------------------------------------------------------------
// 1. Register the provider at import time (shared registry with the core).
//
//    DEV-MODE REALITY (verified empirically): Vite evaluates the virtual
//    plugins module once per environment (admin/typegen env + server env),
//    so this module — and therefore `mercadopagoProvider` — is instantiated
//    TWICE with different object identities, while the core's registry
//    (externalized dist JS) is a single shared instance. A naive
//    `existing !== mercadopagoProvider` identity check re-throws on the
//    second evaluation and 500s every request in that environment.
//
//    Idempotency therefore uses a VERSION MARKER: two instances of the same
//    logical adapter module carry the same marker; a foreign provider
//    registered under the same id would NOT have it and still throws.
// ---------------------------------------------------------------------------
const MP_ADAPTER_MARKER = "dashcommerce-mercadopago-adapter-v1";

/** Marker-carrying view of the provider for the idempotency check. */
type MarkerCarrier = { mpAdapterMarker?: string };

const providerWithMarker = mercadopagoProvider as PaymentProvider & MarkerCarrier;
providerWithMarker.mpAdapterMarker = MP_ADAPTER_MARKER;

const alreadyRegistered = getPaymentProvider(MERCADOPAGO_PROVIDER_ID) as
	| (PaymentProvider & MarkerCarrier)
	| undefined;
if (alreadyRegistered) {
	if (alreadyRegistered.mpAdapterMarker === MP_ADAPTER_MARKER) {
		// Same logical adapter already registered (dev dual-eval) — skip.
	} else {
		// The registry holds a provider under OUR id without our marker:
		// either a stale instance from a previous evaluation of this very
		// module (dev HMR keeps the process-level registry alive across
		// module invalidations) or a foreign registration. Either way this
		// wrapper OWNS the "mercadopago" id in this app — replace it
		// explicitly rather than failing every request in that environment.
		registerPaymentProvider(providerWithMarker, { override: true });
	}
} else {
	registerPaymentProvider(providerWithMarker);
}

// ---------------------------------------------------------------------------
// 2. Merged route map (authored two-arg format, exactly like the core's).
//    The core's createPlugin converts everything to native one-arg handlers
//    via its internal toNativeRoutes — we merge BEFORE that conversion by
//    rebuilding the authored map, so the conversion applies uniformly.
// ---------------------------------------------------------------------------

/** The core's `checkout/webhook` handler in authored two-arg format. */
export const coreWebhookHandler = coreEntry.routes["checkout/webhook"].handler as unknown as (
	routeCtx: PluginRouteContext,
	ctx: PluginRouteContext,
) => Promise<Response>;

// ---------------------------------------------------------------------------
// NOTE (emdash@1.2.0 patch, patches/emdash@1.2.0.patch):
//
// The core's route handlers return bare `Response` objects. Upstream emdash
// 1.2.0 serializes those through apiSuccess() into `200 {"success":true,
// "data":{}}`, losing status, body, and Set-Cookie. The DashCommerce patch
// (same approach the core ships for emdash 0.37/1.1) adds a passthrough in
// http-route-dispatch: `if (result.data instanceof Response) return result.data;`
// plus `request.clone().json()` in parseRouteInput so webhook signature
// verification can re-read the raw body.
//
// With the patch applied, the core's routes pass through UNMODIFIED — no
// raw-response wrapping, no session-header injection. The cart session
// cookie (dashcommerce_sid) reaches the browser and works as designed.
// ---------------------------------------------------------------------------

/**
 * Merged authored route map: core routes + MP wrapper routes.
 * Exported for tests; createPlugin below is the only production consumer.
 *
 * Handler signatures are intentionally wide: the core's authored routes use
 * two-arg handlers (routeCtx, ctx) while the MP wrapper routes use single-arg
 * handlers (ctx). createPlugin converts both to native one-arg handlers below.
 */
export const mergedRoutes: Record<string, {
	public?: boolean;
	input?: unknown;
	response?: "json" | "raw";
	handler: (ctx: never, routeCtx?: never) => unknown;
}> = {
	...coreEntry.routes,
	...mercadopagoWebhookRoutes,
	...mercadopagoAdminRoutes,
};

// ---------------------------------------------------------------------------
// 3. Extended allowedHosts — Stripe hosts preserved, MP API added.
// ---------------------------------------------------------------------------
export const MERCADOPAGO_ALLOWED_HOSTS = ["api.mercadopago.com"] as const;

// ---------------------------------------------------------------------------
// 4. Settings schema for the MP secrets. Fields declared type:"secret" are
//    encrypted by emdash (AES-GCM, EMDASH_ENCRYPTION_KEY) and are never
//    returned in cleartext by the plugin settings API.
// ---------------------------------------------------------------------------
export const MERCADOPAGO_SETTINGS_SCHEMA = {
	mercadopagoSecretKey: {
		type: "secret" as const,
		label: "Mercado Pago Access Token",
		description:
			"Access token from the Mercado Pago credentials page (TEST-… for sandbox, APP_USR-… for production).",
	},
	mercadopagoWebhookSecret: {
		type: "secret" as const,
		label: "Mercado Pago Webhook Secret",
		description:
			"Secret key for validating x-signature on webhooks (configured in the MP dashboard webhook section).",
	},
} as const;

// ---------------------------------------------------------------------------
// 5. The wrapper createPlugin — same contract as the core's (SYNCHRONOUS),
//    with MP routes, hosts, and settings schema merged in.
// ---------------------------------------------------------------------------
interface WrapperPluginOptions {
	id?: string;
	version?: string;
	capabilities?: PluginCapability[];
	allowedHosts?: string[];
	emdashVersion?: string;
}

/**
 * Create the DashCommerce plugin WITH Mercado Pago support.
 *
 * Called by emdash's generated plugins module:
 *   `import { createPlugin } from "<this entrypoint>"; createPlugin(options)`
 * where `options` is the descriptor's `options` field (see index.ts factory).
 * MUST be synchronous — emdash does not await the result.
 */
export function createPlugin(options: WrapperPluginOptions = {}) {
	// Reuse the core's createPlugin for full parity (hooks, admin pages,
	// storage config, validation) — then patch the result.
	const plugin = coreCreatePlugin({
		...options,
		// Extend allowedHosts: MP API host + Stripe hosts (already default).
		allowedHosts: Array.from(
			new Set([
				...(options.allowedHosts ?? ["api.stripe.com", "files.stripe.com"]),
				...MERCADOPAGO_ALLOWED_HOSTS,
			]),
		),
	});

	// Merge routes. coreCreatePlugin already converted the core's authored
	// handlers to native one-arg handlers; convert ours identically and
	// append. (Authored two-arg → native: handler(ctx) { return handler(ctx, ctx) }.)
	// The `response` flag MUST be carried over: emdash's dispatch only
	// honors pluginResponse() bodies on routes declared response:"raw".
	type NativeRoute = {
		public?: boolean;
		input?: unknown;
		response?: "json" | "raw";
		handler: (ctx: unknown) => unknown;
	};
	const nativeMpRoutes: Record<string, NativeRoute> = {};
	for (const [name, route] of Object.entries(mercadopagoWebhookRoutes)) {
		nativeMpRoutes[name] = {
			public: route.public,
			...(route.response !== undefined ? { response: route.response } : {}),
			handler: (ctx: unknown) => route.handler(ctx as PluginRouteContext),
		};
	}
	for (const [name, route] of Object.entries(mercadopagoAdminRoutes)) {
		nativeMpRoutes[name] = {
			public: false,
			handler: (ctx: unknown) => route.handler(ctx as PluginRouteContext),
		};
	}
	const pluginAny = plugin as unknown as {
		routes: Record<string, unknown>;
		admin: Record<string, unknown>;
	};
	pluginAny.routes = { ...(pluginAny.routes ?? {}), ...nativeMpRoutes };

	// NOTE: no core-route replacement happens here anymore. The emdash@1.2.0
	// patch (patches/emdash@1.2.0.patch) passes bare `Response` objects from
	// the core's handlers straight through the dispatch layer, so the core's
	// own routes (cart session cookie, checkout, webhook) work unmodified.

	// Declare the MP secrets in the settings schema so emdash encrypts them
	// and the plugin-manager settings UI renders them.
	const existingAdmin = (pluginAny.admin ?? {}) as Record<string, unknown>;
	const existingSchema = (existingAdmin.settingsSchema ?? {}) as Record<string, unknown>;
	pluginAny.admin = {
		...existingAdmin,
		settingsSchema: {
			...existingSchema,
			...MERCADOPAGO_SETTINGS_SCHEMA,
		},
	};

	return plugin;
}

export default createPlugin;
