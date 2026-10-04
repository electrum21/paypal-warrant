import type { Finding, Mandate, Purchase } from "./types.js";

const money = (cents: number, cur: string) => `${(cents / 100).toFixed(2)} ${cur}`;

/**
 * Deterministic check of a purchase against a mandate. No LLM involved.
 * An empty result means the purchase is within the mandate.
 */
export function checkPurchase(m: Mandate, p: Purchase, opts: { revokedAt?: string | null } = {}): Finding[] {
  const f: Finding[] = [];
  const at = Date.parse(p.at);

  if (at < Date.parse(m.validFrom)) {
    f.push({ code: "MANDATE_NOT_YET_VALID", severity: "block", message: "Purchase happened before the mandate became valid." });
  }
  if (at > Date.parse(m.expiresAt)) {
    f.push({ code: "MANDATE_EXPIRED", severity: "block", message: "Purchase happened after the mandate expired." });
  }
  if (!m.allowedMerchantIds.includes(p.merchantId)) {
    f.push({ code: "MERCHANT_NOT_ALLOWED", severity: "block", message: `Merchant ${p.merchantId} is not in the mandate.` });
  }
  if (p.currency !== m.currency) {
    f.push({ code: "CURRENCY_MISMATCH", severity: "block", message: `Purchase is in ${p.currency}; mandate is in ${m.currency}.` });
  } else if (p.amountCents > m.maxAmountCents) {
    f.push({
      code: "AMOUNT_EXCEEDS_MAX", severity: "block",
      message: `Amount ${money(p.amountCents, p.currency)} exceeds the mandate maximum of ${money(m.maxAmountCents, m.currency)}.`,
      details: { excessCents: p.amountCents - m.maxAmountCents },
    });
  }
  if (m.allowedCategories && (!p.category || !m.allowedCategories.includes(p.category))) {
    f.push({ code: "CATEGORY_NOT_ALLOWED", severity: "block", message: `Category "${p.category ?? "none"}" is not covered by the mandate.` });
  }
  if (opts.revokedAt && Date.parse(opts.revokedAt) <= at) {
    f.push({ code: "MANDATE_REVOKED", severity: "block", message: "The user revoked the mandate before this purchase." });
  }
  return f;
}
