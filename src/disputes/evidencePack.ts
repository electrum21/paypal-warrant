import type { DisputeDecision } from "./decide.js";
import type { AuthorizationCheck, Finding, Purchase, SignedCart, SignedMandate } from "../mandate/types.js";

export interface EvidencePackInput {
  disputeId: string;
  paypalOrderId: string;
  signed: SignedMandate;
  signatureValid: boolean;
  signedCart?: SignedCart;                       // the agent-signed purchase request, when the order has one
  authorization?: AuthorizationCheck;            // who signed what; signatureValid is its overall result
  purchase: Purchase;
  findings: Finding[];
  decision: DisputeDecision;
  /** What the user (or the merchant admin, for stop actions) did to limit the agent. Shown so a revocation is part of the record. */
  userControls?: { action: string; subjectId: string; reason?: string; appliedAt: string; via: string }[];
  generatedAt: string;                           // injected so output is deterministic
}

export interface EvidencePack {
  json: Record<string, unknown>;
  notes: string;                                 // plain text suitable for a PayPal evidence note
}

export function buildEvidencePack(i: EvidencePackInput): EvidencePack {
  const m = i.signed.mandate;
  const lines = [
    `Evidence summary for dispute ${i.disputeId} (order ${i.paypalOrderId})`,
    `Generated: ${i.generatedAt}`,
    ``,
    `1. Mandate: id ${m.id}, signed by user ${m.userId}, delegated to agent ${m.agentId}.`,
    `   User instruction: "${m.description}"`,
    `   Limit: ${m.maxAmountCents} minor units ${m.currency}; valid ${m.validFrom} to ${m.expiresAt}.`,
    `   Content hash (sha256): ${i.signed.mandateHash}`,
    `2. Signature check: ${i.signatureValid ? "VALID" : "INVALID"}.`,
    ...(i.authorization ? [
      `   Mandate signed by the registered key of user ${m.userId}: ${i.authorization.mandateSignedByUser ? "yes" : "no"}.`,
      `   Cart signed by the registered key of agent ${m.agentId}: ${i.authorization.cartSignedByAgent ? "yes" : "no"}`
        + (i.signedCart ? ` (cart ${i.signedCart.cart.cartId}, sha256 ${i.signedCart.cartHash}).` : " (no cart on file)."),
      `   Cart bound to this mandate: ${i.authorization.cartBoundToMandate ? "yes" : "no"}; cart matches the purchase: ${i.authorization.cartMatchesPurchase ? "yes" : "no"}.`,
      ...i.authorization.problems.map(p => `   Problem: ${p}`),
    ] : []),
    `3. Purchase: ${i.purchase.amountCents} ${i.purchase.currency} at merchant ${i.purchase.merchantId} on ${i.purchase.at}.`,
    `4. Findings: ${i.findings.length === 0 ? "purchase is within the mandate" : i.findings.map(f => f.code).join(", ")}.`,
    ...(i.userControls?.length ? [
      `   User control actions on record: ${i.userControls.map(c => `${c.action} (${c.subjectId}) at ${c.appliedAt} via ${c.via}${c.reason ? `, reason: ${c.reason}` : ""}`).join("; ")}.`,
    ] : []),
    `5. Proposed response: ${i.decision.action}. ${i.decision.reason}`,
  ];
  return {
    notes: lines.join("\n"),
    json: {
      disputeId: i.disputeId,
      paypalOrderId: i.paypalOrderId,
      generatedAt: i.generatedAt,
      mandate: i.signed,
      signatureValid: i.signatureValid,
      cart: i.signedCart ?? null,
      authorization: i.authorization ?? null,
      purchase: i.purchase,
      findings: i.findings,
      userControls: i.userControls ?? [],
      decision: i.decision,
    },
  };
}