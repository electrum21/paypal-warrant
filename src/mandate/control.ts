import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "./sign.js";

/**
 * User-signed control requests: revoke a mandate, pause or resume the user's agent, revoke the saved payment
 * source, or approve/decline a held autonomous checkout.
 * Signed with the USER's key (the one that signs mandates), so the merchant admin token is not the only way to stop an agent.
 */
export const CONTROL_ACTIONS = [
  "revoke_mandate", "pause_agent", "resume_agent", "revoke_payment_authorization", "view_orders",
  "approve_checkout", "decline_checkout",
] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export const ControlRequest = z.object({
  action: z.enum(CONTROL_ACTIONS),
  userId: z.string().min(1),
  /** The mandate id for revoke_mandate; the user id for every other action. */
  subjectId: z.string().min(1),
  reason: z.string().max(300).optional(),
  issuedAt: z.string(),                          // ISO 8601; rejected if too old or in the future
  nonce: z.string().min(8),                      // each nonce is accepted once
});
export type ControlRequest = z.infer<typeof ControlRequest>;

export interface SignedControl { request: ControlRequest; signature: string }

/** A request is only accepted this close to the server's clock. Together with nonce tracking this stops replay. */
export const CONTROL_MAX_AGE_MS = 5 * 60_000;

// Domain tag: a signature over a control request can never be mistaken for one over a mandate or cart.
const payload = (r: ControlRequest) => Buffer.from(canonicalize({ type: "warrant.control.v1", request: r }));

export function signControl(request: ControlRequest, userPrivateKeyPem: string): SignedControl {
  return { request, signature: sign(null, payload(request), createPrivateKey(userPrivateKeyPem)).toString("base64") };
}

export function verifyControl(sc: SignedControl, userPublicKeyPem: string): boolean {
  try {
    return verify(null, payload(sc.request), createPublicKey(userPublicKeyPem), Buffer.from(sc.signature, "base64"));
  } catch {
    return false;
  }
}

export function controlIsFresh(r: ControlRequest, now = new Date()): boolean {
  const t = Date.parse(r.issuedAt);
  return Number.isFinite(t) && Math.abs(now.getTime() - t) <= CONTROL_MAX_AGE_MS;
}
