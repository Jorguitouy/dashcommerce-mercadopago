/**
 * Concurrency tests for the ATOMIC primitives added in the audit response
 * (SEC-001 refund lock, SEC-002 rate limiter).
 *
 * The FakeKV here implements emdash's CAS contract faithfully:
 *   - compareAndSet(key, null, v)   → INSERT … ON CONFLICT DO NOTHING
 *   - compareAndSet(key, rev, v)   → UPDATE … WHERE revision = rev
 *   - compareAndDelete(key, rev)   → DELETE … WHERE revision = rev
 *   - getVersioned(key)            → { value, revision } | null
 *
 * These tests PROVE the races the auditor flagged are closed on the
 * atomic path:
 *   SEC-001: two concurrent refunds for the same payment — exactly one
 *            reaches MP; the other is rejected. No check-then-write
 *            window exists.
 *   SEC-001: stale-lock takeover is itself race-free — two simultaneous
 *            thieves cannot both win.
 *   SEC-002: a concurrent burst cannot push the rate counter past the
 *            limit (no lost increments, no over-admission).
 *   Fallback parity: the plain get/set/delete path still enforces the
 *            documented best-effort semantics.
 */
import { describe, expect, test } from "bun:test";
import { mercadopagoProvider } from "../src/provider.js";
import { mercadopagoWebhookRoutes } from "../src/routes.js";
import type { PluginKV, PluginRouteContext } from "../src/types.js";
import type { CreateRefundInput } from "@dashcommerce/core/payment-provider";

/**
 * In-memory KV with emdash's atomic CAS semantics. Revisions are random
 * UUIDs; every compareAndSet/compareAndDelete is applied synchronously
 * (no await between check and write), mirroring the database-level
 * atomicity of INSERT … ON CONFLICT DO NOTHING / UPDATE … WHERE revision.
 */
class AtomicFakeKV implements PluginKV {
	store = new Map<string, { value: unknown; revision: string }>();
	private rev = 0;

	private nextRevision(): string {
		this.rev++;
		return `rev-${this.rev}-${Math.random().toString(36).slice(2, 8)}`;
	}

	async get(key: string): Promise<unknown> {
		return this.store.get(key)?.value;
	}

	async set(key: string, value: unknown): Promise<void> {
		const existing = this.store.get(key);
		if (existing) {
			existing.value = value;
			existing.revision = this.nextRevision();
		} else {
			this.store.set(key, { value, revision: this.nextRevision() });
		}
	}

	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}

	async compareAndSet(
		key: string,
		expectedRevision: string | null,
		value: unknown,
	): Promise<{ applied: boolean; revision?: string }> {
		const existing = this.store.get(key);
		if (expectedRevision === null) {
			if (existing) return { applied: false };
			const revision = this.nextRevision();
			this.store.set(key, { value, revision });
			return { applied: true, revision };
		}
		if (!existing || existing.revision !== expectedRevision) return { applied: false };
		const revision = this.nextRevision();
		existing.value = value;
		existing.revision = revision;
		return { applied: true, revision };
	}

	async compareAndDelete(
		key: string,
		expectedRevision: string,
	): Promise<{ applied: boolean }> {
		const existing = this.store.get(key);
		if (!existing || existing.revision !== expectedRevision) return { applied: false };
		this.store.delete(key);
		return { applied: true };
	}

	async getVersioned(key: string): Promise<{ value: unknown; revision: string } | null> {
		return this.store.get(key) ?? null;
	}
}

const CREDENTIALS = { secretKey: "TEST-mp-concurrency" } as never;

function refundInput(overrides: Partial<CreateRefundInput> = {}): CreateRefundInput {
	return {
		paymentReference: "987654321",
		refundRequestId: "refund:order-c:base",
		amount: 5000,
		currency: "uyu",
		...overrides,
	};
}

