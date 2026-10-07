import { afterEach, describe, expect, it, vi } from "vitest";
import { assessProduct, categoryFromText, getChannel3Product, productFindings, searchChannel3, verifyProduct, type Channel3Product } from "./channel3.js";

const search = { query: "trail running shoes", maxAmountCents: 12000, currency: "USD", category: "footwear", merchantId: "warrant-demo-merchant" };

function stubFetch(body: unknown, ok = true, status = 200) {
  const fn = vi.fn(async () => ({ ok, status, json: async () => body }) as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}
afterEach(() => vi.unstubAllGlobals());

describe("searchChannel3", () => {
  it("does nothing without a URL and key", async () => {
    const fn = stubFetch({});
    expect(await searchChannel3(undefined, "k", search)).toEqual([]);
    expect(await searchChannel3("https://api.example.com", undefined, search)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("calls POST /v1/search with x-api-key, whether or not the URL already ends in /v1", async () => {
    const fn = stubFetch({ products: [] });
    await searchChannel3("https://api.example.com/", "secret", search);
    await searchChannel3("https://api.example.com/v1", "secret", search);
    const calls = fn.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(c => c[0])).toEqual(["https://api.example.com/v1/search", "https://api.example.com/v1/search"]);
    expect((calls[0][1].headers as Record<string, string>)["x-api-key"]).toBe("secret");
    expect(calls[0][1].method).toBe("POST");
  });

  it("maps the cheapest in-budget offer to a product for the demo merchant and drops the rest", async () => {
    stubFetch({ products: [
      { id: "p1", title: "Trail Pro", offers: [
        { domain: "a.com", price: { price: 109.99, currency: "USD" } },
        { domain: "b.com", price: { price: 99, currency: "USD" } },
        { domain: "c.com", price: { price: 80, currency: "EUR" } },
      ] },
      { id: "p2", title: "Too expensive", offers: [{ domain: "a.com", price: { price: 200, currency: "USD" } }] },
      { id: "p3", title: "No offers", offers: [] },
      { title: "No id", offers: [{ domain: "a.com", price: { price: 50, currency: "USD" } }] },
      { id: "p5", title: "Amount field", offers: [{ domain: "d.com", price: { amount: 75.5, currency: "usd" } }] },
    ] });
    const r = await searchChannel3("https://api.example.com", "k", search);
    expect(r).toEqual([
      { id: "p1", description: "Trail Pro (via b.com)", amountCents: 9900, currency: "USD", category: "footwear", merchantId: "warrant-demo-merchant", source: "channel3" },
      { id: "p5", description: "Amount field (via d.com)", amountCents: 7550, currency: "USD", category: "footwear", merchantId: "warrant-demo-merchant", source: "channel3" },
    ]);
  });

  it("keeps descriptions within PayPal's 127-character limit", async () => {
    stubFetch({ products: [{ id: "p", title: "x".repeat(300), offers: [{ domain: "a-very-long-domain.example.com", price: { price: 10, currency: "USD" } }] }] });
    const [p] = await searchChannel3("https://api.example.com", "k", search);
    expect(p.description.length).toBeLessThanOrEqual(127);
  });

  it("throws on an API error so the server reports it", async () => {
    stubFetch({}, false, 403);
    await expect(searchChannel3("https://api.example.com", "k", search)).rejects.toThrow("Channel3 API 403");
  });
});

const NOW = new Date("2026-11-05T00:00:00Z");
const shoe: Channel3Product = {
  id: "p1", title: "Trail Pro Running Shoe", brands: [{ name: "RunCo" }], categories: ["Apparel & Accessories > Shoes"],
  images: [{ url: "https://img.example.com/a.jpg", is_main_image: true }],
  offers: [
    { domain: "b.com", price: { price: 99, currency: "USD" } },
    { domain: "a.com", price: { price: 129.5, currency: "USD" } },
    { domain: "eu.com", price: { price: 80, currency: "EUR" } },
  ],
};
const claim = { declaredCategory: "footwear", allowedCategories: ["footwear"], amountCents: 11500, currency: "USD" };

describe("categoryFromText", () => {
  it("maps Channel3 category paths onto Warrant's vocabulary, specific before broad", () => {
    expect(categoryFromText(["Apparel & Accessories > Shoes"])).toBe("footwear");
    expect(categoryFromText(["Electronics > Audio > Headphones"])).toBe("electronics");
    expect(categoryFromText(["Garden Hose"])).toBeUndefined();
  });
});

describe("assessProduct", () => {
  it("verifies a product whose Channel3 category matches the cart, and lists same-currency retailer prices only", () => {
    const c = assessProduct("p1", shoe, claim, NOW);
    expect(c.lookup).toBe("found");
    expect(c.categoryVerdict).toBe("match");
    expect(c.title).toBe("Trail Pro Running Shoe");
    expect(c.brand).toBe("RunCo");
    expect(c.offers.map(o => o.priceCents)).toEqual([9900, 12950]);
    expect(c.marketLowCents).toBe(9900);
    expect(c.marketHighCents).toBe(12950);
    expect(c.paidWithinListedRange).toBe(true);
    expect(productFindings(c)).toEqual([]);
  });

  it("catches an agent that declared footwear for a product Channel3 files under electronics", () => {
    const phone: Channel3Product = { id: "p9", title: "Pro Phone 15", categories: ["Electronics > Phones"], offers: [] };
    const c = assessProduct("p9", phone, claim, NOW);
    expect(c.observedCategory).toBe("electronics");
    expect(c.categoryVerdict).toBe("not_allowed");
    const [f] = productFindings(c);
    expect(f.code).toBe("PRODUCT_CATEGORY_NOT_ALLOWED");
    expect(f.severity).toBe("block");
  });

  it("only warns when the real category is allowed but the agent declared a different one", () => {
    const c = assessProduct("p1", shoe, { ...claim, declaredCategory: "apparel", allowedCategories: ["footwear", "apparel"] }, NOW);
    expect(c.categoryVerdict).toBe("declared_mismatch");
    expect(productFindings(c)[0].severity).toBe("warn");
  });

  it("does not block on categories it cannot map; unknown is not a violation", () => {
    const c = assessProduct("px", { id: "px", title: "Garden Hose", categories: ["Lawn & Garden"] }, claim, NOW);
    expect(c.categoryVerdict).toBe("unknown");
    expect(productFindings(c)).toEqual([]);
  });

  it("reports unavailable and not_found without inventing a verdict", () => {
    expect(assessProduct("p1", "unavailable", claim, NOW).lookup).toBe("unavailable");
    expect(assessProduct("p1", null, claim, NOW).lookup).toBe("not_found");
    expect(assessProduct("p1", null, claim, NOW).categoryVerdict).toBe("unknown");
  });

  it("flags a price outside the listed range without treating that as a violation", () => {
    const c = assessProduct("p1", shoe, { ...claim, amountCents: 20000 }, NOW);
    expect(c.paidWithinListedRange).toBe(false);
    expect(productFindings(c)).toEqual([]);
  });

  it("never carries a non-https image URL into the evidence", () => {
    const c = assessProduct("p1", { ...shoe, images: [{ url: "javascript:alert(1)", is_main_image: true }] }, claim, NOW);
    expect(c.imageUrl).toBeUndefined();
  });
});

describe("getChannel3Product / verifyProduct", () => {
  it("calls GET /v1/products/{id} with the key and encodes the id", async () => {
    const fn = stubFetch(shoe);
    await getChannel3Product("https://api.example.com/v1", "secret", "a/b");
    const [url, init] = (fn.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe("https://api.example.com/v1/products/a%2Fb");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("secret");
  });
  it("returns null on 404 and throws on other errors", async () => {
    stubFetch({}, false, 404);
    expect(await getChannel3Product("https://api.example.com", "k", "x")).toBeNull();
    stubFetch({}, false, 500);
    await expect(getChannel3Product("https://api.example.com", "k", "x")).rejects.toThrow("Channel3 API 500");
  });
  it("turns a failed lookup into an unavailable check instead of throwing", async () => {
    stubFetch({}, false, 500);
    const c = await verifyProduct({ url: "https://api.example.com", apiKey: "k" }, "p1", claim, NOW);
    expect(c.lookup).toBe("unavailable");
  });
  it("is unavailable, and makes no request, when Channel3 is not configured", async () => {
    const fn = stubFetch(shoe);
    const c = await verifyProduct(undefined, "p1", claim, NOW);
    expect(c.lookup).toBe("unavailable");
    expect(fn).not.toHaveBeenCalled();
  });
});
