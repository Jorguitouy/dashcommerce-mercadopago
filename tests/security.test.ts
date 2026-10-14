import { describe, expect, it } from "bun:test";

import {
	validateCheckoutUrl,
	orderCreateIdempotencyKey,
	mpPaymentToStatus,
	type MpPayment,
} from "../src/provider.js";

describe("validateCheckoutUrl (open-redirect protection)", () => {
	it("accepts https URLs on allowlisted MP hosts", () => {
		expect(validateCheckoutUrl("https://sandbox.mercadopago.com.uy/checkout/v1/redirect?pref_id=1")).not.toBeNull();
		expect(validateCheckoutUrl("https://www.mercadopago.com.uy/checkout/beta?pref=abc")).not.toBeNull();
		expect(validateCheckoutUrl("https://mercadopago.com/checkout")).not.toBeNull();
	});

	it("rejects non-https schemes", () => {
		expect(validateCheckoutUrl("http://sandbox.mercadopago.com.uy/checkout")).toBeNull();
		expect(validateCheckoutUrl("javascript:alert(1)")).toBeNull();
		expect(validateCheckoutUrl("data:text/html,phishing")).toBeNull();
		expect(validateCheckoutUrl("ftp://mercadopago.com.uy/x")).toBeNull();
	});

	it("rejects non-allowlisted hosts (open redirect / phishing)", () => {
		expect(validateCheckoutUrl("https://evil.example.com/checkout")).toBeNull();
		expect(validateCheckoutUrl("https://mercadopago.com.uy.evil.com/checkout")).toBeNull();
		expect(validateCheckoutUrl("https://fake-mercadopago.net/checkout")).toBeNull();
	});

	it("rejects URLs with embedded credentials", () => {
		expect(validateCheckoutUrl("https://user:pass@sandbox.mercadopago.com.uy/checkout")).toBeNull();
	});

	it("rejects malformed input", () => {
		expect(validateCheckoutUrl(undefined)).toBeNull();
		expect(validateCheckoutUrl("")).toBeNull();
		expect(validateCheckoutUrl("not a url")).toBeNull();
		expect(validateCheckoutUrl(null)).toBeNull();
	});
});

describe("orderCreateIdempotencyKey", () => {
	it("is stable for the same draft id", () => {
		const a = orderCreateIdempotencyKey("14ee623815acc3f1644a77c647f46e04");
		const b = orderCreateIdempotencyKey("14ee623815acc3f1644a77c647f46e04");
		expect(a).toBe(b);
	});

	it("differs for different draft ids", () => {
		const a = orderCreateIdempotencyKey("draft-a");
		const b = orderCreateIdempotencyKey("draft-b");
		expect(a).not.toBe(b);
	});

	it("has UUID shape (MP expects UUID-like keys)", () => {
		const key = orderCreateIdempotencyKey("draft-a");
		expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});
});

describe("mpPaymentToStatus (state normalization — fail closed)", () => {
	function payment(overrides: Partial<MpPayment> = {}): MpPayment {
		return {
			id: "123",
			status: "approved",
			transaction_amount: "20.99",
			currency_id: "USD",
			external_reference: "draft-1",
			...overrides,
		};
	}

	it("maps approved → succeeded with exact minor units", () => {
		const r = mpPaymentToStatus(payment());
		expect(r.status).toBe("succeeded");
		expect(r.amount).toBe(2099);
		expect(r.currency).toBe("USD");
		expect(r.paymentReference).toBe("123");
	});

	it("maps authorized/in_process/in_mediation → pending", () => {
		for (const status of ["authorized", "in_process", "in_mediation", "pending_contingency", "pending_review_manual"]) {
			const r = mpPaymentToStatus(payment({ status }));
			expect(r.status).toBe("pending");
			expect(r.reason).toContain(status);
		}
	});

	it("maps rejected/cancelled → failed", () => {
		for (const status of ["rejected", "cancelled"]) {
			const r = mpPaymentToStatus(payment({ status }));
			expect(r.status).toBe("failed");
		}
	});

	it("maps UNKNOWN status → failed (never succeeded)", () => {
		const r = mpPaymentToStatus(payment({ status: "brand_new_status" }));
		expect(r.status).toBe("failed");
		expect(r.reason).toContain("unrecognized");
	});

	it("maps malformed amount → failed, never guesses", () => {
		const r = mpPaymentToStatus(payment({ transaction_amount: "12.3.4" }));
		expect(r.status).toBe("failed");
		expect(r.reason).toContain("malformed amount");
	});

	it("omits amount when the payment carries none", () => {
		const r = mpPaymentToStatus(payment({ transaction_amount: undefined, currency_id: undefined }));
		expect(r.status).toBe("succeeded"); // status itself is approved
		expect(r.amount).toBeUndefined();
	});
});
