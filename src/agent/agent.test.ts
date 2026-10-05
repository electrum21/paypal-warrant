import { describe, expect, it } from "vitest";
import { openDb } from "../db/index.js";
import { DEMO_CATALOG, newAgent, newUser, planShoppingRequest, SCENARIOS, type Scenario } from "./buyer.js";
import { runOffline } from "./offline.js";

describe("demo scenarios through the real pipeline", () => {
  for (const s of Object.keys(SCENARIOS) as Scenario[]) {
    it(`${s} leads to ${SCENARIOS[s].expect}`, async () => {
      const r = await runOffline(s, { db: openDb(), agent: newAgent() });
      expect(r.proposal.decision?.action).toBe(SCENARIOS[s].expect);
      expect(r.sentBeforeApproval).toBe(0);
      expect(r.approved.workflowState).toBe("SUBMITTED");
      expect(r.sent).toHaveLength(1);
    });
  }
  it("shares one database across runs without clashing", async () => {
    const db = openDb(), agent = newAgent();
    await runOffline("within", { db, agent });
    await runOffline("over", { db, agent });
    expect((await runOffline("category", { db, agent })).proposal.id).toBe(3);
  });
  it("turns a natural-language request into a signed, budget-aware plan", () => {
    const plan = planShoppingRequest("Buy trail running shoes under $120", newUser(), newAgent(), "warrant-demo-merchant", DEMO_CATALOG);
    expect(plan.product.id).toBe("trail-a");
    expect(plan.intent.maxAmountCents).toBe(12000);
    expect(plan.mandate.mandate.allowedCategories).toEqual(["footwear"]);
  });
  it("refuses a shopping request when no eligible product exists", () => {
    expect(() => planShoppingRequest("Buy trail running shoes under $50", newUser(), newAgent(), "warrant-demo-merchant", DEMO_CATALOG))
      .toThrow("No product matched");
  });
});