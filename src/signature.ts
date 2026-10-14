/**
 * Mercado Pago webhook signature validation — bank-grade security.
 *
 * MP signs webhooks with HMAC-SHA256 over a manifest string:
 *   id:[data.id];request-id:[x-request-id];ts:[ts];
 *
 * where [data.id] is the payment id (lowercase!), [x-request-id] is the
 * request id header, and [ts] is the timestamp from the x-signature header.
 * The signature header has the format: `ts=<timestamp>,v1=<hex-hmac>`.
 *
 * Security measures:
 * - Timing-safe comparison (constant time) to prevent timing attacks.
 * - Timestamp drift check (replay protection) — reject > 5 minutes old.
 *   MP sends `ts` sometimes in SECONDS (10 digits) and sometimes in
 *   MILLISECONDS (13 digits); we normalize ONLY for the drift check. The
 *   HMAC manifest always uses the RAW ts string exactly as MP sent it.
 * - Manifest built with exact byte semantics (lowercase data.id).
 * - No secrets are ever logged.
 */

/** Max allowed drift between the signature timestamp and now (replay window). */
const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000;

/** Parse the `x-signature` header: `ts=<timestamp>,v1=<hex-hmac>`. */
export function parseSignatureHeader(
	header: string,
): { ts: string; v1: string } | null {
	let ts: string | undefined;
	let v1: string | undefined;
	for (const part of header.split(",")) {
		const trimmed = part.trim();
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		const value = trimmed.slice(eq + 1).trim();
		if (key === "ts") ts = value;
		else if (key === "v1") v1 = value;
	}
	if (!ts || !v1) return null;
	return { ts, v1 };
}

/**
 * Normalize an MP timestamp for the drift check ONLY.
 * Accepts seconds (10 digits) or milliseconds (13 digits); anything else is
 * rejected. The HMAC manifest must use the raw string, never this value.
 */
function tsToMs(raw: string): number | null {
	if (!/^\d+$/.test(raw)) return null;
	if (raw.length === 10) return Number(raw) * 1000;
	if (raw.length === 13) return Number(raw);
	// Other lengths (e.g. a future 16-digit microsecond epoch) — scaling
	// heuristically is dangerous, so reject. Fail closed.
	return null;
}

/** Build the exact manifest MP signs: `id:[data.id];request-id:[x-request-id];ts:[ts];` */
export function buildManifest(params: {
	dataId: string;
	requestId: string;
	ts: string;
	/**
	 * Optional SHA-256 hex of the raw body. NEVER sent by MP — used ONLY by
	 * the internal re-injection channel (signEnrichedEvent → verifyWebhook)
	 * so the signature covers the FULL body, not just id/request-id/ts.
	 * When present, a body that differs by one byte fails verification.
	 */
	bodyHash?: string;
}): string {
	// MP requires data.id to be lowercase in the manifest.
	const id = params.dataId.toLowerCase();
	const base = `id:${id};request-id:${params.requestId};ts:${params.ts};`;
	return params.bodyHash !== undefined ? `${base}body:${params.bodyHash};` : base;
}

/**
 * SHA-256 of a string as lowercase hex — used for the internal re-injection
 * signature's body coverage. Pure, no secrets involved.
 */
export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	let hex = "";
	for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
	return hex;
}

/**
 * Constant-time comparison of two hex strings. Length check first is fine —
 * comparing different lengths cannot leak meaningful timing information about
 * the secret (the HMAC of the same manifest always has the same length).
 */
async function timingSafeEqualHex(a: string, b: string): Promise<boolean> {
	const aBytes = hexToBytes(a);
	const bBytes = hexToBytes(b);
	if (aBytes.length !== bBytes.length) return false;
	if (aBytes.length === 0) return false;

	// Constant-time XOR accumulate.
	let diff = 0;
	for (let i = 0; i < aBytes.length; i++) {
		diff |= aBytes[i] ^ bBytes[i];
	}
	return diff === 0;
}

function hexToBytes(hex: string): Uint8Array {
	const clean = hex.trim().toLowerCase();
	if (clean.length === 0 || clean.length % 2 !== 0) return new Uint8Array(0);
	// Validate all chars are hex before converting.
	if (!/^[0-9a-f]+$/.test(clean)) return new Uint8Array(0);
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

/**
 * Verify an MP webhook signature. Returns { ok: true } or { ok: false, reason }.
 * The reason string is safe to log and send to the client — it never includes
 * the secret or the expected signature.
 *
 * The result uses the core's VerifyWebhookResult shape ({ ok, reason? }) rather
 * than a discriminated union — callers access `reason` only when ok is false.
 */
export interface MpSignatureResult {
	ok: boolean;
	reason?: string;
}

export async function verifyMercadoPagoSignature(params: {
	signatureHeader: string;
	dataId: string;
	requestId: string;
	secret: string;
	/**
	 * Optional expected SHA-256 hex of the raw body. When the signature was
	 * produced with body coverage (internal channel), verification recomputes
	 * the manifest with this hash — any body difference fails.
	 */
	bodyHash?: string;
}): Promise<MpSignatureResult> {
	const parsed = parseSignatureHeader(params.signatureHeader);
	if (!parsed) {
		return { ok: false, reason: "malformed x-signature header" };
	}

	// Replay protection: reject stale timestamps. Normalized for the check
	// only — the manifest below uses the raw ts string.
	const tsMs = tsToMs(parsed.ts);
	if (tsMs === null || Math.abs(Date.now() - tsMs) > MAX_TIMESTAMP_DRIFT_MS) {
		return { ok: false, reason: "signature timestamp outside allowed window" };
	}

	const manifest = buildManifest({
		dataId: params.dataId,
		requestId: params.requestId,
		ts: parsed.ts,
		...(params.bodyHash !== undefined ? { bodyHash: params.bodyHash } : {}),
	});

	// HMAC-SHA256 over the manifest with the webhook secret.
	const encoder = new TextEncoder();
	const keyBytes = encoder.encode(params.secret);
	const key = await crypto.subtle.importKey(
		"raw",
		keyBytes,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(manifest),
	);
	const expectedHex = bytesToHex(new Uint8Array(signature));

	const matches = await timingSafeEqualHex(expectedHex, parsed.v1);
	if (!matches) {
		return { ok: false, reason: "signature mismatch" };
	}
	return { ok: true };
}

function bytesToHex(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i++) {
		out += bytes[i].toString(16).padStart(2, "0");
	}
	return out;
}
