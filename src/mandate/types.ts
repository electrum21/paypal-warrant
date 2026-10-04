import { z } from "zod";

/** A deliberately small, AP2-inspired mandate. Not the AP2 standard. */
export const Mandate = z.object({
  id: z.string().min(1),
  version: z.literal(1),
  userId: z.string().min(1),
  agentId: z.string().min(1),
  description: z.string(),                       // what the user actually said, in plain English
  currency: z.string().length(3),
  maxAmountCents: z.number().int().positive(),
  allowedMerchantIds: z.array(z.string()).min(1),
  allowedCategories: z.array(z.string()).optional(),
  validFrom: z.string(),                         // ISO 8601
  expiresAt: z.string(),                         // ISO 8601
  nonce: z.string().min(8),
});
export type Mandate = z.infer<typeof Mandate>;

export interface SignedMandate {
  mandate: Mandate;
  mandateHash: string;                           // sha256 of canonical JSON, hex
  signature: string;                             // ed25519, base64
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
