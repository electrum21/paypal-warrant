import type { ProductCandidate } from "../agent/buyer.js";
import type { Finding } from "../mandate/types.js";

export interface ProductSearch {
  query: string;
  maxAmountCents: number;
  currency: string;
  category?: string;
  /** The Warrant demo store. Channel3 products are listed as sold by this merchant (see note below). */
  merchantId: string;
}

/**
 * Channel3 is optional: the offline demo uses the local catalog, while a configured key provides real
 * product discovery through Channel3's REST API (POST {base}/v1/search, `x-api-key` header).
 *
 * How results are used: Channel3 returns real products and retailer offers. The demo "store" re-lists the
 * cheapest offer inside the budget as its own item (merchantId = the Warrant demo merchant), because the
 * mandate only allows purchases from that merchant. The source retailer is kept in the description.
 * The category is the one the buyer asked for; Channel3's own category taxonomy is not mapped.
 * Budget and currency are checked here, not trusted from the API.
 */
export async function searchChannel3(
  endpoint: string | undefined,
  apiKey: string | undefined,
  search: ProductSearch,
): Promise<ProductCandidate[]> {
  if (!endpoint || !apiKey) return [];
  // Accept either https://api.trychannel3.com or https://api.trychannel3.com/v1 in CHANNEL3_URL.
  const base = endpoint.replace(/\/+$/, "").replace(/\/v1$/, "");
  const res = await fetch(`${base}/v1/search`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ query: search.query }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Channel3 API ${res.status}`);
  const data = await res.json() as { products?: any[] };

  return (data.products ?? []).flatMap((p: any): ProductCandidate[] => {
    const offers: any[] = Array.isArray(p?.offers) ? p.offers : [];
    const best = offers
      .map(o => ({
        domain: typeof o?.domain === "string" ? o.domain : "",
        // The docs show both `price.price` and `price.amount`; accept either.
        amount: Number(o?.price?.price ?? o?.price?.amount),
        currency: String(o?.price?.currency ?? "").toUpperCase(),
      }))
      .filter(o => Number.isFinite(o.amount) && o.amount > 0 && o.currency === search.currency
        && Math.round(o.amount * 100) <= search.maxAmountCents)
      .sort((a, b) => a.amount - b.amount)[0];
    if (!p?.id || !p?.title || !best) return [];
    const title = String(p.title).slice(0, 90);
    return [{
      id: String(p.id),
      description: (best.domain ? `${title} (via ${best.domain})` : title).slice(0, 127),
      amountCents: Math.round(best.amount * 100),
      currency: best.currency,
      category: search.category ?? "general",
      merchantId: search.merchantId,
      source: "channel3",
    }];
  });
}

/**
 * After a checkout is refused for being outside the mandate, offer in-mandate alternatives through the
 * same search the buyer agent used to plan the purchase. Never blocks or changes the refusal: a search
 * failure or missing configuration just means no alternatives are suggested.
 */
export async function suggestAlternatives(
  endpoint: string | undefined, apiKey: string | undefined,
  mandate: { description: string; maxAmountCents: number; currency: string; allowedCategories?: string[] },
  merchantId: string,
): Promise<ProductCandidate[]> {
  if (!mandate.allowedCategories?.length) return [];
  try {
    const products = await searchChannel3(endpoint, apiKey, {
      query: mandate.description, maxAmountCents: mandate.maxAmountCents, currency: mandate.currency,
      category: mandate.allowedCategories[0], merchantId,
    });
    return products.slice(0, 3);
  } catch {
    return [];
  }
}

// ---- Product enrichment: verify WHAT was bought ---------------------------------------------------------------
//
// Search tells the buyer agent what exists. Enrichment lets the MERCHANT check what the agent says it bought.
// The agent-signed cart carries a Channel3 product id; Warrant fetches that product and compares Channel3's own
// categories and retailer prices with the cart. This closes a known gap: the purchase category was otherwise
// whatever the agent declared. All comparison logic below is plain code. Nothing here calls an LLM.

export interface Channel3Product {
  id: string;
  title?: string;
  brands?: { id?: string; name?: string }[];
  categories?: string[];
  images?: { url?: string; is_main_image?: boolean }[];
  offers?: { url?: string; domain?: string; price?: { price?: number; amount?: number; currency?: string }; availability?: string }[];
}

/** Fetches one product (GET /v1/products/{id}). Returns null when Channel3 does not know it (404). */
export async function getChannel3Product(
  endpoint: string | undefined, apiKey: string | undefined, productId: string,
): Promise<Channel3Product | null> {
  if (!endpoint || !apiKey) return null;
  const base = endpoint.replace(/\/+$/, "").replace(/\/v1$/, "");
  const res = await fetch(`${base}/v1/products/${encodeURIComponent(productId)}`, {
    headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Channel3 API ${res.status}`);
  return await res.json() as Channel3Product;
}

