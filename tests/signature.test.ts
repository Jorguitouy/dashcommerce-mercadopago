import { describe, expect, it } from "bun:test";

import {
	buildManifest,
	parseSignatureHeader,
	verifyMercadoPagoSignature,
} from "../src/signature.js";

const SECRET = "test-webhook-secret";

/** Compute the MP-style HMAC-SHA256 hex signature for a manifest. */
async function sign(manifest: string, secret: string = SECRET): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(manifest));
	const bytes = new Uint8Array(sig);
	let hex = "";
	for (const b of bytes) hex += b.toString(16).padStart(2, "0");
	return hex;
}

/** Build a valid `ts=...,v1=...` header for the given params. */
async function makeHeader(params: {
	dataId: string;
	requestId: string;
	secret?: string;
	tsOverride?: string;
}): Promise<string> {
	const ts = params.tsOverride ?? String(Math.floor(Date.now() / 1000));
	const manifest = buildManifest({ dataId: params.dataId, requestId: params.requestId, ts });
	const v1 = await sign(manifest, params.secret ?? SECRET);
	return `ts=${ts},v1=${v1}`;
}

describe("parseSignatureHeader", () => {
	it("parses a well-formed header", () => {
		const parsed = parseSignatureHeader("ts=1234567890,v1=abcdef01");
		expect(parsed).not.toBeNull();
		expect(parsed!.ts).toBe("1234567890");
		expect(parsed!.v1).toBe("abcdef01");
	});

	it("tolerates whitespace and reversed order", () => {
		const parsed = parseSignatureHeader(" v1=abcdef01 , ts=1234567890 ");
		expect(parsed).not.toBeNull();
		expect(parsed!.ts).toBe("1234567890");
		expect(parsed!.v1).toBe("abcdef01");
	});

	it("returns null when ts or v1 is missing", () => {
		expect(parseSignatureHeader("ts=1234567890")).toBeNull();
		expect(parseSignatureHeader("v1=abcdef01")).toBeNull();
		expect(parseSignatureHeader("")).toBeNull();
	});
});

describe("buildManifest", () => {
	it("lowercases the data id (MP requirement)", () => {
		expect(buildManifest({ dataId: "123ABC", requestId: "req-1", ts: "1700000000" })).toBe(
			"id:123abc;request-id:req-1;ts:1700000000;",
		);
	});

	it("omits the request-id segment entirely when requestId is empty (SEC-004, MP spec)", () => {
		// Official MP webhook-signature spec: "If any of these fields are
		// missing from the incoming request, omit that entire segment
		// completely rather than leaving it blank."
		expect(buildManifest({ dataId: "123abc", requestId: "", ts: "1700000000" })).toBe(
			"id:123abc;ts:1700000000;",
		);
	});
});

describe("verifyMercadoPagoSignature (missing x-request-id — SEC-004)", () => {
	it("accepts a valid MP signature built WITHOUT the request-id segment", async () => {
		// MP sends some notifications without x-request-id; the manifest it
		// signs then omits the whole segment. Our verifier must reproduce the
		// same manifest shape for the HMAC to match.
		const ts = String(Math.floor(Date.now() / 1000));
		const manifest = "id:12345678901;ts:" + ts + ";";
		const v1 = await sign(manifest);
		const result = await verifyMercadoPagoSignature({
			signatureHeader: `ts=${ts},v1=${v1}`,
			dataId: "12345678901",
			requestId: "",
			secret: SECRET,
		});
		expect(result.ok).toBe(true);
	});

	it("rejects an empty-segment manifest when MP omitted the header (regression guard)", async () => {
		// Guard: the OLD buggy behavior (manifest `id:…;request-id:;ts:…;`)
		// must not verify against a real MP signature that omitted the
		// segment — proves the fix, not just a new happy path.
		const ts = String(Math.floor(Date.now() / 1000));
		const mpManifest = "id:12345678901;ts:" + ts + ";";
		const v1 = await sign(mpManifest);
		const result = await verifyMercadoPagoSignature({
			signatureHeader: `ts=${ts},v1=${v1}`,
			dataId: "12345678901",
			requestId: "should-not-be-here",
			secret: SECRET,
		});
		expect(result.ok).toBe(false);
	});

	it("still accepts a valid signature when x-request-id IS present", async () => {
		// Regression: the common path (header present) keeps working after
		// the manifest-shape change.
		const dataId = "12345678901";
		const requestId = "webhook-req-001";
		const header = await makeHeader({ dataId, requestId });
		const result = await verifyMercadoPagoSignature({ signatureHeader: header, dataId, requestId, secret: SECRET });
		expect(result.ok).toBe(true);
	});
});

