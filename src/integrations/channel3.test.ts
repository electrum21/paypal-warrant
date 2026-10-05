import { afterEach, describe, expect, it, vi } from "vitest";
import { searchChannel3 } from "./channel3.js";

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
      { id: "p1", description: "Trail Pro (via b.com)", amountCents: 9900, currency: "USD", category: "footwear", merchantId: "warrant-demo-merchant" },
      { id: "p5", description: "Amount field (via d.com)", amountCents: 7550, currency: "USD", category: "footwear", merchantId: "warrant-demo-merchant" },
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