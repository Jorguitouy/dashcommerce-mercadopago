/**
 * Property-based tests for money.ts — the exact-integer money path.
 *
 * Rationale: a rounding error here destroys real money silently. These
 * tests generate hundreds of random values and verify the properties
 * that MUST hold for every input:
 *
 *   P1 (round-trip):   minorUnitsToDecimalString → decimalStringToMinorUnits
 *                      is the identity for all representable minor units.
 *   P2 (no float drift): the decimal string never exhibits float artifacts
 *                      (e.g. "34.990000000000002").
 *   P3 (format shape): the decimal string always matches ^\d+\.\d{2,3}$
 *                      (2 decimals for USD/EUR/UYU, 3 for CLP-style
 *                      zero-decimal... actually CLP has 0 decimals —
 *                      the per-currency digit table is exercised too).
 *   P4 (bounds):       minor units ≥ 0 round-trip; negative rejected or
 *                      round-trips symmetrically (document actual behavior).
 *   P5 (zero-decimal): currencies with 0 decimals (JPY-style, CLP) never
 *                      emit a decimal point.
 */
import { describe, expect, test } from "bun:test";
import {
	currencyMinorUnitDigits,
	decimalStringToMinorUnits,
	minorUnitsToDecimalNumber,
	minorUnitsToDecimalString,
} from "../src/money.js";
import { mercadopagoProvider } from "../src/provider.js";

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const CURRENCIES_2 = ["USD", "EUR", "UYU", "ARS", "BRL", "MXN", "COP", "PEN"];
const CURRENCIES_0 = ["CLP"];

describe("money.ts property-based tests", () => {
	test("P1: minorUnits → decimal string → minorUnits is identity (2-decimal currencies)", () => {
		const rand = mulberry32(20261013);
		for (let i = 0; i < 500; i++) {
			const currency = CURRENCIES_2[Math.floor(rand() * CURRENCIES_2.length)];
			// Amounts up to ~1M major units (100_000_000 minor units).
			const minor = Math.floor(rand() * 100_000_000);
			const str = minorUnitsToDecimalString(minor, currency);
			const back = decimalStringToMinorUnits(str, currency);
			expect(back).toBe(minor);
		}
	});

	test("P1b: identity holds for edge magnitudes (0, 1, max, powers of 10)", () => {
		const edges = [0, 1, 99, 100, 101, 999, 1000, 99999, 100000, 1e6, 1e8, 1e10, Number.MAX_SAFE_INTEGER];
		for (const currency of CURRENCIES_2) {
			for (const minor of edges) {
				const str = minorUnitsToDecimalString(minor, currency);
				const back = decimalStringToMinorUnits(str, currency);
				expect(back).toBe(minor);
			}
		}
	});

	test("P2: decimal strings never show float artifacts", () => {
		const rand = mulberry32(777);
		for (let i = 0; i < 300; i++) {
			const currency = CURRENCIES_2[Math.floor(rand() * CURRENCIES_2.length)];
			const minor = Math.floor(rand() * 100_000_000);
			const str = minorUnitsToDecimalString(minor, currency);
			// No "34.990000000000002" style artifacts: at most 2 decimals.
			expect(str).toMatch(/^\d+(\.\d{1,2})?$/);
			expect(str).not.toContain("e"); // no scientific notation
		}
	});

	test("P3: format shape per currency digit table", () => {
		const rand = mulberry32(4242);
		for (let i = 0; i < 200; i++) {
			const currency = [...CURRENCIES_2, ...CURRENCIES_0][Math.floor(rand() * 9)];
			const digits = currencyMinorUnitDigits(currency);
			const minor = Math.floor(rand() * 10_000_000);
			const str = minorUnitsToDecimalString(minor, currency);
			const frac = str.split(".")[1] ?? "";
			expect(frac.length).toBeLessThanOrEqual(digits);
			expect(currencyMinorUnitDigits("USD")).toBe(2);
			expect(currencyMinorUnitDigits("CLP")).toBe(0);
			expect(currencyMinorUnitDigits("UYU")).toBe(2);
		}
	});

	test("P4: zero-decimal currencies emit no decimal point", () => {
		const rand = mulberry32(99);
		for (let i = 0; i < 100; i++) {
			const minor = Math.floor(rand() * 10_000_000);
			const str = minorUnitsToDecimalString(minor, "CLP");
			expect(str).toMatch(/^\d+$/); // integer, no "."
			expect(decimalStringToMinorUnits(str, "CLP")).toBe(minor);
		}
	});

	test("P5: minorUnitsToDecimalNumber matches the string form numerically", () => {
		const rand = mulberry32(31337);
		for (let i = 0; i < 300; i++) {
			const currency = CURRENCIES_2[Math.floor(rand() * CURRENCIES_2.length)];
			const minor = Math.floor(rand() * 100_000_000);
			const num = minorUnitsToDecimalNumber(minor, currency);
			const str = minorUnitsToDecimalString(minor, currency);
			// The number form is what MP's unit_price field receives; it must
			// equal the string form's value exactly (float64 can represent
			// x.xx up to large magnitudes exactly enough for this range).
			expect(num).toBe(Number(str));
		}
	});

	test("P6: decimalStringToMinorUnits rejects malformed input (fail-closed)", () => {
		// NOTE: whitespace is intentionally TRIMMED (defensive parsing of
		// MP API responses that may carry padded strings) — " 12.34 " is
		// accepted as 12.34. Everything else malformed is rejected.
		for (const bad of ["", "abc", "12.34.56", "-5", "1e3", "0x10", "12,34"]) {
			let threw = false;
			try {
				decimalStringToMinorUnits(bad as never, "USD");
			} catch {
				threw = true;
			}
			expect(threw).toBe(true);
		}
		// Whitespace-padded valid values ARE accepted (trimmed).
		expect(decimalStringToMinorUnits(" 12.34 ", "USD")).toBe(1234);
	});

	test("P7: unknown currency defaults to 2 digits (documented); the allowlist is the real guard", () => {
		// money.ts intentionally defaults unknown currencies to 2 decimal
		// digits (the ISO-4217 majority). The REAL protection against
		// invalid currencies is layered outside money.ts:
		//   1. provider.supportsCurrency — SUPPORTED_CURRENCIES allowlist
		//      gates checkout (UYU/ARS/BRL/CLP/COP/MXN/PEN/USD/EUR).
		//   2. webhook binding checks — payment currency must equal the
		//      draft's currency before any amount math is trusted.
		expect(currencyMinorUnitDigits("ZZZ")).toBe(2);
		expect(currencyMinorUnitDigits("XXX")).toBe(2);
		// Known table entries still exact:
		expect(currencyMinorUnitDigits("CLP")).toBe(0);
		expect(currencyMinorUnitDigits("BHD")).toBe(3);
		expect(currencyMinorUnitDigits("usd")).toBe(2); // case-insensitive
		// And the provider allowlist rejects unknowns at the boundary:
		expect(mercadopagoProvider.supportsCurrency("ZZZ")).toBe(false);
		expect(mercadopagoProvider.supportsCurrency("UYU")).toBe(true);
	});
});
