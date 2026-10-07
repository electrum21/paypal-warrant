import { describe, expect, it } from "vitest";
import { openDb } from "../db/index.js";
import { assessProduct } from "../integrations/channel3.js";
import { generateKeys, signCart, signMandate } from "../mandate/sign.js";
import type { Cart, Mandate } from "../mandate/types.js";
import { recordOrder, registerAgentKey, registerUserKey, saveMandate } from "../repo.js";
import type { DisputesApi, PayPalDispute } from "../paypal/disputes.js";
import { processDispute } from "../disputes/service.js";
import { buildAnalytics } from "./datasets.js";

const NOW = new Date("2026-11-05T00:00:00Z");
const base: Mandate = {
  id: "m1", version: 1, userId: "u1", agentId: "agent-1", description: "Buy trail runners, max $120", currency: "USD", maxAmountCents: 12000,
  allowedMerchantIds: ["runco"], allowedCategories: ["footwear"], validFrom: "2026-11-01T00:00:00Z", expiresAt: "2026-11-02T00:00:00Z", nonce: "abcdef123456",
};

function world() {
  const db = openDb();
  const userKeys = generateKeys(), a1 = generateKeys(), a2 = generateKeys();
  registerUserKey(db, "u1", userKeys.publicKeyPem);
  registerAgentKey(db, "agent-1", a1.publicKeyPem); registerAgentKey(db, "agent-2", a2.publicKeyPem);
  const add = (n: number, agent: "agent-1" | "agent-2", cents: number, keys: typeof a1, productId?: string) => {
    const m: Mandate = { ...base, id: `m${n}`, agentId: agent, nonce: `abcdef12345${n}` };
    const sm = signMandate(m, userKeys.privateKeyPem); saveMandate(db, sm);
    const cart: Cart = { cartId: `cart-000${n}-abcdef`, mandateId: m.id, mandateHash: sm.mandateHash, agentId: agent, merchantId: "runco", amountCents: cents,
      currency: "USD", category: "footwear", createdAt: "2026-11-01T12:00:00Z", ...(productId ? { productId } : {}) };
    return recordOrder(db, { paypalOrderId: `ORD-${n}`, mandateId: m.id, merchantId: "runco", amountCents: cents, currency: "USD", category: "footwear",
      findings: cents > 12000 ? [{ code: "AMOUNT_EXCEEDS_MAX", severity: "block", message: "over" }] : [], at: "2026-11-01T12:00:00Z", captureId: `CAP-${n}`,
      signedCart: signCart(cart, keys.privateKeyPem) });
  };
  add(1, "agent-1", 11500, a1); add(2, "agent-2", 15000, a2); add(3, "agent-2", 9000, a2);
  const api: DisputesApi = {
    get: async id => ({ dispute_id: id, reason: "UNAUTHORISED", status: "OPEN", dispute_amount: { currency_code: "USD", value: "150.00" },
      disputed_transactions: [{ seller_transaction_id: "CAP-2" }] } as PayPalDispute),
    provideEvidence: async () => {}, makeOffer: async () => {}, acceptClaim: async () => {},
  };
  return { db, deps: { db, disputes: api, now: () => NOW } };
}

describe("buildAnalytics", () => {
  it("flattens orders, flags out-of-mandate ones and marks the disputed order", async () => {
    const { db, deps } = world();
    await processDispute(deps, "PP-D-9");
    const a = buildAnalytics(db, NOW);
    expect(a.orders).toHaveLength(3);
    expect(a.orders.find(o => o.orderId === 2)).toMatchObject({ amount: 150, outOfMandate: "yes", disputed: "yes", agentId: "agent-2" });
    expect(a.orders.find(o => o.orderId === 1)).toMatchObject({ outOfMandate: "no", disputed: "no" });
  });

  it("describes a dispute in major units with the finding that drove the decision", async () => {
    const { db, deps } = world();
    await processDispute(deps, "PP-D-9");
    const [d] = buildAnalytics(db, NOW).disputes;
    expect(d).toMatchObject({ amount: 150, mandateLimit: 120, overLimitBy: 30, recommendedAction: "offer_partial_refund", primaryFinding: "AMOUNT_EXCEEDS_MAX", agentId: "agent-2", signature: "valid" });
  });

  it("ranks agents by dispute rate so risky agents surface first", async () => {
    const { db, deps } = world();
    await processDispute(deps, "PP-D-9");
    const { agents } = buildAnalytics(db, NOW);
    expect(agents[0]).toMatchObject({ agentId: "agent-2", orders: 2, disputes: 1, disputeRatePct: 50, outOfMandateOrders: 1, topFinding: "AMOUNT_EXCEEDS_MAX" });
    expect(agents[1]).toMatchObject({ agentId: "agent-1", disputes: 0, disputeRatePct: 0 });
  });

  it("carries the agent's trace so tool usage can be charted", async () => {
    const { db, deps } = world();
    await processDispute(deps, "PP-D-9");
    const { agentSteps } = buildAnalytics(db, NOW);
    expect(agentSteps.map(s => s.toolName)).toContain("verify_authorization");
    expect(agentSteps.every(s => s.agentType === "merchant-dispute")).toBe(true);
  });

  it("works on an empty database", () => {
    const a = buildAnalytics(openDb(), NOW);
    expect([a.disputes, a.orders, a.agents, a.agentSteps]).toEqual([[], [], [], []]);
  });

  it("surfaces Channel3 verdicts on disputes and orders", async () => {
    const { db, deps } = world();
    const check = assessProduct("p9", { id: "p9", title: "Phone", categories: ["Electronics > Phones"] }, { declaredCategory: "footwear", allowedCategories: ["footwear"], amountCents: 15000, currency: "USD" }, NOW);
    db.prepare("INSERT INTO product_checks (order_id, product_id, check_json) VALUES (2, 'p9', ?)").run(JSON.stringify(check));
    await processDispute(deps, "PP-D-9");
    const a = buildAnalytics(db, NOW);
    expect(a.orders.find(o => o.orderId === 2)?.productVerdict).toBe("not_allowed");
    expect(a.disputes[0].productVerdict).toBe("not_allowed");
  });
});
