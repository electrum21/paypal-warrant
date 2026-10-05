import type { Finding, Mandate, Purchase } from "./types.js";

/** What a mandate has already committed: reserved, captured or unresolved purchases. Released ones do not count. */
export interface MandateUsage { spentAmountCents: number; purchaseCount: number }

const money = (cents: number, cur: string) => `${(cents / 100).toFixed(2)} ${cur}`;

/**
 * Deterministic check of a purchase against a mandate. No LLM involved.
 * An empty result means the purchase is within the mandate.
 */
export function checkPurchase(
  m: Mandate, p: Purchase,
  opts: { revokedAt?: string | null; revokedReason?: string; agentPaused?: { reason?: string } | null } = {},
): Finding[] {
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
    f.push({
      code: "MANDATE_REVOKED", severity: "block",
      message: `The user revoked the mandate before this purchase${opts.revokedReason ? `: ${opts.revokedReason}` : "."}`,
    });
  }
  if (opts.agentPaused) {
    f.push({
      code: "AGENT_PAUSED", severity: "block",
      message: `The user had paused their agent when this purchase was made${opts.agentPaused.reason ? `: ${opts.agentPaused.reason}` : "."}`,
    });
  }
  return f;
}

/**
 * Cumulative limits. Pure: the caller supplies current usage (and must read it and reserve the new purchase
 * in one atomic step, see reserveMandateUse). `defaultMaxPurchases` applies when the mandate sets none.
 */
export function checkCumulative(m: Mandate, amountCents: number, usage: MandateUsage, defaultMaxPurchases?: number): Finding[] {
  const f: Finding[] = [];
  const maxPurchases = m.maxPurchases ?? defaultMaxPurchases;
  if (maxPurchases !== undefined && usage.purchaseCount + 1 > maxPurchases) {
    f.push({
      code: "PURCHASE_COUNT_EXCEEDED", severity: "block",
      message: m.maxPurchases === undefined
        ? `This mandate is single-use and has already been used (${usage.purchaseCount} of 1 purchases).`
        : `This mandate allows ${maxPurchases} purchase(s) and ${usage.purchaseCount} are already committed.`,
      details: { purchaseCount: usage.purchaseCount, maxPurchases },
    });
  }
  if (m.maxTotalAmountCents !== undefined && usage.spentAmountCents + amountCents > m.maxTotalAmountCents) {
    f.push({
      code: "CUMULATIVE_AMOUNT_EXCEEDED", severity: "block",
      message: `Spending ${money(usage.spentAmountCents, m.currency)} already plus ${money(amountCents, m.currency)} would exceed the mandate total of ${money(m.maxTotalAmountCents, m.currency)}.`,
      details: { spentAmountCents: usage.spentAmountCents, remainingCents: Math.max(0, m.maxTotalAmountCents - usage.spentAmountCents) },
    });
  }
  return f;
}

/** The saved payment source an autonomous charge would use. Pure: the caller supplies its stored state. */
export interface PaymentAuthorizationState { status: string; expiresAt?: string | null }

export function checkPaymentAuthorization(a: PaymentAuthorizationState, now: Date): Finding[] {
  const f: Finding[] = [];
  if (a.status !== "ACTIVE") {
    f.push({ code: "PAYMENT_AUTHORIZATION_REVOKED", severity: "block", message: "The user's saved payment authorization is no longer active, so Warrant cannot charge without approval." });
  }
  if (a.expiresAt && Date.parse(a.expiresAt) <= now.getTime()) {
    f.push({ code: "PAYMENT_AUTHORIZATION_EXPIRED", severity: "block", message: `The user's saved payment authorization expired on ${a.expiresAt}.` });
  }
  return f;
}