/**
 * Warrant's category vocabulary (what mandates list in allowedCategories) -> words that appear in Channel3's category
 * paths and titles. Order matters: the first rule that matches wins, so specific categories come before broad ones.
 * A category with no rule here is never "verified" or "refuted"; it stays unknown rather than guessed.
 */
const CATEGORY_RULES: [string, RegExp][] = [
  ["footwear", /\b(shoes?|footwear|sneakers?|boots?|sandals?|loafers?|trainers?|slippers?|cleats?)\b/i],
  ["electronics", /\b(electronics?|computers?|laptops?|phones?|smartphones?|tablets?|cameras?|headphones?|earbuds?|speakers?|monitors?|gadgets?|gaming)\b/i],
  ["apparel", /\b(apparel|clothing|shirts?|t-shirts?|jackets?|dresses|pants|jeans|hoodies?|sweaters?)\b/i],
  ["home", /\b(furniture|kitchen|bedding|home (?:&|and) garden|cookware|decor)\b/i],
];

export function categoryFromText(texts: string[]): string | undefined {
  const hay = texts.join(" | ");
  return CATEGORY_RULES.find(([, re]) => re.test(hay))?.[0];
}

export type CategoryVerdict =
  | "match"                // Channel3's category equals what the agent declared (and is allowed)
  | "not_allowed"          // the real product's category is outside the mandate's allowedCategories
  | "declared_mismatch"    // allowed, but the agent declared a different category than the product's
  | "unknown";             // no Channel3 data, or categories we cannot map

export interface ProductCheck {
  productId: string;
  /** found: Channel3 returned the product. not_found: unknown id. unavailable: lookup failed or Channel3 is not configured. */
  lookup: "found" | "not_found" | "unavailable";
  title?: string;
  brand?: string;
  imageUrl?: string;
  channel3Categories: string[];
  observedCategory?: string;
  declaredCategory?: string;
  categoryVerdict: CategoryVerdict;
  currency: string;
  paidCents: number;
  /** Retailer prices Channel3 listed in the paid currency. These are CURRENT listings, not a price history. */
  offers: { domain: string; priceCents: number }[];
  marketLowCents?: number;
  marketHighCents?: number;
  paidWithinListedRange?: boolean;
  checkedAt: string;
  note: string;
}

