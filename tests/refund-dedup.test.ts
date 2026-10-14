/**
 * Tests for the KV-backed refund race guard in the MP adapter.
 *
 * Background: the core's refund pipeline generates a fresh random
 * idempotency key per HTTP request, and MP ignores X-Idempotency-Key, so
 * concurrent double-clicks both pass the core's read-before-write
 * `remaining` check. The adapter's refund() now guards with a per-PAYMENT
 * in-flight lock:
 *   mp:refund:lock:{paymentReference} → { at: ISO, refundRequestId }
 *
 * Semantics under test:
 *  - Fresh lock: refund proceeds, MP hit once, lock released.
 *  - Concurrent same-payment refund (different keys!): rejected while
 *    the first is in flight.
 *  - Stale lock (crash leftover, older than 30s): stolen, refund proceeds.
 *  - Ownership: a request does not delete a lock it no longer owns.
 *  - Failure path: lock released, no done marker, retry allowed.
 *  - Different payments never collide.
 */
import { describe, expect, test } from "bun:test";
import { mercadopagoProvider } from "../src/provider.js";
import type { CreateRefundInput, RefundResult } from "@dashcommerce/core/payment-provider";

/** In-memory KV matching the PluginKV subset the adapter relies on. */
class FakeKV {
	store = new Map<string, unknown>();
	async get(key: string): Promise<unknown> {
		return this.store.get(key);
	}
	async set(key: string, value: unknown): Promise<void> {
		this.store.set(key, value);
	}
	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}
}

function makeCtx(kv?: FakeKV, fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>) {
	return {
		kv,
		http: { fetch: fetchImpl ?? (async () => new Response("{}", { status: 200 })) },
		log: { info: () => {}, warn: () => {}, error: () => {} },
	} as unknown as Parameters<typeof mercadopagoProvider.refund>[0];
}

const CREDENTIALS = { secretKey: "TEST-mp-dedup" } as never;

function refundInput(overrides: Partial<CreateRefundInput> = {}): CreateRefundInput {
	return {
		paymentReference: "123456789",
		refundRequestId: "refund:order-1:abc",
		amount: 3499,
		currency: "uyu",
		...overrides,
	};
}

