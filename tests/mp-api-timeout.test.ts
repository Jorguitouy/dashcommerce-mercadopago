/**
 * MP-API call timeout behavior (FASE 2 hardening — closes the hung-call
 * window on the refund lock).
 *
 * The correctness INVARIANT this file guards:
 *   MP_API_TIMEOUT_MS (20s) < MP_REFUND_LOCK_STALE_MS (30s)
 *
 * Why it matters: the refund lock is stolen after 30s. Before this
 * hardening, a hung MP call had NO deadline — it could outlive the stale
 * window and keep executing at MP while a second request stole the lock
 * and issued a second refund (only MP's remaining-amount backstop left).
 * With the timeout, the hung call ABORTS at 20s, refund() throws, and the
 * finally block RELEASES the lock — before any thief can take it.
 *
 * Tests demonstrate BEHAVIOR (a hanging call aborts, the lock is freed,
 * the next refund proceeds normally), not the implementation.
 *
 * Note: the clamp itself (an ops override may only SHORTEN the timeout,
 * never extend past 20s) is a 3-line Math.min guard — directly observable
 * only by waiting 20s, so it is covered by code review + the invariant
 * test below, not by a wall-clock test.
 */
import { describe, expect, test } from "bun:test";
import {
	mercadopagoProvider,
	MP_API_TIMEOUT_MS,
	MP_REFUND_LOCK_STALE_MS,
} from "../src/provider.js";
import type { PluginKV } from "../src/types.js";
import type { CreateRefundInput } from "@dashcommerce/core/payment-provider";

/** Plain in-memory KV (no CAS needed — these tests are single-flight). */
class FakeKV implements PluginKV {
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

const CREDENTIALS = { secretKey: "TEST-mp-timeout" } as never;

function refundInput(): CreateRefundInput {
	return {
		paymentReference: "987654321",
		refundRequestId: "refund:order-timeout:t1",
		amount: 5000,
		currency: "uyu",
	};
}

/**
 * A fetch that NEVER resolves on its own — it only settles when the
 * request's AbortSignal fires. This is the "MP hangs" scenario.
 */
function hangingFetch(): {
	fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
	sawSignal: () => AbortSignal | null | undefined;
} {
	let captured: AbortSignal | null | undefined;
	const impl = (_url: string | URL | Request, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			captured = init?.signal;
			if (captured) {
				captured.addEventListener("abort", () => reject(captured!.reason), {
					once: true,
				});
			}
			// No resolve path: without a timeout this promise hangs forever.
		});
	return { fetch: impl, sawSignal: () => captured };
}

describe("MP API call timeout (hung-call cannot outlive the refund lock)", () => {
	test("INVARIANT: MP_API_TIMEOUT_MS is strictly below the refund lock stale window", () => {
		expect(MP_API_TIMEOUT_MS).toBeGreaterThan(0);
		expect(MP_REFUND_LOCK_STALE_MS).toBeGreaterThan(0);
		// The ordering IS the guarantee: a hung call aborts (and releases
		// the lock in refund()'s finally) before any thief can steal it.
		expect(MP_API_TIMEOUT_MS).toBeLessThan(MP_REFUND_LOCK_STALE_MS);
	});

	test("every MP API call carries a live AbortSignal (default timeout path)", async () => {
		const kv = new FakeKV();
		let captured: AbortSignal | null | undefined;
		const ctx = {
			kv,
			http: {
				// Resolves normally — we only want to observe the signal the
				// call carried. A normal completion clears the timeout timer
				// in mpApi's finally, so nothing leaks.
				fetch: async (_url: string | URL | Request, init?: RequestInit) => {
					captured = init?.signal;
					return new Response(JSON.stringify({ id: "mp-rfd", status: "approved", amount: "50.00" }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				},
			},
		} as never;

		const result = await mercadopagoProvider.refund(ctx, refundInput(), CREDENTIALS);
		expect(result.status).toBe("succeeded");
		// The call carried a live (not-yet-aborted) signal — the timeout
		// machinery is armed on every MP API call.
		expect(captured).toBeDefined();
		expect(captured instanceof AbortSignal).toBe(true);
		expect(captured!.aborted).toBe(false);
	});

	test("a HUNG MP refund call aborts at the timeout and RELEASES the lock", async () => {
		const kv = new FakeKV();
		const { fetch } = hangingFetch();
		// Ops/test override: 50ms — clamped path (shorter than 20s is allowed).
		const ctx = {
			kv,
			http: { fetch },
			mpApiTimeoutMs: 50,
		} as never;

		const startedAt = Date.now();
		// The hung call must REJECT (abort) — not hang for the 30s stale
		// window, not hang forever.
		await expect(mercadopagoProvider.refund(ctx, refundInput(), CREDENTIALS)).rejects.toThrow();
		const elapsed = Date.now() - startedAt;

		// Aborted quickly (50ms + scheduling slack), and crucially long
		// before the 30s stale window — this is the whole point.
		expect(elapsed).toBeLessThan(MP_REFUND_LOCK_STALE_MS);

		// The lock was RELEASED in the finally — no stale leftover.
		expect(await kv.get("mp:refund:lock:987654321")).toBeUndefined();
	});

	test("after a hung call aborts, the NEXT refund acquires the lock cleanly (no stale block)", async () => {
		const kv = new FakeKV();

		// First attempt: hangs, aborts at 50ms, releases the lock.
		const hung = hangingFetch();
		const ctx1 = { kv, http: { fetch: hung.fetch }, mpApiTimeoutMs: 50 } as never;
		await expect(mercadopagoProvider.refund(ctx1, refundInput(), CREDENTIALS)).rejects.toThrow();
		expect(await kv.get("mp:refund:lock:987654321")).toBeUndefined();

		// Second attempt: MP is healthy again — the refund must SUCCEED,
		// proving the abort left no stale lock blocking legitimate retries.
		const ok = hangingFetch(); // reuse the wrapper shape…
		const ctx2 = {
			kv,
			http: {
				fetch: async () =>
					new Response(JSON.stringify({ id: "mp-rfd-2", status: "approved", amount: "50.00" }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			},
			mpApiTimeoutMs: 50,
		} as never;
		const result = await mercadopagoProvider.refund(ctx2, refundInput(), CREDENTIALS);
		expect(result.status).toBe("succeeded");
		// Lock released after the successful call too.
		expect(await kv.get("mp:refund:lock:987654321")).toBeUndefined();
	});
});
