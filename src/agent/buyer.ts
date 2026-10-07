import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeys, signCart, signMandate } from "../mandate/sign.js";
import type { Cart, Mandate, SignedCart, SignedMandate } from "../mandate/types.js";
import { z } from "zod";

/**
 * A scripted buyer agent for demos. It holds its OWN keypair and signs carts (concrete purchases).
 * It does not hold the user's key, so it cannot create or widen a mandate.
 */
export interface DemoAgent {
  agentId: string;
  userId: string;                                // the user it acts for
  publicKeyPem: string;
  privateKeyPem: string;
}

/** The human principal. In a real system this key lives in the user's wallet or device, never with the agent. */
export interface DemoUser {
  userId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

export function newAgent(agentId = "demo-buyer-agent", userId = "demo-user"): DemoAgent {
  return { agentId, userId, ...generateKeys() };
}

export function newUser(userId = "demo-user"): DemoUser {
  return { userId, ...generateKeys() };
}

/** Keeps the same keypair between runs so the merchant only has to register it once. */
export function loadOrCreateAgent(path: string): DemoAgent {
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as DemoAgent;
  const a = newAgent();
  writeFileSync(path, JSON.stringify(a, null, 2), { mode: 0o600 });
  return a;
}

export function loadOrCreateUser(path: string): DemoUser {
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as DemoUser;
  const u = newUser();
  writeFileSync(path, JSON.stringify(u, null, 2), { mode: 0o600 });
  return u;
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
  /** Where the candidate came from. Only Channel3 ids can be verified against Channel3 later. */
  source?: "channel3" | "local";
}

export const DEMO_CATALOG: ProductCandidate[] = [
  { id: "trail-a", description: "Trail Runner A", amountCents: 9500, currency: "USD", category: "footwear", merchantId: "warrant-demo-merchant" },
  { id: "trail-b", description: "Trail Runner B", amountCents: 11500, currency: "USD", category: "footwear", merchantId: "warrant-demo-merchant" },
  { id: "trail-c", description: "Trail Runner C", amountCents: 14500, currency: "USD", category: "footwear", merchantId: "warrant-demo-merchant" },
  { id: "gadget-a", description: "Demo Smart Gadget", amountCents: 11500, currency: "USD", category: "electronics", merchantId: "warrant-demo-merchant" },
];

/** Converts a plain-language shopping request into a validated plan: the user signs the mandate, the agent signs the cart. */
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

export async function searchCatalog(baseUrl: string, search: {
  query: string; maxAmountCents: number; currency: string; category?: string;
}): Promise<{ source: string; products: ProductCandidate[] }> {
  const res = await fetch(`${baseUrl}/api/catalog/search`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(search),
  });
  const body = await res.json() as { source?: string; products?: ProductCandidate[]; error?: string };
  if (!res.ok) throw new Error(body.error ?? `Catalog search failed (${res.status})`);
  return { source: body.source ?? "unknown", products: body.products ?? [] };
}

export function planShoppingRequest(
  request: string, user: DemoUser, agent: DemoAgent, merchantId: string, candidates: ProductCandidate[],
  limits: { maxTotalAmountCents?: number; maxPurchases?: number } = {},
) {
  const intent = parseShoppingRequest(request, merchantId);
  const product = chooseProduct(intent, candidates);
  const mandate = buildMandate(agent, merchantId, new Date(), limits);
  const signedMandate = signFor(user, { ...mandate, description: request, currency: intent.currency,
    maxAmountCents: intent.maxAmountCents, allowedCategories: intent.allowedCategories });
  const signedCart = cartFor(agent, signedMandate, { merchantId: product.merchantId, amountCents: product.amountCents,
    currency: product.currency, category: product.category, productId: product.source === "channel3" ? product.id : undefined });
  return { intent, product, mandate: signedMandate, cart: signedCart };
}

