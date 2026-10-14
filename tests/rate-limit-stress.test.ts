/**
 * Stress test for the MP webhook rate limit (30 req/min/IP, H-6).
 *
 * Verifies:
 *   - The first 30 requests in a window pass (no 429).
 *   - Request 31+ gets 429 with a generic body.
 *   - A DIFFERENT IP is unaffected (per-IP isolation).
 *   - The window rotates: after the 60s window passes, requests flow
 *     again (simulated by computing the next window's key directly).
 *   - The 429 body is generic (no internal details).
 */
import { describe, expect, test } from "bun:test";
import { mercadopagoWebhookRoutes } from "../src/routes.js";
import type { PluginRouteContext } from "../src/types.js";

class FakeKV {
	store = new Map<string, unknown>();
	async get(key: string): Promise<unknown> { return this.store.get(key); }
	async set(key: string, value: unknown): Promise<void> { this.store.set(key, value); }
	async delete(key: string): Promise<void> { this.store.delete(key); }
}

class LogCollector {
	entries: { level: string; message: string; meta?: Record<string, unknown> }[] = [];
	info(message: string, meta?: Record<string, unknown>) { this.entries.push({ level: "info", message, meta }); }
	warn(message: string, meta?: Record<string, unknown>) { this.entries.push({ level: "warn", message, meta }); }
	error(message: string, meta?: Record<string, unknown>) { this.entries.push({ level: "error", message, meta }); }
}

function makeCtx(ip: string, kv: FakeKV): PluginRouteContext {
	return {
		request: new Request("http://localhost/hook", { method: "POST" }),
		kv,
		http: { fetch: async () => new Response("{}", { status: 200 }) },
		log: new LogCollector(),
	} as unknown as PluginRouteContext & { request: Request & { headers: Headers } };
}

/** Patch headers onto the Request after creation (Request is immutable). */
function ctxWithIp(ip: string, kv: FakeKV): PluginRouteContext {
	// MP credentials must be configured — the handler checks them BEFORE
	// the data.id validation (500 otherwise, which would mask the rate
	// limit behavior we're testing).
	kv.store.set("settings:mercadopagoSecretKey", "TEST-token-123");
	kv.store.set("settings:mercadopagoWebhookSecret", "dev-placeholder-secret-2026");
	const headers = new Headers({ "cf-connecting-ip": ip });
	const request = new Request("http://localhost/hook", { method: "POST", headers });
	return {
		request,
		kv,
		http: { fetch: async () => new Response("{}", { status: 200 }) },
		log: new LogCollector(),
	} as unknown as PluginRouteContext;
}

async function unwrap(result: unknown): Promise<{ status: number; body: string }> {
	const r = result as { status?: number; body?: { value?: string } };
	return { status: r.status ?? 0, body: r.body?.value ?? "" };
}

const route = mercadopagoWebhookRoutes["checkout/webhook-mercadopago"];
const handler = (route as { handler: (ctx: PluginRouteContext) => Promise<unknown> }).handler;

describe("MP webhook rate limit — stress", () => {
	test("requests 1-30 pass, 31+ get 429, different IP unaffected, body generic", async () => {
		const kv = new FakeKV();
		// Fire 35 requests from the same IP. Requests 1-30 pass the rate
		// limit (they then fail on missing data.id with 400 — that's fine,
		// the point is they were NOT rate-limited). 31+ must be 429.
		const statuses: number[] = [];
		for (let i = 0; i < 35; i++) {
			const result = await handler(ctxWithIp("203.0.113.50", kv));
			const { status } = await unwrap(result);
			statuses.push(status);
		}
		const first30 = statuses.slice(0, 30);
		const last5 = statuses.slice(30);
		// First 30: rate limit did not trigger (they're 400 missing data.id).
		expect(first30.every((s) => s === 400)).toBe(true);
		// Last 5: all rate-limited with 429.
		expect(last5.every((s) => s === 429)).toBe(true);
		// The 429 body is generic:
		const result = await handler(ctxWithIp("203.0.113.50", kv));
		const { body } = await unwrap(result);
		expect(body).toContain("Too many requests");
		expect(body).not.toContain("state:mpWebhookRate");
	});

	test("per-IP isolation: a different IP is not blocked by another IP's flood", async () => {
		const kv = new FakeKV();
		// Flood from IP A.
		for (let i = 0; i < 35; i++) {
			await handler(ctxWithIp("198.51.100.10", kv));
		}
		// IP B must still pass the rate limit (gets 400 missing data.id,
		// NOT 429).
		const result = await handler(ctxWithIp("198.51.100.99", kv));
		const { status } = await unwrap(result);
		expect(status).toBe(400);
	});

	test("window rotation: a new 60s window resets the counter", async () => {
		const kv = new FakeKV();
		// Exhaust the current window.
		for (let i = 0; i < 35; i++) {
			await handler(ctxWithIp("192.0.2.1", kv));
		}
		const blocked = await unwrap(await handler(ctxWithIp("192.0.2.1", kv)));
		expect(blocked.status).toBe(429);
		// Simulate time passing: delete the current window's counter key.
		// (In production the window key changes each 60s; the stale key
		// self-expires by rotation. We emulate rotation by clearing it.)
		const windowStart = Math.floor(Date.now() / 60_000);
		await kv.delete(`state:mpWebhookRate:192.0.2.1:${windowStart}`);
		const after = await unwrap(await handler(ctxWithIp("192.0.2.1", kv)));
		expect(after.status).toBe(400); // not 429 — window rotated
	});
});

