import { describe, expect, it } from "vitest";
import { generateKeys, signMandate, verifyMandate } from "./sign.js";
import { checkCumulative, checkPaymentAuthorization, checkPurchase } from "./check.js";
import type { Mandate, Purchase } from "./types.js";

const mandate: Mandate = {
  id: "m1", version: 1, userId: "u1", agentId: "agent-1",
  description: "Buy size 10 trail runners, max $120, from RunCo only",
  currency: "USD", maxAmountCents: 12000,
  allowedMerchantIds: ["runco"], allowedCategories: ["footwear"],
  validFrom: "2026-11-01T00:00:00Z", expiresAt: "2026-11-02T00:00:00Z", nonce: "abcdef123456",
};
const ok: Purchase = { merchantId: "runco", amountCents: 11500, currency: "USD", category: "footwear", at: "2026-11-01T12:00:00Z" };

describe("signing", () => {
  it("verifies a genuine mandate", () => {
    const k = generateKeys();
    expect(verifyMandate(signMandate(mandate, k.privateKeyPem), k.publicKeyPem)).toBe(true);
  });
  it("rejects a tampered limit", () => {
    const k = generateKeys();
    const sm = signMandate(mandate, k.privateKeyPem);
    sm.mandate = { ...sm.mandate, maxAmountCents: 99999 };
    expect(verifyMandate(sm, k.publicKeyPem)).toBe(false);
  });
  it("rejects a signature from a different key", () => {
    const a = generateKeys(), b = generateKeys();
    expect(verifyMandate(signMandate(mandate, a.privateKeyPem), b.publicKeyPem)).toBe(false);
  });
  it("ignores key order when hashing", () => {
    const k = generateKeys();
    const sm = signMandate(mandate, k.privateKeyPem);
    const reordered = { ...sm, mandate: Object.fromEntries(Object.entries(sm.mandate).reverse()) as Mandate };
    expect(verifyMandate(reordered, k.publicKeyPem)).toBe(true);
  });
});

describe("checkPurchase", () => {
  it("passes a purchase within the mandate", () => expect(checkPurchase(mandate, ok)).toEqual([]));
  it("flags an amount over the limit with the excess", () => {
    const f = checkPurchase(mandate, { ...ok, amountCents: 13500 });
    expect(f.map(x => x.code)).toEqual(["AMOUNT_EXCEEDS_MAX"]);
    expect(f[0].details?.excessCents).toBe(1500);
  });
  it("flags a merchant outside the mandate", () => {
    expect(checkPurchase(mandate, { ...ok, merchantId: "other" }).map(x => x.code)).toContain("MERCHANT_NOT_ALLOWED");
  });
  it("flags an expired mandate", () => {
    expect(checkPurchase(mandate, { ...ok, at: "2026-11-03T00:00:00Z" }).map(x => x.code)).toContain("MANDATE_EXPIRED");
  });
  it("flags a purchase made before the mandate was valid", () => {
    expect(checkPurchase(mandate, { ...ok, at: "2026-10-31T00:00:00Z" }).map(x => x.code)).toContain("MANDATE_NOT_YET_VALID");
  });
  it("flags a wrong category", () => {
    expect(checkPurchase(mandate, { ...ok, category: "electronics" }).map(x => x.code)).toContain("CATEGORY_NOT_ALLOWED");
  });
  it("flags a currency mismatch without also flagging the amount", () => {
    const codes = checkPurchase(mandate, { ...ok, currency: "EUR", amountCents: 99999 }).map(x => x.code);
    expect(codes).toContain("CURRENCY_MISMATCH");
    expect(codes).not.toContain("AMOUNT_EXCEEDS_MAX");
  });
});

describe("revoked mandates", () => {
  it("blocks a purchase made after revocation but not before", () => {
    const codes = (revokedAt: string) => checkPurchase(mandate, ok, { revokedAt }).map(f => f.code);
    expect(codes("2026-11-01T10:00:00Z")).toContain("MANDATE_REVOKED");
    expect(codes("2026-11-01T13:00:00Z")).not.toContain("MANDATE_REVOKED");
  });
});

describe("checkCumulative", () => {
  const m: Mandate = { ...mandate, maxTotalAmountCents: 20000, maxPurchases: 2 };
  it("passes while count and total stay within the limits", () => {
    expect(checkCumulative(m, 9500, { spentAmountCents: 9500, purchaseCount: 1 })).toEqual([]);
  });
  it("flags the purchase that would exceed the total, with the remaining budget", () => {
    const f = checkCumulative(m, 9500, { spentAmountCents: 11000, purchaseCount: 1 });
    expect(f.map(x => x.code)).toEqual(["CUMULATIVE_AMOUNT_EXCEEDED"]);
    expect(f[0].details).toMatchObject({ remainingCents: 9000 });
  });
  it("flags a purchase beyond the purchase count", () => {
    expect(checkCumulative(m, 100, { spentAmountCents: 100, purchaseCount: 2 }).map(x => x.code)).toEqual(["PURCHASE_COUNT_EXCEEDED"]);
  });
  it("reports both when both are exceeded", () => {
    expect(checkCumulative(m, 15000, { spentAmountCents: 15000, purchaseCount: 2 }).map(x => x.code)).toEqual(["PURCHASE_COUNT_EXCEEDED", "CUMULATIVE_AMOUNT_EXCEEDED"]);
  });
  it("applies the default purchase limit only when the mandate sets none", () => {
    expect(checkCumulative(mandate, 100, { spentAmountCents: 0, purchaseCount: 1 }, 1).map(x => x.code)).toEqual(["PURCHASE_COUNT_EXCEEDED"]);
    expect(checkCumulative(mandate, 100, { spentAmountCents: 0, purchaseCount: 5 })).toEqual([]);
    expect(checkCumulative({ ...mandate, maxPurchases: 9 }, 100, { spentAmountCents: 0, purchaseCount: 5 }, 1)).toEqual([]);
  });
});

describe("pause and payment authorization checks", () => {
  it("flags a purchase made while the agent was paused, with the user's reason", () => {
    const f = checkPurchase(mandate, ok, { agentPaused: { reason: "lost my phone" } });
    expect(f.map(x => x.code)).toEqual(["AGENT_PAUSED"]);
    expect(f[0].message).toContain("lost my phone");
  });
  it("includes the revocation reason in the finding", () => {
    const f = checkPurchase(mandate, ok, { revokedAt: "2026-11-01T10:00:00Z", revokedReason: "changed my mind" });
    expect(f[0].message).toContain("changed my mind");
  });
  const now = new Date("2026-11-01T12:00:00Z");
  it("accepts an active, unexpired payment authorization", () => {
    expect(checkPaymentAuthorization({ status: "ACTIVE", expiresAt: "2026-11-02T00:00:00Z" }, now)).toEqual([]);
    expect(checkPaymentAuthorization({ status: "ACTIVE", expiresAt: null }, now)).toEqual([]);
  });
  it("rejects a revoked or expired payment authorization", () => {
    expect(checkPaymentAuthorization({ status: "REVOKED" }, now).map(f => f.code)).toEqual(["PAYMENT_AUTHORIZATION_REVOKED"]);
    expect(checkPaymentAuthorization({ status: "ACTIVE", expiresAt: "2026-11-01T11:00:00Z" }, now).map(f => f.code)).toEqual(["PAYMENT_AUTHORIZATION_EXPIRED"]);
  });
});
