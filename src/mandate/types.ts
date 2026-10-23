import { z } from "zod";

/** A deliberately small, AP2-inspired mandate. Not the AP2 standard. */
export const Mandate = z.object({
  id: z.string().min(1),
  version: z.literal(1),
  userId: z.string().min(1),
  agentId: z.string().min(1),
  description: z.string(),                       // what the user actually said, in plain English
  currency: z.string().length(3),
  maxAmountCents: z.number().int().positive(),      // per purchase
  /** Cumulative cap across every purchase under this mandate. Signed by the user, so the agent cannot raise it. */
  maxTotalAmountCents: z.number().int().positive().optional(),
  /** How many purchases this mandate may fund. Autonomous checkout treats an unset value as 1 (single use). */
  maxPurchases: z.number().int().positive().optional(),
  /** Above this amount, an AUTONOMOUS (no-click) purchase is held for the user's explicit approval instead of
   * being charged immediately. Signed by the user, so the agent cannot raise or remove it. Has no effect on
   * "approve"-mode checkout, where the buyer already approves every purchase on PayPal. */
  requireApprovalAboveCents: z.number().int().positive().optional(),
  allowedMerchantIds: z.array(z.string()).min(1),
  allowedCategories: z.array(z.string()).optional(),
  validFrom: z.string(),                         // ISO 8601
  expiresAt: z.string(),                         // ISO 8601
  nonce: z.string().min(8),
});
export type Mandate = z.infer<typeof Mandate>;

/** Signed by the USER's key. Proves the user set these limits; the agent cannot forge or widen them. */
export interface SignedMandate {
  mandate: Mandate;
  mandateHash: string;                           // sha256 of canonical JSON, hex
  signature: string;                             // ed25519 by the user key, base64
}

/** One concrete purchase the agent asks to make under a mandate. */
export const Cart = z.object({
  cartId: z.string().min(8),                     // unique per purchase; a merchant accepts each id once
  mandateId: z.string().min(1),
  mandateHash: z.string().min(1),
  agentId: z.string().min(1),
  merchantId: z.string().min(1),
  amountCents: z.number().int().positive(),
  currency: z.string().length(3),
  category: z.string().optional(),
  /** The catalog product (Channel3 id) the agent chose. Signed by the agent, so it commits to WHICH item it bought; the merchant can verify it. */
  productId: z.string().min(1).max(100).optional(),
  createdAt: z.string(),                         // ISO 8601, set by the agent (evidence only)
});
export type Cart = z.infer<typeof Cart>;

/** Signed by the AGENT's key. Proves this agent chose this exact purchase under this exact mandate. */
export interface SignedCart {
  cart: Cart;
  cartHash: string;
  signature: string;                             // ed25519 by the agent key, base64
}

/** Result of checking who signed what. `ok` requires every part to hold. */
export interface AuthorizationCheck {
  ok: boolean;
  mandateSignedByUser: boolean;
  cartSignedByAgent: boolean;
  cartBoundToMandate: boolean;
  cartMatchesPurchase: boolean;
  problems: string[];                            // plain-language reasons, empty when ok
}

export interface Purchase {
  merchantId: string;
  amountCents: number;
  currency: string;
  category?: string;
  at: string;                                    // ISO 8601, when the purchase was made
}

export type Severity = "info" | "warn" | "block";
export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  details?: Record<string, number | string>;
}