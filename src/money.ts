/**
 * Exact decimal-string arithmetic for Mercado Pago amounts — bank-grade.
 *
 * MP's Orders API transmits money as DECIMAL STRINGS ("1500.00"), while the
 * DashCommerce core uses integer minor units (150000). Floating-point math
 * (parseFloat × 100) is FORBIDDEN anywhere in the money path: binary floats
 * cannot represent 0.1, and rounding errors become real financial losses.
 *
 * All conversions here are exact string ⇄ integer operations:
 *   - minorUnitsToDecimalString(150000, "UYU") → "1500.00"
 *   - decimalStringToMinorUnits("1500.00", "UYU") → 150000
 *   - Zero-decimal currencies (CLP) pass through as integer strings.
 *
 * These helpers are pure and synchronous so they can be unit-tested without
 * mocking anything.
 */

/** ISO-4217 currencies with zero decimal places. */
export const ZERO_DECIMAL_CURRENCIES = new Set(["CLP"]);

/** ISO-4217 currencies with three decimal places. */
export const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

export function currencyMinorUnitDigits(currency: string): number {
	const code = currency.toUpperCase();
	if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
	if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
	return 2;
}

/**
 * Convert integer minor units to an exact decimal string for MP.
 * Pure integer arithmetic — no floats anywhere.
 *
 *   minorUnitsToDecimalString(150000, "UYU") → "1500.00"
 *   minorUnitsToDecimalString(1500, "CLP")   → "1500"
 */
export function minorUnitsToDecimalString(amount: number, currency: string): string {
	if (!Number.isSafeInteger(amount) || amount < 0) {
		throw new Error(`Invalid minor-units amount: ${amount}`);
	}
	const digits = currencyMinorUnitDigits(currency);
	if (digits === 0) return String(amount);
	const scale = 10 ** digits;
	const whole = Math.floor(amount / scale);
	const frac = amount % scale;
	const fracStr = String(frac).padStart(digits, "0");
	return `${whole}.${fracStr}`;
}

/**
 * Convert integer minor units to a JSON number for MP's Preferences API.
 *
 * The Preferences API (Checkout Pro) rejects decimal STRINGS for
 * unit_price ("items.0.unit_price must be a number" — verified
 * empirically against api.mercadopago.com). It requires a JSON number,
 * but the value MUST still be exact: we produce the exact decimal string
 * first (pure integer arithmetic) and convert it with Number() — the
 * JSON wire then serializes the shortest round-trip representation,
 * which for the produced string is always the exact decimal value.
 * No floating-point arithmetic is ever performed on the amount.
 */
export function minorUnitsToDecimalNumber(amount: number, currency: string): number {
	return Number(minorUnitsToDecimalString(amount, currency));
}

/**
 * Convert an MP decimal string (or number, defensively) to integer minor
 * units. Exact string parsing — never parseFloat.
 *
 *   decimalStringToMinorUnits("1500.00", "UYU") → 150000
 *   decimalStringToMinorUnits(1500, "CLP")      → 1500
 *
 * Rejects: negative amounts, more fractional digits than the currency
 * defines (e.g. "1500.005" UYU), non-numeric garbage, NaN/Infinity.
 */
export function decimalStringToMinorUnits(
	value: string | number,
	currency: string,
): number {
	const digits = currencyMinorUnitDigits(currency);
	let raw: string;
	if (typeof value === "number") {
		// MP sometimes sends JSON numbers. Accept only integral floats and
		// integers to avoid silent precision loss (e.g. 1500.1 is fine as
		// 1500.10 for UYU, but 0.1 + 0.2 style artifacts are not).
		if (!Number.isFinite(value)) throw new Error(`Invalid amount value: ${value}`);
		raw = value.toFixed(Math.max(digits, 0));
	} else {
		raw = value.trim();
	}

	// Strict decimal-string grammar: optional sign (only "+"), digits,
	// optional single dot + digits. No exponents, no thousands separators.
	const match = /^(\d+)(?:\.(\d+))?$/.exec(raw);
	if (!match) throw new Error(`Malformed decimal amount: ${JSON.stringify(raw)}`);

	const wholeStr = match[1] ?? "0";
	const fracStr = match[2] ?? "";
	if (fracStr.length > digits) {
		throw new Error(
			`Amount ${JSON.stringify(raw)} has more fractional digits than ${currency} allows (${digits})`,
		);
	}
	const paddedFrac = fracStr.padEnd(digits, "0");
	const combined = wholeStr + paddedFrac;
	const minorUnits = Number(combined);
	if (!Number.isSafeInteger(minorUnits)) {
		throw new Error(`Amount out of safe-integer range: ${raw}`);
	}
	return minorUnits;
}

/**
 * Format a minor-units integer as a human string (for logs/admin).
 *   formatMinorUnits(150000, "UYU") → "UYU 1500.00"
 */
export function formatMinorUnits(amount: number, currency: string): string {
	return `${currency.toUpperCase()} ${minorUnitsToDecimalString(amount, currency)}`;
}