function mpRefundResponse(id: string, status: string, amount: string): Response {
	return new Response(
		JSON.stringify({ id, status, amount, currency_id: "UYU" }),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("mercadopagoProvider.refund — KV race guard (per-payment lock)", () => {
	test("first refund on a fresh payment acquires the lock, hits MP, releases", async () => {
		const kv = new FakeKV();
		let mpCalls = 0;
		const ctx = makeCtx(kv, async () => {
			mpCalls++;
			return mpRefundResponse("mp-rfd-1", "approved", "34.99");
		});
		const result = await mercadopagoProvider.refund(ctx, refundInput(), CREDENTIALS);

		expect(mpCalls).toBe(1);
		expect(result.status).toBe("succeeded");
		expect(result.providerRefundId).toBe("mp-rfd-1");
		expect(result.amount).toBe(3499);
		// Lock released after success.
		expect(kv.store.has("mp:refund:lock:123456789")).toBe(false);
	});

	test("concurrent refund for the SAME payment (different keys) is rejected while in flight", async () => {
		const kv = new FakeKV();
		let releaseFetch: (() => void) | undefined;
		const ctx = makeCtx(kv, async () => {
			await new Promise<void>((resolve) => (releaseFetch = resolve));
			return mpRefundResponse("mp-rfd-2", "approved", "34.99");
		});
		const first = mercadopagoProvider.refund(ctx, refundInput(), CREDENTIALS);
		await Bun.sleep(10); // let the first acquire the lock
		let secondError: Error | undefined;
		try {
			// Double-click → the core would mint a DIFFERENT key; same payment.
			await mercadopagoProvider.refund(
				ctx,
				refundInput({ refundRequestId: "refund:order-1:xyz-different" }),
				CREDENTIALS,
			);
		} catch (err) {
			secondError = err as Error;
		}
		releaseFetch?.();
		await first;

		expect(secondError?.message).toContain("already in progress");
	});

	test("stale lock (crash leftover, >30s old) is stolen and the refund proceeds", async () => {
		const kv = new FakeKV();
		// Simulate a crash leftover: lock written 60s ago by a dead request.
		kv.store.set("mp:refund:lock:123456789", {
			at: new Date(Date.now() - 60_000).toISOString(),
			refundRequestId: "refund:order-1:dead-request",
		});
		let mpCalls = 0;
		const ctx = makeCtx(kv, async () => {
			mpCalls++;
			return mpRefundResponse("mp-rfd-3", "approved", "34.99");
		});
		const result = await mercadopagoProvider.refund(ctx, refundInput(), CREDENTIALS);

		expect(mpCalls).toBe(1);
		expect(result.status).toBe("succeeded");
		expect(kv.store.has("mp:refund:lock:123456789")).toBe(false);
	});

	test("a request does not delete a lock it no longer owns (stolen mid-flight)", async () => {
		const kv = new FakeKV();
		// First request is slow; its lock will be stolen by a "newer" entry.
		let releaseSlow: (() => void) | undefined;
		const ctx = makeCtx(kv, async () => {
			await new Promise<void>((resolve) => (releaseSlow = resolve));
			return mpRefundResponse("mp-rfd-4", "approved", "34.99");
		});
		const slow = mercadopagoProvider.refund(ctx, refundInput(), CREDENTIALS);
		await Bun.sleep(10);
		// Simulate the lock being stolen while the slow call is stuck.
		const thief = "refund:order-1:thief";
		kv.store.set("mp:refund:lock:123456789", {
			at: new Date().toISOString(),
			refundRequestId: thief,
		});
		releaseSlow?.();
		await slow;
		// The slow request must NOT have deleted the thief's lock.
		const lock = kv.store.get("mp:refund:lock:123456789") as { refundRequestId: string };
		expect(lock?.refundRequestId).toBe(thief);
	});

	test("failed MP call releases the lock (no stale lock after failure)", async () => {
		const kv = new FakeKV();
		const ctx = makeCtx(kv, async () =>
			new Response(JSON.stringify({ message: "payment not found" }), {
				status: 404,
				headers: { "content-type": "application/json" },
			}),
		);
		let error: Error | undefined;
		try {
			await mercadopagoProvider.refund(ctx, refundInput(), CREDENTIALS);
		} catch (err) {
			error = err as Error;
		}
		expect(error?.message).toContain("payment not found");
		expect(kv.store.has("mp:refund:lock:123456789")).toBe(false);
	});

	test("missing refundRequestId is rejected before any MP call or KV write", async () => {
		const kv = new FakeKV();
		let mpCalls = 0;
		const ctx = makeCtx(kv, async () => {
			mpCalls++;
			return mpRefundResponse("mp-rfd-5", "approved", "34.99");
		});
		let error: Error | undefined;
		try {
			await mercadopagoProvider.refund(
				ctx,
				refundInput({ refundRequestId: "   " }),
				CREDENTIALS,
			);
		} catch (err) {
			error = err as Error;
		}
		expect(error?.message).toContain("refundRequestId");
		expect(mpCalls).toBe(0);
		expect(kv.store.size).toBe(0);
	});

	test("no KV in ctx falls back to direct MP call (still functional)", async () => {
		let mpCalls = 0;
		const ctx = makeCtx(undefined, async () => {
			mpCalls++;
			return mpRefundResponse("mp-rfd-6", "approved", "34.99");
		});
		const result = await mercadopagoProvider.refund(ctx, refundInput(), CREDENTIALS);
		expect(mpCalls).toBe(1);
		expect(result.status).toBe("succeeded");
	});

	test("different payments never collide (separate locks)", async () => {
		const kv = new FakeKV();
		let mpCalls = 0;
		const mpRefundResponseFor = (id: string) =>
			mpRefundResponse(`mp-rfd-${id}`, "approved", "34.99");
		// Gate that the fetch mocks await; opened AFTER both refunds are
		// in flight, so both locks are held simultaneously.
		let openGate!: () => void;
		const gate = new Promise<void>((resolve) => (openGate = resolve));
		const ctxA = makeCtx(kv, async () => {
			await gate;
			mpCalls++;
			return mpRefundResponseFor("A");
		});
		const ctxB = makeCtx(kv, async () => {
			await gate;
			mpCalls++;
			return mpRefundResponseFor("B");
		});
		const a = mercadopagoProvider.refund(
			ctxA,
			refundInput({ paymentReference: "111" }),
			CREDENTIALS,
		);
		const b = mercadopagoProvider.refund(
			ctxB,
			refundInput({ paymentReference: "222", refundRequestId: "refund:order-2:key" }),
			CREDENTIALS,
		);
		// Let both acquire their locks (they must not block each other).
		await Bun.sleep(10);
		openGate();
		const [ra, rb] = await Promise.all([a, b]);
		expect(ra.status).toBe("succeeded");
		expect(rb.status).toBe("succeeded");
		expect(mpCalls).toBe(2);
		expect(kv.store.size).toBe(0); // both locks released
	});
});