describe("verifyMercadoPagoSignature", () => {
	const dataId = "12345678901";
	const requestId = "webhook-req-001";

	it("accepts a valid signature (seconds ts)", async () => {
		const header = await makeHeader({ dataId, requestId });
		const result = await verifyMercadoPagoSignature({ signatureHeader: header, dataId, requestId, secret: SECRET });
		expect(result.ok).toBe(true);
		expect(result.reason).toBeUndefined();
	});

	it("accepts a valid signature with milliseconds ts", async () => {
		const ts = String(Date.now());
		const manifest = buildManifest({ dataId, requestId, ts });
		const v1 = await sign(manifest);
		const result = await verifyMercadoPagoSignature({
			signatureHeader: `ts=${ts},v1=${v1}`,
			dataId,
			requestId,
			secret: SECRET,
		});
		expect(result.ok).toBe(true);
	});

	it("rejects a tampered signature (manifest mismatch)", async () => {
		const header = await makeHeader({ dataId, requestId });
		const result = await verifyMercadoPagoSignature({
			signatureHeader: header,
			dataId: "99999999999", // different payment id
			requestId,
			secret: SECRET,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("signature mismatch");
	});

	it("rejects an expired timestamp (replay protection)", async () => {
		const staleTsSeconds = Math.floor(Date.now() / 1000) - 6 * 60; // 6 min old
		const header = await makeHeader({ dataId, requestId, tsOverride: String(staleTsSeconds) });
		const result = await verifyMercadoPagoSignature({ signatureHeader: header, dataId, requestId, secret: SECRET });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("signature timestamp outside allowed window");
	});

	it("rejects a future timestamp beyond the window", async () => {
		const futureTs = String(Math.floor(Date.now() / 1000) + 6 * 60);
		const header = await makeHeader({ dataId, requestId, tsOverride: futureTs });
		const result = await verifyMercadoPagoSignature({ signatureHeader: header, dataId, requestId, secret: SECRET });
		expect(result.ok).toBe(false);
	});

	it("rejects a malformed header", async () => {
		const result = await verifyMercadoPagoSignature({
			signatureHeader: "garbage",
			dataId,
			requestId,
			secret: SECRET,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("malformed x-signature header");
	});

	it("rejects a wrong secret", async () => {
		const header = await makeHeader({ dataId, requestId, secret: "other-secret" });
		const result = await verifyMercadoPagoSignature({ signatureHeader: header, dataId, requestId, secret: SECRET });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("signature mismatch");
	});

	it("rejects a tampered request-id", async () => {
		const header = await makeHeader({ dataId, requestId });
		const result = await verifyMercadoPagoSignature({
			signatureHeader: header,
			dataId,
			requestId: "different-request-id",
			secret: SECRET,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects a non-numeric ts (fail closed)", async () => {
		const header = await makeHeader({ dataId, requestId, tsOverride: "not-a-number" });
		const result = await verifyMercadoPagoSignature({ signatureHeader: header, dataId, requestId, secret: SECRET });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("signature timestamp outside allowed window");
	});

	it("rejects a v1 that is not hex", async () => {
		const ts = String(Math.floor(Date.now() / 1000));
		const result = await verifyMercadoPagoSignature({
			signatureHeader: `ts=${ts},v1=zzzz-not-hex`,
			dataId,
			requestId,
			secret: SECRET,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("signature mismatch");
	});

	it("never leaks the secret or expected signature in the reason", async () => {
		const header = await makeHeader({ dataId, requestId, secret: "leak-check-secret" });
		const result = await verifyMercadoPagoSignature({ signatureHeader: header, dataId, requestId, secret: SECRET });
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain("leak-check-secret");
	});
});