export function buildMandate(
  agent: DemoAgent, merchantId: string, now = new Date(),
  limits: { maxTotalAmountCents?: number; maxPurchases?: number } = {},
): Mandate {
  const id = `mandate-${randomUUID().slice(0, 8)}`;
  return {
    id, version: 1, userId: agent.userId, agentId: agent.agentId,
    description: `Buy one pair of trail running shoes, maximum $120.00, from ${merchantId} only`,
    currency: "USD", maxAmountCents: 12000, ...limits,
    allowedMerchantIds: [merchantId], allowedCategories: ["footwear"],
    validFrom: new Date(now.getTime() - 60_000).toISOString(),
    expiresAt: new Date(now.getTime() + 24 * 3600_000).toISOString(),
    nonce: randomUUID(),
  };
}

/** The USER signs the mandate. */
export function signFor(user: DemoUser, mandate: Mandate): SignedMandate {
  return signMandate(mandate, user.privateKeyPem);
}

/** The AGENT signs one concrete purchase under a mandate the user already signed. */
export function cartFor(
  agent: DemoAgent, signed: SignedMandate,
  purchase: { merchantId: string; amountCents: number; currency?: string; category?: string; productId?: string }, now = new Date(),
): SignedCart {
  const cart: Cart = {
    cartId: `cart-${randomUUID()}`, mandateId: signed.mandate.id, mandateHash: signed.mandateHash,
    agentId: agent.agentId, merchantId: purchase.merchantId, amountCents: purchase.amountCents,
    currency: purchase.currency ?? signed.mandate.currency, category: purchase.category, createdAt: now.toISOString(),
    ...(purchase.productId ? { productId: purchase.productId } : {}),
  };
  return signCart(cart, agent.privateKeyPem);
}

/** Presents the user-signed mandate and the agent-signed cart to a running Warrant server. */
export async function checkout(
  baseUrl: string, signed: SignedMandate, signedCart: SignedCart,
  purchase: { amountCents: number; category: string; description?: string },
  mode: "approve" | "autonomous" = "approve",
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/checkout`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedMandate: signed, signedCart, purchase, mode }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

export interface BuyRequestResult {
  catalogSource: string;
  /** Set when Channel3/the catalog endpoint could not be used and the local catalog was substituted. */
  fallbackReason?: string;
  plan?: ReturnType<typeof planShoppingRequest>;
  /** Set when planning failed before anything was signed or sent (no budget, no eligible product...). */
  planError?: string;
  response?: { status: number; body: any };
}

/**
 * Natural-language request -> catalog search -> eligible product -> user-signed mandate -> agent-signed cart -> checkout.
 * The local catalog is used only when the remote search fails or returns nothing, and the reason is reported, never hidden.
 * Planning errors are returned (not thrown) so callers can show them; nothing is sent to /api/checkout if planning fails.
 */
export async function buyFromRequest(
  baseUrl: string, request: string,
  ctx: { user: DemoUser; agent: DemoAgent; merchantId: string; limits?: { maxTotalAmountCents?: number; maxPurchases?: number } },
  mode: "approve" | "autonomous",
): Promise<BuyRequestResult> {
  let intent: ShoppingIntent;
  try {
    intent = parseShoppingRequest(request, ctx.merchantId);
  } catch (err) {
    return { catalogSource: "none", planError: (err as Error).message };
  }
  let catalogSource = "local fallback";
  let fallbackReason: string | undefined;
  let candidates = DEMO_CATALOG;
  try {
    const remote = await searchCatalog(baseUrl, {
      query: request, maxAmountCents: intent.maxAmountCents, currency: intent.currency, category: intent.allowedCategories[0],
    });
    if (remote.products.length) { candidates = remote.products; catalogSource = remote.source; }
    else fallbackReason = `catalog source "${remote.source}" returned no products`;
  } catch (err) {
    fallbackReason = (err as Error).message;
  }
  let plan: ReturnType<typeof planShoppingRequest>;
  try {
    plan = planShoppingRequest(request, ctx.user, ctx.agent, ctx.merchantId, candidates, ctx.limits);
  } catch (err) {
    return { catalogSource, fallbackReason, planError: (err as Error).message };
  }
  const response = await checkout(baseUrl, plan.mandate, plan.cart, {
    amountCents: plan.product.amountCents, category: plan.product.category, description: plan.product.description.slice(0, 127),
  }, mode);
  return { catalogSource, fallbackReason, plan, response };
}
