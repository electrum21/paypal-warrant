import type { DisputeDecision } from "./decide.js";
import type { Finding, Purchase, SignedMandate } from "../mandate/types.js";

export interface EvidencePackInput {
  disputeId: string;
  paypalOrderId: string;
  signed: SignedMandate;
  signatureValid: boolean;
  purchase: Purchase;
  findings: Finding[];
  decision: DisputeDecision;
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
    `1. Mandate: id ${m.id}, issued to agent ${m.agentId} for user ${m.userId}.`,
    `   User instruction: "${m.description}"`,
    `   Limit: ${m.maxAmountCents} minor units ${m.currency}; valid ${m.validFrom} to ${m.expiresAt}.`,
    `   Content hash (sha256): ${i.signed.mandateHash}`,
    `2. Signature check: ${i.signatureValid ? "VALID" : "INVALID"}.`,
    `3. Purchase: ${i.purchase.amountCents} ${i.purchase.currency} at merchant ${i.purchase.merchantId} on ${i.purchase.at}.`,
    `4. Findings: ${i.findings.length === 0 ? "purchase is within the mandate" : i.findings.map(f => f.code).join(", ")}.`,
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
      purchase: i.purchase,
      findings: i.findings,
      decision: i.decision,
    },
  };
}