// ---------------------------------------------------------------------------
// BUG-003 regression (GAP-3): stale rate-limit counters must be swept.
// emdash's plugin KV has no TTL — without a sweep, every IP×window counter
// lives forever, and a spoofed-IP flood grows the options table unboundedly
// (gradual DoS on the shared KV). The sweep runs on the FIRST request of a
// new window for an IP (once per window — off the per-request hot path).
// ---------------------------------------------------------------------------
class FakeKVWithList extends FakeKV {
	async list(keyPrefix: string): Promise<Array<{ key: string; value: unknown }>> {
		const out: Array<{ key: string; value: unknown }> = [];
		for (const [key, value] of this.store) {
			if (key.startsWith(keyPrefix)) out.push({ key, value });
		}
		return out;
	}
}

describe("MP webhook rate limit — stale counter sweep (BUG-003)", () => {
	const IP = "203.0.113.7";
	const PREFIX = `state:mpWebhookRate:${IP}:`;

	test("first request of a new window sweeps counters from windows ≤ W-2 (list path)", async () => {
		const kv = new FakeKVWithList();
		const w = Math.floor(Date.now() / 60_000);
		// Stale counters history left behind — these previously lived
		// forever (no TTL in emdash KV).
		kv.store.set(`${PREFIX}${w - 5}`, "30");
		kv.store.set(`${PREFIX}${w - 4}`, "30");
		kv.store.set(`${PREFIX}${w - 3}`, "30");
		// First request in the current window → sweep triggers.
		const result = await handler(ctxWithIp(IP, kv));
		const { status } = await unwrap(result);
		expect(status).toBe(400); // admitted (fails later on missing data.id)
		// Stale counters are gone…
		expect(kv.store.has(`${PREFIX}${w - 5}`)).toBe(false);
		expect(kv.store.has(`${PREFIX}${w - 4}`)).toBe(false);
		expect(kv.store.has(`${PREFIX}${w - 3}`)).toBe(false);
		// …while the current window's counter is alive.
		expect(kv.store.has(`${PREFIX}${w}`)).toBe(true);
	});

	test("keeps the previous window's counter (retention horizon is ≤ W-2)", async () => {
		const kv = new FakeKVWithList();
		const w = Math.floor(Date.now() / 60_000);
		kv.store.set(`${PREFIX}${w - 1}`, "15");
		const result = await handler(ctxWithIp(IP, kv));
		const { status } = await unwrap(result);
		expect(status).toBe(400);
		// W-1 is within the retention horizon — NOT swept.
		expect(kv.store.has(`${PREFIX}${w - 1}`)).toBe(true);
	});

	test("without list(): still deletes the W-2 counter (fallback path)", async () => {
		const kv = new FakeKV(); // minimal KV — no list()
		const w = Math.floor(Date.now() / 60_000);
		kv.store.set(`${PREFIX}${w - 2}`, "30");
		const result = await handler(ctxWithIp(IP, kv));
		const { status } = await unwrap(result);
		expect(status).toBe(400);
		expect(kv.store.has(`${PREFIX}${w - 2}`)).toBe(false);
	});
});
