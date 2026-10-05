import type { AgentEvent } from "../repo.js";

export interface ElasticConfig {
  url: string;
  apiKey: string;
  index: string;
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
