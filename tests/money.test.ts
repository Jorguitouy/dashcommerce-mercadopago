import { describe, expect, it } from "bun:test";

import {
	currencyMinorUnitDigits,
	decimalStringToMinorUnits,
	formatMinorUnits,
	minorUnitsToDecimalNumber,
	minorUnitsToDecimalString,
} from "../src/money.js";

describe("currencyMinorUnitDigits", () => {
	it("returns 0 for zero-decimal CLP", () => {
		expect(currencyMinorUnitDigits("CLP")).toBe(0);
		expect(currencyMinorUnitDigits("clp")).toBe(0);
	});

	it("returns 3 for three-decimal BHD", () => {
		expect(currencyMinorUnitDigits("BHD")).toBe(3);
		expect(currencyMinorUnitDigits("KWD")).toBe(3);
	});

	it("returns 2 for ordinary currencies", () => {
		expect(currencyMinorUnitDigits("UYU")).toBe(2);
		expect(currencyMinorUnitDigits("USD")).toBe(2);
	});
});

describe("minorUnitsToDecimalString", () => {
	it("converts minor units to exact decimal string (2 decimals)", () => {
		expect(minorUnitsToDecimalString(150000, "UYU")).toBe("1500.00");
		expect(minorUnitsToDecimalString(2099, "USD")).toBe("20.99");
		expect(minorUnitsToDecimalString(5, "USD")).toBe("0.05");
	});

	it("passes through zero-decimal CLP as integer string", () => {
		expect(minorUnitsToDecimalString(1500, "CLP")).toBe("1500");
		expect(minorUnitsToDecimalString(0, "CLP")).toBe("0");
	});

	it("converts three-decimal BHD", () => {
		expect(minorUnitsToDecimalString(1500, "BHD")).toBe("1.500");
		expect(minorUnitsToDecimalString(1, "BHD")).toBe("0.001");
	});

	it("rejects negative amounts", () => {
		expect(() => minorUnitsToDecimalString(-1, "USD")).toThrow();
	});

	it("rejects non-safe-integer amounts", () => {
		expect(() => minorUnitsToDecimalString(1.5, "USD")).toThrow();
		expect(() => minorUnitsToDecimalString(Number.MAX_SAFE_INTEGER + 1, "USD")).toThrow();
	});
});

describe("minorUnitsToDecimalNumber", () => {
	it("produces the exact JSON number", () => {
		expect(minorUnitsToDecimalNumber(150000, "UYU")).toBe(1500.0);
		expect(minorUnitsToDecimalNumber(2099, "USD")).toBe(20.99);
		expect(minorUnitsToDecimalNumber(1500, "CLP")).toBe(1500);
		expect(minorUnitsToDecimalNumber(1500, "BHD")).toBe(1.5);
	});

	it("round-trips back through decimalStringToMinorUnits", () => {
		for (const [amount, currency] of [
			[150000, "UYU"],
			[2099, "USD"],
			[1500, "CLP"],
			[1500, "BHD"],
			[0, "USD"],
		] as const) {
			const n = minorUnitsToDecimalNumber(amount, currency);
			expect(decimalStringToMinorUnits(n, currency)).toBe(amount);
		}
	});
});

describe("decimalStringToMinorUnits", () => {
	it("parses exact decimal strings", () => {
		expect(decimalStringToMinorUnits("1500.00", "UYU")).toBe(150000);
		expect(decimalStringToMinorUnits("20.99", "USD")).toBe(2099);
		expect(decimalStringToMinorUnits("0.05", "USD")).toBe(5);
	});

	it("parses zero-decimal CLP", () => {
		expect(decimalStringToMinorUnits("1500", "CLP")).toBe(1500);
	});

	it("parses three-decimal BHD", () => {
		expect(decimalStringToMinorUnits("1.500", "BHD")).toBe(1500);
	});

	it("accepts JSON numbers defensively", () => {
		expect(decimalStringToMinorUnits(1500, "CLP")).toBe(1500);
		expect(decimalStringToMinorUnits(20.99, "USD")).toBe(2099);
	});

	it("rejects malformed strings", () => {
		expect(() => decimalStringToMinorUnits("abc", "USD")).toThrow();
		expect(() => decimalStringToMinorUnits("1,500.00", "USD")).toThrow();
		expect(() => decimalStringToMinorUnits("1e3", "USD")).toThrow();
		expect(() => decimalStringToMinorUnits("", "USD")).toThrow();
	});

	it("rejects negative amounts", () => {
		expect(() => decimalStringToMinorUnits("-5.00", "USD")).toThrow();
	});

	it("rejects more fractional digits than the currency allows", () => {
		expect(() => decimalStringToMinorUnits("1500.005", "UYU")).toThrow();
		expect(() => decimalStringToMinorUnits("1.5001", "BHD")).toThrow();
	});

	it("rejects NaN/Infinity numbers", () => {
		expect(() => decimalStringToMinorUnits(Number.NaN, "USD")).toThrow();
		expect(() => decimalStringToMinorUnits(Number.POSITIVE_INFINITY, "USD")).toThrow();
	});

	it("rejects amounts out of safe-integer range", () => {
		expect(() => decimalStringToMinorUnits("9007199254740993", "CLP")).toThrow();
	});
});

describe("formatMinorUnits", () => {
	it("formats a human-readable amount", () => {
		expect(formatMinorUnits(150000, "UYU")).toBe("UYU 1500.00");
		expect(formatMinorUnits(1500, "clp")).toBe("CLP 1500");
	});
});

// ---------------------------------------------------------------------------
// Property-based tests (deterministic PRNG so failures are reproducible)
// ---------------------------------------------------------------------------
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

describe("property: minorUnits ⇄ decimal string round-trip", () => {
	const CURRENCIES = ["USD", "UYU", "CLP", "BHD"] as const;

	it("round-trips every generated minor-unit amount losslessly", () => {
		const rand = mulberry32(0x5eed);
		for (let i = 0; i < 2000; i++) {
			const currency = CURRENCIES[Math.floor(rand() * CURRENCIES.length)]!;
			// Keep within safe-integer range for the worst case (BHD x1000).
			const maxMinor = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
			const minor = Math.floor(rand() * maxMinor);
			const str = minorUnitsToDecimalString(minor, currency);
			const back = decimalStringToMinorUnits(str, currency);
			if (back !== minor) {
				throw new Error(
					`round-trip failed: minor=${minor} currency=${currency} str="${str}" back=${back}`,
				);
			}
		}
	});

	it("round-trips through the JSON-number path without drift", () => {
		const rand = mulberry32(0xc0ffee);
		for (let i = 0; i < 2000; i++) {
			const currency = CURRENCIES[Math.floor(rand() * CURRENCIES.length)]!;
			const digits = currencyMinorUnitDigits(currency);
			// For the number path only use amounts whose decimal value is
			// exactly representable as a float (2-decimal and 0-decimal cases),
			// because BHD (3 decimals) values like 0.001 are not.
			const safe = digits <= 2 ? Math.floor(rand() * 9_000_000) : Math.floor(rand() * 9_000) * 1000;
			const n = minorUnitsToDecimalNumber(safe, currency);
			const back = decimalStringToMinorUnits(n, currency);
			if (back !== safe) {
				throw new Error(
					`number round-trip failed: minor=${safe} currency=${currency} n=${n} back=${back}`,
				);
			}
		}
	});
});
