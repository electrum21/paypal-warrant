import type { ProductCandidate } from "../agent/buyer.js";

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
    }];
  });
}