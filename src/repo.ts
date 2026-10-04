import type { Db } from "./db/index.js";
import type { Finding, SignedMandate } from "./mandate/types.js";

/** SQLite's datetime('now') has no zone marker; Date.parse would read it as local time. */
export function toIso(s: string): string {
  return /(Z|[+-]\d\d:\d\d)$/i.test(s) ? s : `${s.replace(" ", "T")}Z`;
}

export function registerAgentKey(db: Db, agentId: string, publicKeyPem: string) {
  db.prepare("INSERT INTO agent_keys (agent_id, public_key_pem) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET public_key_pem = excluded.public_key_pem")
    .run(agentId, publicKeyPem);
}

export function getAgentKey(db: Db, agentId: string): string | undefined {
  return (db.prepare("SELECT public_key_pem FROM agent_keys WHERE agent_id = ?").get(agentId) as { public_key_pem: string } | undefined)?.public_key_pem;
}

/** The agent key must be registered first (foreign key). */
export function saveMandate(db: Db, sm: SignedMandate) {
  const m = sm.mandate;
  db.prepare(`INSERT OR IGNORE INTO mandates (id, user_id, agent_id, mandate_json, mandate_hash, signature)
              VALUES (?, ?, ?, ?, ?, ?)`).run(m.id, m.userId, m.agentId, JSON.stringify(m), sm.mandateHash, sm.signature);
}

export function revokeMandate(db: Db, mandateId: string, at = new Date().toISOString()) {
  db.prepare("UPDATE mandates SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(at, mandateId);
}

export function recordOrder(db: Db, o: {
  paypalOrderId: string; mandateId: string | null; merchantId: string; amountCents: number;
  currency: string; category?: string; findings: Finding[]; at?: string; captureId?: string;
}): number {
  const r = db.prepare(`INSERT INTO orders (paypal_order_id, mandate_id, merchant_id, amount_cents, currency, category,
                          paypal_capture_id, mandate_findings_json, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(o.paypalOrderId, o.mandateId, o.merchantId, o.amountCents, o.currency, o.category ?? null,
         o.captureId ?? null, JSON.stringify(o.findings), o.at ?? new Date().toISOString());
  return Number(r.lastInsertRowid);
}

export function markCaptured(db: Db, paypalOrderId: string, captureId: string) {
  db.prepare("UPDATE orders SET paypal_capture_id = ?, status = 'CAPTURED' WHERE paypal_order_id = ?").run(captureId, paypalOrderId);
}

export interface AgentEvent {
  id: number;
  runId: string;
  agentType: string;
  disputeId: number | null;
  eventType: string;
  toolName: string;
  input: unknown;
  output: unknown;
  status: string;
  createdAt: string;
}

export function recordAgentEvent(db: Db, event: {
  runId: string; agentType: string; disputeId?: number | null; eventType: string;
  toolName: string; input?: unknown; output?: unknown; status?: string;
}): number {
  const r = db.prepare(`INSERT INTO agent_events
    (run_id, agent_type, dispute_id, event_type, tool_name, input_json, output_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    event.runId, event.agentType, event.disputeId ?? null, event.eventType, event.toolName,
    JSON.stringify(event.input ?? {}), JSON.stringify(event.output ?? {}), event.status ?? "completed",
  );
  return Number(r.lastInsertRowid);
}

export function listAgentEvents(db: Db, disputeId: number): AgentEvent[] {
  return (db.prepare("SELECT * FROM agent_events WHERE dispute_id = ? ORDER BY id").all(disputeId) as any[]).map(row => ({
    id: row.id, runId: row.run_id, agentType: row.agent_type, disputeId: row.dispute_id,
    eventType: row.event_type, toolName: row.tool_name, input: JSON.parse(row.input_json),
    output: JSON.parse(row.output_json), status: row.status, createdAt: row.created_at,
  }));
}