/**
 * Mercado Pago-enabled DashCommerce plugin descriptor factory.
 *
 * Drop-in replacement for `dashcommerce()` from @dashcommerce/core in
 * `astro.config.mjs`:
 *
 *   import { dashcommerceWithMercadoPago } from "dashcommerce-mercadopago";
 *
 *   emdash({
 *     database: …,
 *     storage:  …,
 *     plugins: [dashcommerceWithMercadoPago()],
 *   });
 *
 * The descriptor is IDENTICAL to the core's (same id "dashcommerce", same
 * version, same capabilities, same storage, same admin pages/widgets, same
 * componentsEntry) with exactly three deltas:
 *
 *   1. `entrypoint` points at this package's entry
 *      (`dashcommerce-mercadopago/entry`) instead of
 *      `@dashcommerce/core/sandbox`.
 *   2. `allowedHosts` adds `api.mercadopago.com` (Stripe hosts preserved).
 *   3. `options.allowedHosts` (serialized to createPlugin) matches.
 *
 * Everything else — capabilities, storage, adminEntry, componentsEntry,
 * adminPages, adminWidgets, fieldWidgets, portableTextBlocks — is copied
 * from the core descriptor so the plugin-manager UI and admin registry
 * behave exactly as before. There is still ONE plugin (id "dashcommerce"):
 * the MP routes/settings live inside it via the wrapper entrypoint.
 */
import { dashcommerce } from "@dashcommerce/core";

/**
 * Create the DashCommerce plugin descriptor WITH Mercado Pago support.
 *
 * Accepts the same options as `dashcommerce()` (currently just `id`).
 */
export function dashcommerceWithMercadoPago(options: { id?: string } = {}) {
	const base = dashcommerce(options);
	return {
		...base,
		entrypoint: "dashcommerce-mercadopago/entry",
		allowedHosts: Array.from(
			new Set([...(base.allowedHosts ?? []), "api.mercadopago.com"]),
		),
		options: {
			...(base.options as Record<string, unknown>),
			allowedHosts: Array.from(
				new Set([
					...((base.options as { allowedHosts?: string[] }).allowedHosts ?? []),
					"api.mercadopago.com",
				]),
			),
		},
	};
}

export { dashcommerceWithMercadoPago as default };