function makeCtx(
	kv: PluginKV,
	fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>,
) {
	return {
		kv,
		http: {
			fetch:
				fetchImpl ??
				(async () =>
					new Response(JSON.stringify({ id: "mp-rfd", status: "approved", amount: "50.00" }), {
						status: 200,
						headers: { "content-type": "application/json" },
					})),
		},
		log: { info: () => {}, warn: () => {}, error: () => {} },
	} as unknown as Parameters<typeof mercadopagoProvider.refund>[0];
}

describe("SEC-001 — atomic refund lock (CAS path)", () => {
	test("two SIMULTANEOUS refunds for the same payment: exactly one reaches MP", async () => {
		const kv = new AtomicFakeKV();
		let mpCalls = 0;
		const ctx = makeCtx(kv, async () => {
			mpCalls++;
			// No gate: the winner completes its MP call normally. The
			// loser must be rejected at ACQUISITION time — before any
			// MP call — which is exactly what the atomic lock buys.
			return new Response(JSON.stringify({ id: "mp-rfd-c1", status: "approved", amount: "50.00" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		// Fire BOTH refunds with zero await in between — the exact
		// concurrent double-click the auditor described. Both hit the
		// lock acquisition "at the same time".
		const outcomes = await Promise.allSettled([
			mercadopagoProvider.refund(ctx, refundInput(), CREDENTIALS),
			mercadopagoProvider.refund(
				ctx,
				refundInput({ refundRequestId: "refund:order-c:second-click" }),
				CREDENTIALS,
			),
		]);

		// Exactly one succeeded; the other was rejected with the
		// in-progress error. The winner's MP call was made exactly once.
		const results = outcomes.map((r) =>
			r.status === "fulfilled" ? "ok" : (r.reason as Error).message,
		);
		const successes = results.filter((o) => o === "ok").length;
		const rejections = results.filter((o) => o.includes("already in progress")).length;
		expect(successes).toBe(1);
		expect(rejections).toBe(1);
		expect(mpCalls).toBe(1);
	});

	test("stale-lock takeover is race-free: two simultaneous thieves, one wins", async () => {
		const kv = new AtomicFakeKV();
		// Crash leftover: lock written 60s ago by a dead request.
		await kv.set("mp:refund:lock:987654321", {
			at: new Date(Date.now() - 60_000).toISOString(),
			refundRequestId: "refund:order-c:dead",
		});

		let mpCalls = 0;
		const ctx = makeCtx(kv, async () => {
			mpCalls++;
			// No gate: the winning thief completes normally; the losing
			// thief is rejected at CAS-steal time.
			return new Response(JSON.stringify({ id: "mp-rfd-c2", status: "approved", amount: "50.00" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const outcomes = await Promise.allSettled([
			mercadopagoProvider.refund(
				ctx,
				refundInput({ refundRequestId: "refund:order-c:thief-a" }),
				CREDENTIALS,
			),
			mercadopagoProvider.refund(
				ctx,
				refundInput({ refundRequestId: "refund:order-c:thief-b" }),
				CREDENTIALS,
			),
		]);

		const successes = outcomes.filter((r) => r.status === "fulfilled").length;
		expect(successes).toBe(1); // CAS steal: exactly one thief wins
		expect(mpCalls).toBe(1);
	});

	test("slow winner does not delete a stolen lock (CAS release)", async () => {
		const kv = new AtomicFakeKV();
		let releaseSlow: (() => void) | undefined;
		const ctx = makeCtx(kv, async () => {
			await new Promise<void>((resolve) => (releaseSlow = resolve));
			return new Response(JSON.stringify({ id: "mp-rfd-c3", status: "approved", amount: "50.00" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const slow = mercadopagoProvider.refund(ctx, refundInput(), CREDENTIALS);
		await Bun.sleep(10);
		// Steal the lock directly (simulating the 30s stale takeover by
		// an operator-driven retry after a genuinely stuck call).
		await kv.set("mp:refund:lock:987654321", {
			at: new Date().toISOString(),
			refundRequestId: "refund:order-c:new-owner",
		});
		releaseSlow?.();
		await slow;

		const current = (await kv.get("mp:refund:lock:987654321")) as {
			refundRequestId: string;
		};
		// The slow request's release MUST NOT have removed the new
		// owner's lock (its revision no longer matches).
		expect(current?.refundRequestId).toBe("refund:order-c:new-owner");
	});

	test("plain-KV fallback still rejects a concurrent double-click (best-effort)", async () => {
		// Fallback path: KV WITHOUT CAS methods — the documented
		// best-effort semantics must still hold for the sequential case.
		class PlainFakeKV implements PluginKV {
			store = new Map<string, unknown>();
			async get(key: string): Promise<unknown> { return this.store.get(key); }
			async set(key: string, value: unknown): Promise<void> { this.store.set(key, value); }
			async delete(key: string): Promise<void> { this.store.delete(key); }
		}
		const kv = new PlainFakeKV();
		let releaseFetch: (() => void) | undefined;
		const ctx = makeCtx(kv, async () => {
			await new Promise<void>((resolve) => (releaseFetch = resolve));
			return new Response(JSON.stringify({ id: "mp-rfd-c4", status: "approved", amount: "50.00" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const first = mercadopagoProvider.refund(ctx, refundInput(), CREDENTIALS);
		await Bun.sleep(10); // first acquires the lock
		let secondError: Error | undefined;
		try {
			await mercadopagoProvider.refund(
				ctx,
				refundInput({ refundRequestId: "refund:order-c:late-click" }),
				CREDENTIALS,
			);
		} catch (err) {
			secondError = err as Error;
		}
		releaseFetch?.();
		await first;
		expect(secondError?.message).toContain("already in progress");
	});
});

describe("SEC-002 — atomic rate limiter (CAS path)", () => {
	const route = mercadopagoWebhookRoutes["checkout/webhook-mercadopago"];
	const handler = (route as { handler: (ctx: PluginRouteContext) => Promise<unknown> }).handler;

	function ctxWithIp(ip: string, kv: PluginKV): PluginRouteContext {
		const headers = new Headers({ "cf-connecting-ip": ip });
		const request = new Request("http://localhost/hook", { method: "POST", headers });
		return {
			request,
			kv,
			http: { fetch: async () => new Response("{}", { status: 200 }) },
			log: { info: () => {}, warn: () => {}, error: () => {} },
		} as unknown as PluginRouteContext;
	}

	async function unwrap(result: unknown): Promise<{ status: number; body: string }> {
		const r = result as { status?: number; body?: { value?: string } };
		return { status: r.status ?? 0, body: r.body?.value ?? "" };
	}

	test("a concurrent burst of 60 admits exactly 30 (no lost increments)", async () => {
		const kv = new AtomicFakeKV();
		// Credentials present so the handler reaches the data.id check
		// (400) — anything else would mask the rate-limit outcome.
		await kv.set("settings:mercadopagoSecretKey", "TEST-token-conc");
		await kv.set("settings:mercadopagoWebhookSecret", "conc-secret-1234");

		// Fire 60 requests CONCURRENTLY — the exact race the auditor
		// flagged (read-then-write losing increments).
		const results = await Promise.all(
			Array.from({ length: 60 }, () =>
				handler(ctxWithIp("203.0.113.77", kv)).then(unwrap),
			),
		);
		const admitted = results.filter((r) => r.status === 400).length;
		const limited = results.filter((r) => r.status === 429).length;
		expect(admitted).toBe(30);
		expect(limited).toBe(30);
	});

	test("counter is exactly 30 after the burst (no over/under-count)", async () => {
		const kv = new AtomicFakeKV();
		await kv.set("settings:mercadopagoSecretKey", "TEST-token-conc");
		await kv.set("settings:mercadopagoWebhookSecret", "conc-secret-1234");
		await Promise.all(
			Array.from({ length: 60 }, () => handler(ctxWithIp("198.51.100.77", kv))),
		);
		const windowStart = Math.floor(Date.now() / 60_000);
		const counter = (await kv.get(`state:mpWebhookRate:198.51.100.77:${windowStart}`)) as number;
		expect(counter).toBe(30);
	});
});
