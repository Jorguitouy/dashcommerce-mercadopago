/**
 * Tests for the admin MP settings route (admin/mercadopago/settings).
 *
 * Covers: GET never returns secret values (only isSet/hint), POST
 * validates prefixes/length, masked-sentinel skip, the __DELETE__ flag
 * (previously referenced in an error message but not implemented),
 * unknown-key rejection, and empty-value rejection.
 */
import { describe, expect, test } from "bun:test";
import { mercadopagoAdminRoutes } from "../src/routes.js";
import type { PluginRouteContext } from "../src/types.js";

/** In-memory KV. */
class FakeKV {
	store = new Map<string, unknown>();
	async get(key: string): Promise<unknown> { return this.store.get(key); }
	async set(key: string, value: unknown): Promise<void> { this.store.set(key, value); }
	async delete(key: string): Promise<void> { this.store.delete(key); }
}

function makeCtx(
	method: "GET" | "POST",
	input?: unknown,
	kv = new FakeKV(),
): { ctx: PluginRouteContext; kv: FakeKV } {
	return {
		ctx: {
			request: new Request("http://localhost/x", { method }),
			input,
			kv,
			log: { info: () => {}, warn: () => {}, error: () => {} },
		} as unknown as PluginRouteContext,
		kv,
	};
}

const MASKED_PREFIX = "••••";

async function callSettings(
	method: "GET" | "POST",
	input?: unknown,
	kv?: FakeKV,
): Promise<unknown> {
	const { ctx } = makeCtx(method, input, kv);
	const route = mercadopagoAdminRoutes["admin/mercadopago/settings"];
	// The handler is (ctx) => … in the route entry.
	const handler = (route as { handler: (ctx: PluginRouteContext) => Promise<unknown> }).handler;
	return handler(ctx);
}

describe("admin/mercadopago/settings", () => {
	test("GET returns isSet/hint only — never secret values", async () => {
		const kv = new FakeKV();
		kv.store.set("settings:mercadopagoSecretKey", "TEST-abcdef1234567890");
		kv.store.set("settings:mercadopagoWebhookSecret", "supersecret-webhook-2026");
		const result = await callSettings("GET", undefined, kv) as Record<string, unknown>;

		const secrets = result._secrets as Record<string, { isSet: boolean; hint: string }>;
		expect(secrets.mercadopagoSecretKey.isSet).toBe(true);
		expect(secrets.mercadopagoSecretKey.hint).toBe("TEST…21 chars");
		expect(JSON.stringify(result)).not.toContain("abcdef1234567890");
		expect(JSON.stringify(result)).not.toContain("supersecret");
	});

	test("GET with nothing configured reports isSet false, hint null", async () => {
		const result = await callSettings("GET") as Record<string, unknown>;
		const secrets = result._secrets as Record<string, { isSet: boolean; hint: string | null }>;
		expect(secrets.mercadopagoSecretKey.isSet).toBe(false);
		expect(secrets.mercadopagoSecretKey.hint).toBeNull();
	});

	test("POST stores valid secrets", async () => {
		const kv = new FakeKV();
		const result = await callSettings("POST", {
			mercadopagoSecretKey: "TEST-xyz987654321",
			mercadopagoWebhookSecret: "a-valid-secret-1",
		}, kv) as Record<string, unknown>;
		expect(result.ok).toBe(true);
		expect(kv.store.get("settings:mercadopagoSecretKey")).toBe("TEST-xyz987654321");
		expect(kv.store.get("settings:mercadopagoWebhookSecret")).toBe("a-valid-secret-1");
	});

	test("POST rejects a secret key without TEST-/APP_USR- prefix", async () => {
		let error: Error & { status?: number } | undefined;
		try {
			await callSettings("POST", { mercadopagoSecretKey: "PROD-notallowed" });
		} catch (err) {
			error = err as Error & { status?: number };
		}
		expect(error?.message).toContain("must start with");
	});

	test("POST rejects a short webhook secret", async () => {
		let error: Error | undefined;
		try {
			await callSettings("POST", { mercadopagoWebhookSecret: "short" });
		} catch (err) {
			error = err as Error;
		}
		expect(error?.message).toContain("at least 8");
	});

	test("POST rejects unknown keys", async () => {
		let error: Error | undefined;
		try {
			await callSettings("POST", { evilKey: "whatever" });
		} catch (err) {
			error = err as Error;
		}
		expect(error?.message).toContain("Unknown key");
	});

	test("POST skips masked-sentinel values (field untouched)", async () => {
		const kv = new FakeKV();
		kv.store.set("settings:mercadopagoSecretKey", "TEST-original-value");
		await callSettings("POST", {
			mercadopagoSecretKey: `${MASKED_PREFIX} (unchanged)`,
		}, kv);
		expect(kv.store.get("settings:mercadopagoSecretKey")).toBe("TEST-original-value");
	});

	test("POST __DELETE__ flag removes the secret (previously unimplemented)", async () => {
		const kv = new FakeKV();
		kv.store.set("settings:mercadopagoSecretKey", "TEST-to-be-deleted");
		kv.store.set("settings:mercadopagoWebhookSecret", "also-deleted-123");
		const result = await callSettings("POST", {
			mercadopagoSecretKey: "__DELETE__",
			mercadopagoWebhookSecret: "__DELETE__",
		}, kv) as Record<string, unknown>;

		expect(result.ok).toBe(true);
		expect((result.deleted as string[]).sort()).toEqual([
			"mercadopagoSecretKey",
			"mercadopagoWebhookSecret",
		]);
		expect(kv.store.has("settings:mercadopagoSecretKey")).toBe(false);
		expect(kv.store.has("settings:mercadopagoWebhookSecret")).toBe(false);
	});

	test("POST __DELETE__ on an unset secret is a no-op (kv.delete of missing key)", async () => {
		const kv = new FakeKV();
		const result = await callSettings("POST", {
			mercadopagoSecretKey: "__DELETE__",
		}, kv) as Record<string, unknown>;
		expect(result.ok).toBe(true);
		expect(kv.store.size).toBe(0);
	});

	test("POST empty string still rejected with pointer to the delete flag", async () => {
		let error: Error | undefined;
		try {
			await callSettings("POST", { mercadopagoSecretKey: "" });
		} catch (err) {
			error = err as Error;
		}
		expect(error?.message).toContain("__DELETE__");
		expect(error?.message).toContain("cannot be empty");
	});

	test("POST combines delete of one secret with update of the other", async () => {
		const kv = new FakeKV();
		kv.store.set("settings:mercadopagoSecretKey", "TEST-old-token");
		kv.store.set("settings:mercadopagoWebhookSecret", "old-webhook-secret");
		const result = await callSettings("POST", {
			mercadopagoSecretKey: "__DELETE__",
			mercadopagoWebhookSecret: `${MASKED_PREFIX} unchanged`,
		}, kv) as Record<string, unknown>;

		expect(result.ok).toBe(true);
		expect(kv.store.has("settings:mercadopagoSecretKey")).toBe(false);
		expect(kv.store.get("settings:mercadopagoWebhookSecret")).toBe("old-webhook-secret");
	});
});
