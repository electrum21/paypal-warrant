import { describe, expect, it } from "vitest";
import { decideDisputeResponse } from "./decide.js";
import { buildEvidencePack } from "./evidencePack.js";
import { generateKeys, signMandate } from "../mandate/sign.js";
import type { Finding, Mandate, Purchase } from "../mandate/types.js";

const base = { reason: "UNAUTHORISED", orderAmountCents: 11500, signatureValid: true, findings: [] as Finding[], hasDeliveryProof: false };

describe("decideDisputeResponse", () => {
  it("contests an authorization dispute when a valid mandate covers the purchase", () => {
    expect(decideDisputeResponse(base).action).toBe("contest");
  });
  it("accepts the claim when the signature is invalid", () => {
    expect(decideDisputeResponse({ ...base, signatureValid: false }).action).toBe("accept_claim");
  });
  it("offers a partial refund for exactly the excess over the mandate", () => {
    const findings: Finding[] = [{ code: "AMOUNT_EXCEEDS_MAX", severity: "block", message: "x", details: { excessCents: 1500 } }];
    const d = decideDisputeResponse({ ...base, orderAmountCents: 13500, findings });
    expect(d.action).toBe("offer_partial_refund");
    expect(d.refundCents).toBe(1500);
  });
  it("accepts the claim when the merchant was outside the mandate", () => {
    const findings: Finding[] = [{ code: "MERCHANT_NOT_ALLOWED", severity: "block", message: "x" }];
    expect(decideDisputeResponse({ ...base, findings }).action).toBe("accept_claim");
  });
  it("escalates a not-received dispute that has no delivery proof", () => {
    expect(decideDisputeResponse({ ...base, reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" }).action).toBe("escalate_to_human");
  });
  it("contests a not-received dispute when delivery proof exists", () => {
    expect(decideDisputeResponse({ ...base, reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", hasDeliveryProof: true }).action).toBe("contest");
  });
});

describe("buildEvidencePack", () => {
  it("includes the mandate hash, signature result and proposed action", () => {
    const k = generateKeys();
    const mandate: Mandate = {
      id: "m1", version: 1, userId: "u1", agentId: "a1", description: "buy shoes under $120", currency: "USD",
      maxAmountCents: 12000, allowedMerchantIds: ["runco"], validFrom: "2026-11-01T00:00:00Z",
      expiresAt: "2026-11-02T00:00:00Z", nonce: "abcdef123456",
    };
    const signed = signMandate(mandate, k.privateKeyPem);
    const purchase: Purchase = { merchantId: "runco", amountCents: 11500, currency: "USD", at: "2026-11-01T12:00:00Z" };
    const pack = buildEvidencePack({
      disputeId: "PP-D-1", paypalOrderId: "ORDER1", signed, signatureValid: true, purchase, findings: [],
      decision: decideDisputeResponse(base), generatedAt: "2026-11-05T00:00:00Z",
    });
    expect(pack.notes).toContain(signed.mandateHash);
    expect(pack.notes).toContain("VALID");
    expect(pack.notes).toContain("contest");
  });
});
