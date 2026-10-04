import type { Finding } from "../mandate/types.js";

export type DisputeAction = "contest" | "offer_partial_refund" | "accept_claim" | "escalate_to_human";

export interface DisputeInput {
  /** PayPal dispute reason code. Exact values must be confirmed against the sandbox. */
  reason: string;
  orderAmountCents: number;
  signatureValid: boolean;
  findings: Finding[];
  hasDeliveryProof: boolean;
  currency?: string;                             // only used to word messages
}
export interface DisputeDecision {
  action: DisputeAction;
  reason: string;
  refundCents?: number;
}

const AUTHORIZATION_REASONS = new Set(["UNAUTHORISED", "UNAUTHORIZED"]);

/**
 * Deterministic proposal. The LLM explains it and drafts the notes; it cannot change it.
 * The merchant approves before anything is submitted to PayPal.
 */
export function decideDisputeResponse(i: DisputeInput): DisputeDecision {
  if (!i.signatureValid) {
    return { action: "accept_claim", reason: "No valid signed mandate, so authorization cannot be shown." };
  }

  const blocks = i.findings.filter(f => f.severity === "block");
  if (blocks.length > 0) {
    const onlyAmount = blocks.every(f => f.code === "AMOUNT_EXCEEDS_MAX");
    const excess = Number(blocks[0]?.details?.excessCents ?? 0);
    if (onlyAmount && excess > 0 && excess < i.orderAmountCents) {
      return {
        action: "offer_partial_refund",
        refundCents: excess,
        reason: `Purchase was authorized up to the mandate maximum; the ${(excess / 100).toFixed(2)}${i.currency ? ` ${i.currency}` : ""} excess is not covered.`,
      };
    }
    return { action: "accept_claim", reason: `Purchase fell outside the mandate: ${blocks.map(b => b.code).join(", ")}.` };
  }

  if (AUTHORIZATION_REASONS.has(i.reason)) {
    return { action: "contest", reason: "A valid signed mandate covers this purchase in full." };
  }
  // The mandate proves authorization, not delivery.
  return i.hasDeliveryProof
    ? { action: "contest", reason: "Purchase was authorized and delivery proof is on file." }
    : { action: "escalate_to_human", reason: "Purchase was authorized, but there is no delivery proof for this dispute reason." };
}
