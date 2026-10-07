import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caseSummary, ensureCaseIndex, findSimilarCases, indexDisputeCase, outcomeOf, resetElasticCaches, summarizePrecedents, type DisputeCase, type ElasticConfig } from "./elastic.js";

const cfg: ElasticConfig = { url: "https://es.example.com/", apiKey: "k", index: "events", caseIndex: "cases" };

/** Answers each request in order; records what was sent. */
function stubSequence(...responses: { status?: number; body?: unknown }[]) {
  const calls: { url: string; method: string; body?: any }[] = [];
  let i = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = responses[Math.min(i++, responses.length - 1)];
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r.body ?? {} } as Response;
  }));
  return calls;
}
beforeEach(() => resetElasticCaches());
afterEach(() => vi.unstubAllGlobals());

const doc: DisputeCase = {
  disputeId: 7, paypalDisputeId: "PP-D-7", reason: "UNAUTHORISED", action: "contest", merchantOutcome: "pending", amountCents: 11500,
  currency: "USD", findingCodes: [], hasDeliveryProof: false, summary: "x", createdAt: "2026-11-05T00:00:00Z",
};

describe("caseSummary and outcomeOf", () => {
  it("builds searchable text from verified facts", () => {
    const t = caseSummary({ reason: "UNAUTHORISED", action: "accept_claim", findingCodes: ["CATEGORY_NOT_ALLOWED"], category: "electronics", hasDeliveryProof: false });
    expect(t).toContain("UNAUTHORISED");
    expect(t).toContain("CATEGORY_NOT_ALLOWED");
    expect(t).toContain("accept claim");
  });
  it("maps workflow states to merchant outcomes", () => {
    expect(outcomeOf("SUBMITTED")).toBe("submitted");
    expect(outcomeOf("REJECTED")).toBe("dismissed");
    expect(outcomeOf("PROPOSED")).toBe("pending");
  });
});

describe("ensureCaseIndex", () => {
  it("creates the index with a semantic_text summary, and strips the trailing slash from the URL", async () => {
    const calls = stubSequence({ status: 404 }, { status: 200 });
    expect(await ensureCaseIndex(cfg)).toBe("hybrid");
    expect(calls[1].method).toBe("PUT");
    expect(calls[1].url).toBe("https://es.example.com/cases");
    expect(calls[1].body.mappings.properties.summary.type).toBe("semantic_text");
  });
  it("falls back to a plain text field when the cluster rejects semantic_text", async () => {
    const calls = stubSequence({ status: 404 }, { status: 400 }, { status: 200 });
    expect(await ensureCaseIndex(cfg)).toBe("keyword");
    expect(calls[2].body.mappings.properties.summary.type).toBe("text");
  });
  it("reads the mode of an index that already exists, and only asks once", async () => {
    const calls = stubSequence({ status: 200, body: { cases: { mappings: { properties: { summary: { type: "semantic_text" } } } } } });
    expect(await ensureCaseIndex(cfg)).toBe("hybrid");
    expect(await ensureCaseIndex(cfg)).toBe("hybrid");
    expect(calls).toHaveLength(1);
  });
});

describe("indexDisputeCase / findSimilarCases", () => {
  it("does nothing without a config", async () => {
    const fn = vi.fn(); vi.stubGlobal("fetch", fn);
    await indexDisputeCase(undefined, doc);
    expect(await findSimilarCases(undefined, "x")).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });
  it("indexes one document per dispute, waiting for refresh so the next search can see it", async () => {
    const calls = stubSequence({ status: 404 }, { status: 200 }, { status: 201 });
    await indexDisputeCase(cfg, doc);
    expect(calls[2].url).toBe("https://es.example.com/cases/_doc/7?refresh=wait_for");
    expect(calls[2].body.summary_text).toBe("x");
  });
  it("runs hybrid retrieval (semantic + BM25 via RRF) and leaves out the dispute being asked about", async () => {
    const hit = (id: number, action: string, outcome: string) => ({ _score: 1, _source: { disputeId: id, action, merchantOutcome: outcome, findingCodes: [], summary_text: "s" } });
    const calls = stubSequence({ status: 200, body: { cases: { mappings: { properties: { summary: { type: "semantic_text" } } } } } },
      { status: 200, body: { hits: { hits: [hit(7, "contest", "pending"), hit(3, "contest", "submitted"), hit(4, "accept_claim", "dismissed")] } } });
    const r = await findSimilarCases(cfg, "unauthorised footwear", { excludeDisputeId: 7 });
    expect(r?.mode).toBe("hybrid");
    expect(r?.cases.map(c => c.disputeId)).toEqual([3, 4]);
    const sent = calls[1].body;
    expect(sent.retriever.rrf.retrievers).toHaveLength(2);
    expect(sent.retriever.rrf.retrievers[0].standard.query.semantic.field).toBe("summary");
  });
  it("falls back to keyword search when hybrid is refused, and reports that it did", async () => {
    const calls = stubSequence({ status: 200, body: { cases: { mappings: { properties: { summary: { type: "semantic_text" } } } } } },
      { status: 403 }, { status: 200, body: { hits: { hits: [] } } });
    const r = await findSimilarCases(cfg, "x");
    expect(r?.mode).toBe("keyword");
    expect(calls[2].body.query.match.summary_text).toBe("x");
  });
  it("throws when keyword search also fails, so the caller can record it", async () => {
    stubSequence({ status: 200, body: { cases: { mappings: { properties: { summary: { type: "text" } } } } } }, { status: 500 });
    await expect(findSimilarCases(cfg, "x")).rejects.toThrow("Elastic case search API 500");
  });
});

describe("summarizePrecedents", () => {
  it("counts actions and the merchant's own decisions, without predicting an outcome", () => {
    const s = summarizePrecedents([
      { disputeId: 1, action: "contest", merchantOutcome: "submitted", findingCodes: [], summary: "" },
      { disputeId: 2, action: "contest", merchantOutcome: "dismissed", findingCodes: [], summary: "" },
      { disputeId: 3, action: "accept_claim", merchantOutcome: "submitted", findingCodes: [], summary: "" },
    ]);
    expect(s.total).toBe(3);
    expect(s.byAction).toEqual({ contest: 2, accept_claim: 1 });
    expect(s.dismissedByMerchant).toBe(1);
    expect(s.text).toContain("3 similar past cases");
  });
  it("says so plainly when there are none", () => {
    expect(summarizePrecedents([]).text).toBe("No similar past cases found.");
  });
});
