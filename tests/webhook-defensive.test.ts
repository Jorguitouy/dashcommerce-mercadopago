/**
 * Tests for the defensive try/catch in the MP webhook route handler.
 *
 * verifyMpWebhook ALREADY catches its own live-retrieve failures (502),
 * so the route-level try/catch protects what verifyMpWebhook does NOT
 * catch: the KV draft read (line ~180 of webhook.ts), the binding-check
 * helpers, and any future code added to the pipeline. These tests force
 * failures at those unprotected stages:
 *   - KV get('draft:…') throwing (database corruption)
 *   - and pin the pre-existing early exits (502 live-retrieve, 400
 *     missing data.id) so the ordering stays intact.
 */
import { describe, expect, test } from "bun:test";
import { mercadopagoWebhookRoutes } from "../src/routes.js";
import type { PluginRouteContext } from "../src/types.js";

const WEBHOOK_SECRET = "dev-placeholder-secret-2026";

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

/** Build a valid MP x-signature for the given dataId/requestId/secret. */
async function sign(dataId: string, requestId: string, secret: string): Promise<string> {
	const ts = String(Math.floor(Date.now() / 1000));
	const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(manifest));
	let hex = "";
	for (const b of new Uint8Array(sig)) hex += b.toString(16).padStart(2, "0");
	return `ts=${ts},v1=${hex}`;
}

/** A realistic approved MP payment payload (live-retrieve response). */
function mpPayment(dataId: string, extRef: string): Record<string, unknown> {
	return {
		id: Number(dataId),
		status: "approved",
		status_detail: "accredited",
		transaction_amount: "34.99",
		currency_id: "UYU",
		external_reference: extRef,
		payer: { email: "buyer@example.com" },
	};
}

function makeCtx(opts: {
	kv?: FakeKV;
	fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
	log?: LogCollector;
	request?: Request;
}): { ctx: PluginRouteContext; log: LogCollector; kv: FakeKV } {
	const kv = opts.kv ?? new FakeKV();
	kv.store.set("settings:mercadopagoSecretKey", "TEST-token-123");
	kv.store.set("settings:mercadopagoWebhookSecret", WEBHOOK_SECRET);
	const log = opts.log ?? new LogCollector();
	const ctx = {
		request: opts.request ?? new Request("http://localhost/x?id=123", { method: "POST" }),
		kv,
		http: { fetch: opts.fetchImpl ?? (async () => new Response("{}", { status: 200 })) },
		log,
	} as unknown as PluginRouteContext;
	return { ctx, log, kv };
}

async function unwrap(result: unknown): Promise<{ status: number; body: string }> {
	const r = result as { status?: number; body?: { value?: string } };
	return { status: r.status ?? 0, body: r.body?.value ?? "" };
}

const route = mercadopagoWebhookRoutes["checkout/webhook-mercadopago"];
const handler = (route as { handler: (ctx: PluginRouteContext) => Promise<unknown> }).handler;

async function signedRequest(dataId: string): Promise<Request> {
	const sig = await sign(dataId, "req-test-1", WEBHOOK_SECRET);
	return new Request(`http://localhost/hook?data.id=${dataId}`, {
		method: "POST",
		headers: { "x-signature": sig, "x-request-id": "req-test-1" },
	});
}

describe("checkout/webhook-mercadopago — defensive try/catch", () => {
	test("KV corruption during draft read → 500 generic body, structured log with paymentId, no leak", async () => {
		const request = await signedRequest("42");
		const kv = new FakeKV();
		const { ctx, log } = makeCtx({
			kv,
			request,
			// Live-retrieve succeeds with a valid approved payment…
			fetchImpl: async () => new Response(JSON.stringify(mpPayment("42", "draft-abc-123")), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		});
		// …but the DRAFT read throws (corruption) — this is the unprotected
		// stage the route-level try/catch guards.
		const originalGet = kv.get.bind(kv);
		kv.get = async (key: string) => {
			if (key.startsWith("draft:")) throw new Error("SQLITE_CORRUPT: database disk image malformed");
			return originalGet(key);
		};
		const result = await handler(ctx);
		const { status, body } = await unwrap(result);

		expect(status).toBe(500);
		expect(body).toContain("Webhook processing failed");
		expect(body).not.toContain("SQLITE");
		expect(body).not.toContain("database disk");
		const errEntry = log.entries.find((e) => e.message === "MP webhook internal failure");
		expect(errEntry).toBeDefined();
		expect((errEntry?.meta?.paymentId as string)).toBe("42");
		expect(String(errEntry?.meta?.error)).toContain("SQLITE_CORRUPT");
	});

	test("network failure during live-retrieve → 502 from verifyMpWebhook (pre-existing, MP retries)", async () => {
		const request = await signedRequest("1359999999");
		const { ctx, log } = makeCtx({
			fetchImpl: async () => { throw new Error("ECONNRESET to api.mercadopago.com"); },
			request,
		});
		const result = await handler(ctx);
		const { status, body } = await unwrap(result);

		// verifyMpWebhook catches this itself → 502, NOT the route's 500.
		expect(status).toBe(502);
		expect(body).toContain("Live retrieve failed");
		// Structured log from verifyMpWebhook's own catch:
		const errEntry = log.entries.find((e) => e.message === "MP live-retrieve failed");
		expect(errEntry).toBeDefined();
		expect((errEntry?.meta?.dataId as string)).toBe("1359999999");
	});

	test("missing data.id → 400 before anything else (ordering pinned)", async () => {
		const { ctx } = makeCtx({
			fetchImpl: async () => { throw new Error("boom"); },
			request: new Request("http://localhost/hook", { method: "POST" }),
		});
		const result = await handler(ctx);
		const { status, body } = await unwrap(result);
		expect(status).toBe(400);
		expect(body).toContain("Missing data.id");
	});
});
