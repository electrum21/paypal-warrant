import { describe, expect, it } from "vitest";
import { openDb } from "../db/index.js";
import { generateKeys, signCart, signMandate } from "../mandate/sign.js";
import type { Cart, Mandate } from "../mandate/types.js";
import { recordControlEvent, recordOrder, registerAgentKey, registerUserKey, revokeMandate, saveMandate } from "../repo.js";
import type { DisputesApi, PayPalDispute } from "../paypal/disputes.js";
import { approveDispute, listDisputes, processDispute, rejectDispute } from "./service.js";

const mandate: Mandate = {
  id: "m1", version: 1, userId: "u1", agentId: "agent-1", description: "Buy trail runners, max $120, RunCo only",
  currency: "USD", maxAmountCents: 12000, allowedMerchantIds: ["runco"], allowedCategories: ["footwear"],
  validFrom: "2026-11-01T00:00:00Z", expiresAt: "2026-11-02T00:00:00Z", nonce: "abcdef123456",
};

function setup(opts: {
  amountCents?: number; keyMismatch?: boolean; order?: boolean;
  /** The agent signs the mandate itself instead of the user (the old, self-issued model). */
  agentSignsMandate?: boolean; noCart?: boolean; cartAmountCents?: number;
} = {}) {
  const db = openDb();
  const userKeys = generateKeys(), agentKeys = generateKeys();
  registerUserKey(db, "u1", opts.keyMismatch ? generateKeys().publicKeyPem : userKeys.publicKeyPem);
  registerAgentKey(db, "agent-1", agentKeys.publicKeyPem);
  const signed = signMandate(mandate, (opts.agentSignsMandate ? agentKeys : userKeys).privateKeyPem);
  saveMandate(db, signed);
  const amountCents = opts.amountCents ?? 11500;
  const cart: Cart = {
    cartId: "cart-0001-abcdef", mandateId: "m1", mandateHash: signed.mandateHash, agentId: "agent-1",
    merchantId: "runco", amountCents: opts.cartAmountCents ?? amountCents, currency: "USD", category: "footwear",
    createdAt: "2026-11-01T12:00:00Z",
  };
  if (opts.order !== false) {
    recordOrder(db, {
      paypalOrderId: "ORD-1", mandateId: "m1", merchantId: "runco", amountCents,
      currency: "USD", category: "footwear", findings: [], at: "2026-11-01T12:00:00Z", captureId: "CAP-1",
      signedCart: opts.noCart ? undefined : signCart(cart, agentKeys.privateKeyPem),
    });
  }
  const calls: { fn: string; args: unknown[] }[] = [];
  let failNext = false;
  const dispute = (over: Partial<PayPalDispute> = {}): PayPalDispute => ({
    dispute_id: "PP-D-1", reason: "UNAUTHORISED", status: "OPEN",
    dispute_amount: { currency_code: "USD", value: ((opts.amountCents ?? 11500) / 100).toFixed(2) },
    disputed_transactions: [{ seller_transaction_id: "CAP-1" }], ...over,
  });
  const api: DisputesApi = {
    get: async id => dispute({ dispute_id: id }),
    provideEvidence: async (...a) => { calls.push({ fn: "provideEvidence", args: a }); if (failNext) { failNext = false; throw new Error("PayPal 422"); } },
    makeOffer: async (...a) => { calls.push({ fn: "makeOffer", args: a }); },
    acceptClaim: async (...a) => { calls.push({ fn: "acceptClaim", args: a }); },
  };
  return { db, deps: { db, disputes: api, now: () => new Date("2026-11-05T00:00:00Z") }, calls, failOnce: () => { failNext = true; } };
}

describe("who signed the mandate", () => {
  it("accepts the claim when the agent signed the mandate instead of the user", async () => {
    const { deps } = setup({ agentSignsMandate: true });
    const r = await processDispute(deps, "PP-D-1");
    expect(r.signatureValid).toBe(false);
    expect(r.authorization?.mandateSignedByUser).toBe(false);
    expect(r.authorization?.cartSignedByAgent).toBe(true);
    expect(r.decision?.action).toBe("accept_claim");
  });
  it("accepts the claim when the order has no agent-signed cart", async () => {
    const { deps } = setup({ noCart: true });
    const r = await processDispute(deps, "PP-D-1");
    expect(r.signatureValid).toBe(false);
    expect(r.decision?.action).toBe("accept_claim");
    expect(r.evidenceNote).toContain("No signed cart");
  });
  it("accepts the claim when the signed cart does not match the order that was recorded", async () => {
    const { deps } = setup({ cartAmountCents: 9000 });
    const r = await processDispute(deps, "PP-D-1");
    expect(r.authorization?.cartMatchesPurchase).toBe(false);
    expect(r.decision?.action).toBe("accept_claim");
  });
  it("records both signers in the evidence note when everything verifies", async () => {
    const { deps } = setup();
    const r = await processDispute(deps, "PP-D-1");
    expect(r.signatureValid).toBe(true);
    expect(r.evidenceNote).toContain("signed by user u1");
    expect(r.evidenceNote).toContain("Cart signed by the registered key of agent agent-1: yes");
  });
});

