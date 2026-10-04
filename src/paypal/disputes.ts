import type { Config } from "../config.js";
import { ppFetch, toDecimal } from "./client.js";

type Creds = Pick<Config, "PAYPAL_CLIENT_ID" | "PAYPAL_CLIENT_SECRET">;

export interface PayPalDispute {
  dispute_id: string;
  reason?: string;
  status?: string;
  dispute_amount?: { currency_code: string; value: string };
  disputed_transactions?: { seller_transaction_id?: string; buyer_transaction_id?: string; custom?: string }[];
  /** What PayPal currently allows, e.g. { accept_claim: { accept_claim_types: ["REFUND"] } }. */
  allowed_response_options?: Record<string, unknown>;
  /** HATEOAS links. The rels present (accept_claim, provide_evidence, make_offer...) are the actions PayPal allows now. */
  links?: { rel: string; href?: string; method?: string }[];
}

/** The seam the service depends on, so tests (and the demo) can swap in a fake. */
export interface DisputesApi {
  get(disputeId: string): Promise<PayPalDispute>;
  provideEvidence(disputeId: string, note: string, requestId: string): Promise<unknown>;
  makeOffer(disputeId: string, o: { note: string; amountCents: number; currency: string }, requestId: string): Promise<unknown>;
  acceptClaim(disputeId: string, note: string, requestId: string): Promise<unknown>;
}

/**
 * Real sandbox client. Verified against the sandbox (Oct 2026): provide-evidence accepts a JSON body
 * with evidence_type "OTHER" for an UNAUTHORISED dispute in the CHARGEBACK stage.
 * Accept-claim sends accept_claim_type "REFUND" (the only type PayPal allowed for that dispute);
 * make-offer is NOT offered at that stage, so it stays unverified.
 */
export function paypalDisputes(cfg: Creds): DisputesApi {
  const base = (id: string) => `/v1/customer/disputes/${encodeURIComponent(id)}`;
  return {
    get: id => ppFetch<PayPalDispute>(cfg, base(id)),
    provideEvidence: (id, note, requestId) =>
      ppFetch(cfg, `${base(id)}/provide-evidence`, {
        requestId, body: { evidences: [{ evidence_type: "OTHER", notes: note }] },
      }),
    makeOffer: (id, o, requestId) =>
      ppFetch(cfg, `${base(id)}/make-offer`, {
        requestId, body: { note: o.note, offer_amount: { currency_code: o.currency, value: toDecimal(o.amountCents) } },
      }),
    acceptClaim: (id, note, requestId) =>
      ppFetch(cfg, `${base(id)}/accept-claim`, {
        requestId, body: { note, accept_claim_type: "REFUND" },
      }),
  };
}