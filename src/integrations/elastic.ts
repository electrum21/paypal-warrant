import type { AgentEvent } from "../repo.js";

export interface ElasticConfig {
  url: string;
  apiKey: string;
  /** Agent trace events (one document per tool call). */
  index: string;
  /** Dispute cases used for precedent retrieval. Defaults to "warrant-dispute-cases". */
  caseIndex?: string;
}

export async function indexAgentEvent(cfg: ElasticConfig | undefined, event: AgentEvent): Promise<void> {
  if (!cfg) return;
  const res = await fetch(`${cfg.url.replace(/\/$/, "")}/${cfg.index}/_doc/${event.id}`, {
    method: "PUT",
    headers: { authorization: `ApiKey ${cfg.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ ...event, "@timestamp": event.createdAt }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Elastic indexing API ${res.status}`);
}

export async function searchAgentEvents(cfg: ElasticConfig | undefined, query: string): Promise<unknown[]> {
  if (!cfg) return [];
  const res = await fetch(`${cfg.url.replace(/\/$/, "")}/${cfg.index}/_search`, {
    method: "POST",
    headers: { authorization: `ApiKey ${cfg.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ query: { multi_match: { query, fields: ["toolName", "eventType", "input.*", "output.*"], lenient: true } }, size: 20 }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Elastic search API ${res.status}`);
  const data = await res.json() as { hits?: { hits?: { _source?: unknown }[] } };
  return data.hits?.hits?.flatMap(hit => hit._source ? [hit._source] : []) ?? [];
}


// ---- Dispute cases: retrieval for the merchant agent ----------------------------------------------------------------
//
// The merchant agent decides with plain code, but a merchant also wants to know "what happened last time this looked like
// this?". Each dispute is indexed as a CASE (facts + the outcome the merchant chose) with a semantic_text field, so the
// agent can retrieve similar past cases with hybrid search (semantic + BM25, fused with RRF). The result is advisory: it is
// shown next to the proposal and passed to the explanation, and it never changes the proposed action.

export interface DisputeCase {
  disputeId: number;
  paypalDisputeId: string;
  reason: string;
  action: string;                                   // contest | offer_partial_refund | accept_claim | escalate_to_human
  merchantOutcome: "pending" | "submitted" | "dismissed" | "failed";
  amountCents: number | null;
  currency: string;
  findingCodes: string[];
  agentId?: string;
  category?: string;
  productTitle?: string;
  productVerdict?: string;
  hasDeliveryProof: boolean;
  summary: string;
  createdAt: string;
}

/** The merchant's decision on a proposal, in the words the index uses. */
export function outcomeOf(workflowState: string): DisputeCase["merchantOutcome"] {
  return workflowState === "SUBMITTED" ? "submitted" : workflowState === "REJECTED" ? "dismissed" : workflowState === "FAILED" ? "failed" : "pending";
}

/** Plain-language text that gets embedded and keyword-searched. Built from verified facts only. */
export function caseSummary(c: Pick<DisputeCase, "reason" | "action" | "findingCodes" | "category" | "productTitle" | "productVerdict" | "hasDeliveryProof">): string {
  return [
    `Dispute reason ${c.reason}.`,
    c.findingCodes.length ? `Mandate findings: ${c.findingCodes.join(", ")}.` : "The purchase was within the mandate.",
    c.category ? `Category ${c.category}.` : "",
    c.productTitle ? `Product ${c.productTitle}${c.productVerdict ? ` (${c.productVerdict.replace(/_/g, " ")})` : ""}.` : "",
    c.hasDeliveryProof ? "Delivery proof on file." : "No delivery proof.",
    `Proposed ${c.action.replace(/_/g, " ")}.`,
  ].filter(Boolean).join(" ");
}

const caseIndexName = (cfg: ElasticConfig) => cfg.caseIndex ?? "warrant-dispute-cases";
const baseUrl = (cfg: ElasticConfig) => cfg.url.replace(/\/$/, "");
const headers = (cfg: ElasticConfig) => ({ authorization: `ApiKey ${cfg.apiKey}`, "content-type": "application/json" });

const CASE_PROPS = {
  summary_text: { type: "text" }, reason: { type: "keyword" }, action: { type: "keyword" }, merchantOutcome: { type: "keyword" },
  findingCodes: { type: "keyword" }, agentId: { type: "keyword" }, category: { type: "keyword" }, disputeId: { type: "long" },
  paypalDisputeId: { type: "keyword" }, amountCents: { type: "long" }, currency: { type: "keyword" }, createdAt: { type: "date" },
  hasDeliveryProof: { type: "boolean" }, productTitle: { type: "text" }, productVerdict: { type: "keyword" },
};

/** "hybrid" when the index has a semantic_text field, "keyword" when the cluster could not provide one. */
export type RetrievalMode = "hybrid" | "keyword";
const modes = new Map<string, RetrievalMode>();

export async function ensureCaseIndex(cfg: ElasticConfig): Promise<RetrievalMode> {
  const key = `${baseUrl(cfg)}/${caseIndexName(cfg)}`;
  const known = modes.get(key);
  if (known) return known;
  const existing = await fetch(`${key}/_mapping`, { headers: headers(cfg), signal: AbortSignal.timeout(10_000) });
  if (existing.ok) {
    const m = await existing.json() as Record<string, { mappings?: { properties?: { summary?: { type?: string } } } }>;
    const type = Object.values(m)[0]?.mappings?.properties?.summary?.type;
    const mode: RetrievalMode = type === "semantic_text" ? "hybrid" : "keyword";
    modes.set(key, mode); return mode;
  }
  if (existing.status !== 404) throw new Error(`Elastic mapping API ${existing.status}`);
  for (const [mode, summary] of [["hybrid", { type: "semantic_text" }], ["keyword", { type: "text" }]] as const) {
    const res = await fetch(key, { method: "PUT", headers: headers(cfg), body: JSON.stringify({ mappings: { properties: { summary, ...CASE_PROPS } } }), signal: AbortSignal.timeout(15_000) });
    if (res.ok) { modes.set(key, mode); return mode; }
    if (mode === "keyword") throw new Error(`Elastic index creation API ${res.status}`);
  }
  throw new Error("unreachable");
}

/** Test hook: forget what was learned about an index. */
export function resetElasticCaches() { modes.clear(); }

export async function indexDisputeCase(cfg: ElasticConfig | undefined, doc: DisputeCase): Promise<void> {
  if (!cfg) return;
  await ensureCaseIndex(cfg);
  const res = await fetch(`${baseUrl(cfg)}/${caseIndexName(cfg)}/_doc/${doc.disputeId}?refresh=wait_for`, {
    method: "PUT", headers: headers(cfg),
    body: JSON.stringify({ ...doc, summary_text: doc.summary }), signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Elastic case indexing API ${res.status}`);
}

export interface Precedent {
  disputeId: number; paypalDisputeId?: string; reason?: string; action: string; merchantOutcome: DisputeCase["merchantOutcome"];
  findingCodes: string[]; amountCents?: number | null; summary: string; score?: number;
}

export async function findSimilarCases(
  cfg: ElasticConfig | undefined, text: string, opts: { excludeDisputeId?: number; size?: number } = {},
): Promise<{ mode: RetrievalMode; cases: Precedent[] } | undefined> {
  if (!cfg) return undefined;
  const size = opts.size ?? 5;
  const mode = await ensureCaseIndex(cfg);
  const url = `${baseUrl(cfg)}/${caseIndexName(cfg)}/_search`;
  const run = (body: unknown) => fetch(url, { method: "POST", headers: headers(cfg), body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const common = { size: size + 1, _source: ["disputeId", "paypalDisputeId", "reason", "action", "merchantOutcome", "findingCodes", "amountCents", "summary_text"] };
  let used: RetrievalMode = mode;
  let res: Response | undefined;
  if (mode === "hybrid") {
    res = await run({ ...common, retriever: { rrf: { rank_window_size: 25, retrievers: [
      { standard: { query: { semantic: { field: "summary", query: text } } } },
      { standard: { query: { match: { summary_text: text } } } },
    ] } } });
    // Hybrid can be refused (license, older cluster). Fall back to plain keyword search rather than losing precedents.
    if (!res.ok) { used = "keyword"; res = undefined; }
  } else used = "keyword";
  if (!res) res = await run({ ...common, query: { match: { summary_text: text } } });
  if (!res.ok) throw new Error(`Elastic case search API ${res.status}`);
  const data = await res.json() as { hits?: { hits?: { _score?: number; _source?: Record<string, any> }[] } };
  const cases = (data.hits?.hits ?? []).flatMap((h): Precedent[] => {
    const s = h._source; if (!s || typeof s.disputeId !== "number" || s.disputeId === opts.excludeDisputeId) return [];
    return [{
      disputeId: s.disputeId, paypalDisputeId: s.paypalDisputeId, reason: s.reason, action: String(s.action ?? ""),
      merchantOutcome: s.merchantOutcome ?? "pending", findingCodes: Array.isArray(s.findingCodes) ? s.findingCodes : [],
      amountCents: s.amountCents ?? null, summary: String(s.summary_text ?? ""), score: h._score,
    }];
  }).slice(0, size);
  return { mode: used, cases };
}

export interface PrecedentSummary {
  total: number;
  byAction: Record<string, number>;
  submitted: number;
  dismissedByMerchant: number;
  /** One factual sentence for the merchant. Counts only; no prediction about how PayPal will rule. */
  text: string;
}

/** Plain counts over retrieved cases. Advisory only. */
export function summarizePrecedents(cases: Precedent[]): PrecedentSummary {
  const byAction: Record<string, number> = {};
  for (const c of cases) byAction[c.action] = (byAction[c.action] ?? 0) + 1;
  const submitted = cases.filter(c => c.merchantOutcome === "submitted").length;
  const dismissedByMerchant = cases.filter(c => c.merchantOutcome === "dismissed").length;
  const parts = Object.entries(byAction).map(([a, n]) => `${n} ${a.replace(/_/g, " ")}`);
  const text = cases.length === 0 ? "No similar past cases found."
    : `${cases.length} similar past case${cases.length === 1 ? "" : "s"} (${parts.join(", ")}); you submitted ${submitted} and dismissed ${dismissedByMerchant}.`;
  return { total: cases.length, byAction, submitted, dismissedByMerchant, text };
}