describe("processDispute", () => {
  it("proposes contest when the purchase is within a valid mandate", async () => {
    const { deps } = setup();
    const r = await processDispute(deps, "PP-D-1");
    expect(r.decision?.action).toBe("contest");
    expect(r.signatureValid).toBe(true);
    expect(r.workflowState).toBe("PROPOSED");
    expect(r.narrativeSource).toBe("template");
    expect(r.evidenceNote).toContain("Signature check: VALID");
  });
  it("proposes a partial refund when only the amount is over", async () => {
    const { deps } = setup({ amountCents: 13500 });
    const r = await processDispute(deps, "PP-D-1");
    expect(r.decision).toMatchObject({ action: "offer_partial_refund", refundCents: 1500 });
  });
  it("proposes accepting when the signature does not verify", async () => {
    const { deps } = setup({ keyMismatch: true });
    expect((await processDispute(deps, "PP-D-1")).decision?.action).toBe("accept_claim");
  });
  it("treats a mandate revoked before the purchase as a block", async () => {
    const { db, deps } = setup();
    revokeMandate(db, "m1", "2026-11-01T10:00:00Z");
    const r = await processDispute(deps, "PP-D-1");
    expect(r.decision?.action).toBe("accept_claim");
    expect(r.findings?.map(f => f.code)).toContain("MANDATE_REVOKED");
  });
  const control = (db: ReturnType<typeof setup>["db"], action: "pause_agent" | "resume_agent" | "revoke_mandate", appliedAt: string, subjectId = "u1", reason?: string) =>
    recordControlEvent(db, { userId: "u1", action, subjectId, reason, issuedAt: appliedAt, appliedAt, nonce: `n-${action}-${appliedAt}`, via: "user_signature" });
  it("treats a purchase made while the agent was paused as a block, and records the control in the evidence", async () => {
    const { db, deps } = setup();                                   // the purchase is at 2026-11-01T12:00:00Z
    control(db, "pause_agent", "2026-11-01T11:00:00Z", "u1", "lost my phone");
    const r = await processDispute(deps, "PP-D-1");
    expect(r.decision?.action).toBe("accept_claim");
    expect(r.findings?.map(f => f.code)).toContain("AGENT_PAUSED");
    expect(r.evidenceNote).toContain("pause_agent");
    expect(r.evidenceNote).toContain("lost my phone");
    expect(r.agentEvents?.map(e => e.toolName)).toContain("check_user_controls");
  });
  it("does not count a pause or revocation issued after the purchase", async () => {
    const { db, deps } = setup();
    control(db, "pause_agent", "2026-11-01T13:00:00Z");
    control(db, "revoke_mandate", "2026-11-01T14:00:00Z", "m1");
    const r = await processDispute(deps, "PP-D-1");
    expect(r.decision?.action).toBe("contest");
    expect(r.findings).toEqual([]);
    expect(r.evidenceNote).toContain("revoke_mandate");              // still on record, but not held against the purchase
  });
  it("does not count a pause that was lifted before the purchase", async () => {
    const { db, deps } = setup();
    control(db, "pause_agent", "2026-11-01T09:00:00Z");
    control(db, "resume_agent", "2026-11-01T10:00:00Z");
    expect((await processDispute(deps, "PP-D-1")).findings).toEqual([]);
  });
  it("treats a control-log revocation before the purchase as a block", async () => {
    const { db, deps } = setup();
    control(db, "revoke_mandate", "2026-11-01T10:00:00Z", "m1", "changed my mind");
    const r = await processDispute(deps, "PP-D-1");
    expect(r.decision?.action).toBe("accept_claim");
    expect(r.findings?.find(f => f.code === "MANDATE_REVOKED")?.message).toContain("changed my mind");
  });
  it("escalates when no order matches", async () => {
    const { deps } = setup({ order: false });
    expect((await processDispute(deps, "PP-D-1")).decision?.action).toBe("escalate_to_human");
  });
  it("is idempotent for the same dispute", async () => {
    const { db, deps } = setup();
    const a = await processDispute(deps, "PP-D-1"), b = await processDispute(deps, "PP-D-1");
    expect(b.id).toBe(a.id);
    expect(listDisputes(db)).toHaveLength(1);
  });
  it("uses a validated LLM draft when one is provided", async () => {
    const { deps } = setup();
    const llm = async () => JSON.stringify({ explanation: "Contest it: the 115.00 USD purchase fit the 120.00 USD limit.", evidenceNote: "Signed mandate covers the 115.00 USD purchase." });
    const r = await processDispute({ ...deps, llm }, "PP-D-1");
    expect(r.narrativeSource).toBe("llm");
    expect(r.decision?.action).toBe("contest");
  });
});