export function assessProduct(
  productId: string,
  product: Channel3Product | null | "unavailable",
  claim: { declaredCategory?: string; allowedCategories?: string[]; amountCents: number; currency: string },
  now: Date,
): ProductCheck {
  const base = {
    productId, channel3Categories: [] as string[], declaredCategory: claim.declaredCategory, currency: claim.currency,
    paidCents: claim.amountCents, offers: [] as { domain: string; priceCents: number }[], checkedAt: now.toISOString(),
  };
  if (product === "unavailable") return { ...base, lookup: "unavailable", categoryVerdict: "unknown", note: "Channel3 could not be reached, so the product was not verified." };
  if (product === null) return { ...base, lookup: "not_found", categoryVerdict: "unknown", note: `Channel3 has no product with id ${productId}.` };

  const categories = (product.categories ?? []).filter((c): c is string => typeof c === "string").slice(0, 12);
  const title = typeof product.title === "string" ? product.title.slice(0, 160) : undefined;
  // Channel3's category paths are the primary signal; the title is only a fallback when the paths map to nothing.
  const observed = categoryFromText(categories) ?? (title ? categoryFromText([title]) : undefined);
  const offers = (Array.isArray(product.offers) ? product.offers : []).flatMap(o => {
    const amount = Number(o?.price?.price ?? o?.price?.amount);
    const currency = String(o?.price?.currency ?? "").toUpperCase();
    return Number.isFinite(amount) && amount > 0 && currency === claim.currency.toUpperCase() && typeof o?.domain === "string"
      ? [{ domain: o.domain.slice(0, 80), priceCents: Math.round(amount * 100) }] : [];
  }).sort((a, b) => a.priceCents - b.priceCents);
  const low = offers[0]?.priceCents, high = offers[offers.length - 1]?.priceCents;

  let verdict: CategoryVerdict = "unknown";
  if (observed) {
    if (claim.allowedCategories?.length && !claim.allowedCategories.includes(observed)) verdict = "not_allowed";
    else if (claim.declaredCategory && claim.declaredCategory !== observed) verdict = "declared_mismatch";
    else verdict = "match";
  }
  const note = verdict === "not_allowed"
    ? `Channel3 classifies this product as ${observed}, which the mandate does not allow.`
    : verdict === "declared_mismatch"
      ? `Channel3 classifies this product as ${observed}; the cart declared ${claim.declaredCategory}.`
      : verdict === "match"
        ? `Channel3's category (${observed}) matches the cart.`
        : "Channel3 returned the product, but its categories do not map to a category Warrant knows.";
  const brand = product.brands?.find(b => typeof b?.name === "string")?.name?.slice(0, 80);
  const imageUrl = (product.images?.find(i => i?.is_main_image) ?? product.images?.[0])?.url;
  return {
    ...base, lookup: "found", title, brand, channel3Categories: categories, observedCategory: observed,
    imageUrl: typeof imageUrl === "string" && imageUrl.startsWith("https://") ? imageUrl.slice(0, 300) : undefined,
    categoryVerdict: verdict, offers: offers.slice(0, 5), marketLowCents: low, marketHighCents: high,
    paidWithinListedRange: low === undefined ? undefined : claim.amountCents >= low && claim.amountCents <= high!, note,
  };
}

/** Looks the product up and assesses it. A failed lookup is reported as "unavailable", never thrown into a dispute or checkout. */
export async function verifyProduct(
  cfg: { url?: string; apiKey?: string } | undefined, productId: string,
  claim: { declaredCategory?: string; allowedCategories?: string[]; amountCents: number; currency: string }, now = new Date(),
): Promise<ProductCheck> {
  if (!cfg?.url || !cfg.apiKey) return assessProduct(productId, "unavailable", claim, now);
  try {
    return assessProduct(productId, await getChannel3Product(cfg.url, cfg.apiKey, productId), claim, now);
  } catch {
    return assessProduct(productId, "unavailable", claim, now);
  }
}

/** The ONLY way a product check affects a dispute decision: a confirmed out-of-mandate category is a blocking finding. */
export function productFindings(check: ProductCheck | undefined): Finding[] {
  if (!check) return [];
  if (check.categoryVerdict === "not_allowed") {
    return [{ code: "PRODUCT_CATEGORY_NOT_ALLOWED", severity: "block", message: check.note,
      details: { observedCategory: check.observedCategory ?? "", declaredCategory: check.declaredCategory ?? "" } }];
  }
  if (check.categoryVerdict === "declared_mismatch") {
    return [{ code: "PRODUCT_CATEGORY_DECLARED_MISMATCH", severity: "warn", message: check.note }];
  }
  return [];
}
