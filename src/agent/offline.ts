import type { Db } from "../db/index.js";
import type { LlmClient } from "../ai/draft.js";
import { checkPurchase } from "../mandate/check.js";
import { verifyMandate } from "../mandate/sign.js";
import type { Purchase } from "../mandate/types.js";
import { recordOrder, registerAgentKey, saveMandate } from "../repo.js";
import type { DisputesApi } from "../paypal/disputes.js";
import { approveDispute, processDispute } from "../disputes/service.js";
import { buildMandate, SCENARIOS, signFor, type DemoAgent, type Scenario } from "./buyer.js";

/**
 * Runs the whole story with a FAKE PayPal: agent signs, merchant verifies and records the order,
 * buyer "disputes", Warrant proposes, merchant approves. The real pipeline code runs; only the
 * PayPal HTTP calls are replaced, so no credentials or network are needed.
 */
export async function runOffline(
  scenario: Scenario,
  o: { db: Db; agent: DemoAgent; llm?: LlmClient; merchantId?: string },
) {
  const { db, agent } = o;
  const buyerTrace: { tool: string; input: unknown; output: unknown }[] = [];
  const tool = (name: string, input: unknown, output: unknown) => buyerTrace.push({ tool: name, input, output });
  const merchantId = o.merchantId ?? "warrant-demo-merchant";
  const sc = SCENARIOS[scenario];

  registerAgentKey(db, agent.agentId, agent.publicKeyPem);
  tool("parse_user_request", { request: sc.label }, { category: sc.category, budgetCents: 12000 });
  const mandate = buildMandate(agent, merchantId);
  const signed = signFor(agent, mandate);
  tool("create_signed_mandate", { category: sc.category, maxAmountCents: mandate.maxAmountCents }, { mandateId: mandate.id });
  if (!verifyMandate(signed, agent.publicKeyPem)) throw new Error("demo mandate failed verification");
  tool("verify_own_signature", { mandateId: mandate.id }, { valid: true });

  const purchase: Purchase = { merchantId, amountCents: sc.amountCents, currency: "USD", category: sc.category, at: new Date().toISOString() };
  const findings = checkPurchase(mandate, purchase);
  tool("check_purchase", { amountCents: purchase.amountCents, category: purchase.category }, { findings: findings.map(f => f.code) });
  saveMandate(db, signed);
  const captureId = `CAP-${mandate.id}`;
  recordOrder(db, {
    paypalOrderId: `ORD-${mandate.id}`, mandateId: mandate.id, merchantId, amountCents: sc.amountCents,
    currency: "USD", category: sc.category, findings, at: purchase.at, captureId,
  });

  const disputeId = `DISP-${mandate.id}`;
  const sent: { call: string; detail: unknown }[] = [];
  const fakePayPal: DisputesApi = {
    get: async id => ({
      dispute_id: id, reason: "UNAUTHORISED", status: "OPEN",
      dispute_amount: { currency_code: "USD", value: (sc.amountCents / 100).toFixed(2) },
      disputed_transactions: [{ seller_transaction_id: captureId }],
    }),
    provideEvidence: async (_id, note) => { sent.push({ call: "provide-evidence", detail: { chars: note.length } }); },
    makeOffer: async (_id, offer) => { sent.push({ call: "make-offer", detail: { amountCents: offer.amountCents, currency: offer.currency } }); },
    acceptClaim: async () => { sent.push({ call: "accept-claim", detail: {} }); },
  };
  const deps = { db, disputes: fakePayPal, llm: o.llm };
  const proposal = await processDispute(deps, disputeId);
  const sentBeforeApproval = sent.length;
  const approved = await approveDispute(deps, proposal.id);
  return { scenario, mandate, findings, proposal, approved, sent, sentBeforeApproval, buyerTrace };
}
