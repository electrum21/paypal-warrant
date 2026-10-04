import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeys, signMandate } from "../mandate/sign.js";
import type { Mandate, SignedMandate } from "../mandate/types.js";
import { z } from "zod";

/** A scripted buyer agent for demos. It holds a keypair and signs mandates on behalf of a "user". */
export interface DemoAgent {
  agentId: string;
  userId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

export function newAgent(agentId = "demo-buyer-agent", userId = "demo-user"): DemoAgent {
  return { agentId, userId, ...generateKeys() };
}

/** Keeps the same keypair between runs so the merchant only has to register it once. */
export function loadOrCreateAgent(path: string): DemoAgent {
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as DemoAgent;
  const a = newAgent();
  writeFileSync(path, JSON.stringify(a, null, 2), { mode: 0o600 });
  return a;
}

/**
 * Every scenario uses the same mandate: shoes, $120 max, one merchant. Only the purchase differs.
 * `expect` is what Warrant should propose if the buyer then disputes the payment as unauthorized.
 */
export type Scenario = "within" | "over" | "category";
export const SCENARIOS: Record<Scenario, { label: string; amountCents: number; category: string; expect: string }> = {
  within:   { label: "Shoes for $115, inside the $120 limit",           amountCents: 11500, category: "footwear",    expect: "contest" },
  over:     { label: "Shoes for $135, $15 over the limit",              amountCents: 13500, category: "footwear",    expect: "offer_partial_refund" },
  category: { label: "A $115 gadget; the mandate only covers footwear", amountCents: 11500, category: "electronics", expect: "accept_claim" },
};

export const ShoppingIntent = z.object({
  productDescription: z.string().min(1),
  maxAmountCents: z.number().int().positive(),
  currency: z.string().length(3),
  allowedCategories: z.array(z.string()).min(1),
  allowedMerchantIds: z.array(z.string()).min(1),
});
export type ShoppingIntent = z.infer<typeof ShoppingIntent>;

export interface ProductCandidate {
  id: string;
  description: string;
  amountCents: number;
  currency: string;
  category: string;
  merchantId: string;
}

export const DEMO_CATALOG: ProductCandidate[] = [
  { id: "trail-a", description: "Trail Runner A", amountCents: 9500, currency: "USD", category: "footwear", merchantId: "warrant-demo-merchant" },
  { id: "trail-b", description: "Trail Runner B", amountCents: 11500, currency: "USD", category: "footwear", merchantId: "warrant-demo-merchant" },
  { id: "trail-c", description: "Trail Runner C", amountCents: 14500, currency: "USD", category: "footwear", merchantId: "warrant-demo-merchant" },
  { id: "gadget-a", description: "Demo Smart Gadget", amountCents: 11500, currency: "USD", category: "electronics", merchantId: "warrant-demo-merchant" },
];

/** Converts a plain-language shopping request into a validated, signed-agent plan. */
export function parseShoppingRequest(request: string, merchantId: string): ShoppingIntent {
  const amount = request.match(/(?:under|below|maximum|max|up to|less than)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i);
  if (!amount) throw new Error("The shopping request needs a maximum amount, for example 'under $120'.");
  const maxAmountCents = Math.round(Number(amount[1]) * 100);
  const category = /(?:shoe|runner|footwear)/i.test(request) ? "footwear"
    : /(?:gadget|electronic|phone|laptop)/i.test(request) ? "electronics" : "general";
  return ShoppingIntent.parse({
    productDescription: request.replace(/[.!?]+$/, "").trim(),
    maxAmountCents, currency: "USD", allowedCategories: [category], allowedMerchantIds: [merchantId],
  });
}

export function chooseProduct(intent: ShoppingIntent, candidates: ProductCandidate[]): ProductCandidate {
  const eligible = candidates.filter(p =>
    p.currency === intent.currency && p.merchantId === intent.allowedMerchantIds[0]
    && intent.allowedCategories.includes(p.category) && p.amountCents <= intent.maxAmountCents,
  ).sort((a, b) => a.amountCents - b.amountCents);
  if (!eligible[0]) throw new Error("No product matched the signed shopping mandate.");
  return eligible[0];
}

export function planShoppingRequest(request: string, agent: DemoAgent, merchantId: string, candidates: ProductCandidate[]) {
  const intent = parseShoppingRequest(request, merchantId);
  const product = chooseProduct(intent, candidates);
  const mandate = buildMandate(agent, merchantId);
  const signedMandate = signFor(agent, { ...mandate, description: request, currency: intent.currency,
    maxAmountCents: intent.maxAmountCents, allowedCategories: intent.allowedCategories });
  return { intent, product, mandate: signedMandate };
}

export function buildMandate(agent: DemoAgent, merchantId: string, now = new Date()): Mandate {
  const id = `mandate-${randomUUID().slice(0, 8)}`;
  return {
    id, version: 1, userId: agent.userId, agentId: agent.agentId,
    description: `Buy one pair of trail running shoes, maximum $120.00, from ${merchantId} only`,
    currency: "USD", maxAmountCents: 12000,
    allowedMerchantIds: [merchantId], allowedCategories: ["footwear"],
    validFrom: new Date(now.getTime() - 60_000).toISOString(),
    expiresAt: new Date(now.getTime() + 24 * 3600_000).toISOString(),
    nonce: randomUUID(),
  };
}

export function signFor(agent: DemoAgent, mandate: Mandate): SignedMandate {
  return signMandate(mandate, agent.privateKeyPem);
}

/** Presents a signed mandate to a running Warrant server and asks to buy. */
export async function checkout(
  baseUrl: string, signed: SignedMandate, purchase: { amountCents: number; category: string; description?: string },
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/checkout`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedMandate: signed, purchase }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