describe("approveDispute", () => {
  it("sends nothing to PayPal until approved, then submits evidence once", async () => {
    const { deps, calls } = setup();
    const r = await processDispute(deps, "PP-D-1");
    expect(calls).toHaveLength(0);
    const done = await approveDispute(deps, r.id, "Edited by merchant");
    expect(done.workflowState).toBe("SUBMITTED");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe("provideEvidence");
    expect(calls[0]!.args[1]).toBe("Edited by merchant");
    await expect(approveDispute(deps, r.id)).rejects.toThrow("already submitted");
    expect(calls).toHaveLength(1);
  });
  it("makes an offer for the excess on a partial refund", async () => {
    const { deps, calls } = setup({ amountCents: 13500 });
    const r = await processDispute(deps, "PP-D-1");
    await approveDispute(deps, r.id);
    expect(calls[0]!.fn).toBe("makeOffer");
    expect(calls[0]!.args[1]).toMatchObject({ amountCents: 1500, currency: "USD" });
  });
  it("records a failure, then allows a retry with the same request id", async () => {
    const { deps, calls, failOnce } = setup();
    const r = await processDispute(deps, "PP-D-1");
    failOnce();
    const failed = await approveDispute(deps, r.id);
    expect(failed.workflowState).toBe("FAILED");
    expect(failed.submitError).toContain("422");
    const ok = await approveDispute(deps, r.id);
    expect(ok.workflowState).toBe("SUBMITTED");
    expect(calls[0]!.args[2]).toBe(calls[1]!.args[2]);
  });
  it("refuses to submit an escalated case", async () => {
    const { deps, calls } = setup({ order: false });
    const r = await processDispute(deps, "PP-D-1");
    await expect(approveDispute(deps, r.id)).rejects.toThrow("needs a human");
    expect(calls).toHaveLength(0);
  });
  it("rejecting blocks later approval", async () => {
    const { db, deps, calls } = setup();
    const r = await processDispute(deps, "PP-D-1");
    expect(rejectDispute(db, r.id).workflowState).toBe("REJECTED");
    await expect(approveDispute(deps, r.id)).rejects.toThrow("already rejected");
    expect(calls).toHaveLength(0);
  });
});

describe("responses PayPal does not currently allow", () => {
  const withLinks = (deps: ReturnType<typeof setup>["deps"], rels: string[], amountCents: number) => ({
    ...deps,
    disputes: {
      ...deps.disputes,
      get: async (id: string): Promise<PayPalDispute> => ({
        dispute_id: id, reason: "UNAUTHORISED", status: "UNDER_REVIEW",
        dispute_amount: { currency_code: "USD", value: (amountCents / 100).toFixed(2) },
        disputed_transactions: [{ seller_transaction_id: "CAP-1" }],
        links: rels.map(rel => ({ rel })),
      }),
    },
  });

  it("marks a partial-refund proposal as blocked when PayPal offers no make_offer, and refuses to submit it", async () => {
    const { deps, calls } = setup({ amountCents: 13500 });
    const d = withLinks(deps, ["self", "accept_claim", "provide_evidence"], 13500);
    const r = await processDispute(d, "PP-D-1");
    expect(r.decision).toMatchObject({ action: "offer_partial_refund", refundCents: 1500 });
    expect(r.blockedReason).toContain("partial-refund");
    expect(r.blockedReason).toContain("15.00 USD");
    expect(r.explanation).toContain(r.blockedReason!);
    await expect(approveDispute(d, r.id)).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(0);
  });

  it("does not block a contest when provide_evidence is offered", async () => {
    const { deps } = setup();
    const r = await processDispute(withLinks(deps, ["self", "accept_claim", "provide_evidence"], 11500), "PP-D-1");
    expect(r.decision?.action).toBe("contest");
    expect(r.blockedReason).toBeUndefined();
  });

  it("does not block anything when PayPal sent no links at all", async () => {
    const { deps } = setup({ amountCents: 13500 });
    const r = await processDispute(deps, "PP-D-1");
    expect(r.blockedReason).toBeUndefined();
  });
});