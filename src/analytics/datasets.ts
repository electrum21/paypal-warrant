import type { Db } from "../db/index.js";
import { toIso } from "../repo.js";

/**
 * Flat tables for the AG Studio dashboard. Studio charts and groups plain rows, so everything here is already denormalised:
 * one row per dispute / order / agent / agent step, with money in major units and yes/no flags as strings (good chart categories).
 * Read-only. Nothing in this file can change a dispute or move money.
 */
export interface AnalyticsDatasets {
  generatedAt: string;
  disputes: DisputeRow[];
  orders: OrderRow[];
  agents: AgentRow[];
  agentSteps: AgentStepRow[];
}

export interface DisputeRow {
  id: number; paypalDisputeId: string; openedAt: string; day: string; reason: string; paypalStatus: string; workflowState: string;
  recommendedAction: string; actionReason: string; amount: number; currency: string; agentId: string; userId: string; mandateId: string;
  mandateLimit: number; overLimitBy: number; category: string; signature: "valid" | "invalid"; findings: string; primaryFinding: string;
  productVerdict: string; hasDeliveryProof: "yes" | "no"; missingEvidence: string; narrativeSource: string;
  similarCases: number; similarCasesDismissed: number; precedentMode: string;
}
export interface OrderRow {
  orderId: number; paypalOrderId: string; day: string; amount: number; currency: string; category: string; agentId: string; userId: string;
  mandateId: string; outOfMandate: "yes" | "no"; productVerdict: string; disputed: "yes" | "no";
}
export interface AgentRow {
  agentId: string; orders: number; spend: number; disputes: number; outOfMandateOrders: number; disputeRatePct: number; topFinding: string;
}
export interface AgentStepRow { id: number; runId: string; disputeId: number | null; agentType: string; toolName: string; eventType: string; status: string; day: string }

const major = (cents: number | null | undefined) => (cents ?? 0) / 100;
const day = (sqlTime: string) => toIso(sqlTime).slice(0, 10);
const json = <T>(s: string | null | undefined, fallback: T): T => { try { return s ? JSON.parse(s) as T : fallback; } catch { return fallback; } };

export function buildAnalytics(db: Db, now = new Date()): AnalyticsDatasets {
  const orderRows = db.prepare(`
    SELECT o.id, o.paypal_order_id, o.amount_cents, o.currency, o.category, o.mandate_id, o.mandate_findings_json, o.created_at,
           m.user_id, m.agent_id, pc.check_json
      FROM orders o
      LEFT JOIN mandates m ON m.id = o.mandate_id
      LEFT JOIN product_checks pc ON pc.order_id = o.id
     ORDER BY o.id`).all() as any[];
  const disputedOrderIds = new Set((db.prepare("SELECT DISTINCT order_id FROM disputes WHERE order_id IS NOT NULL").all() as any[]).map(r => r.order_id));

  const orders: OrderRow[] = orderRows.map(r => {
    const findings = json<{ severity: string }[]>(r.mandate_findings_json, []);
    return {
      orderId: r.id, paypalOrderId: r.paypal_order_id ?? "", day: day(r.created_at), amount: major(r.amount_cents), currency: r.currency,
      category: r.category ?? "unspecified", agentId: r.agent_id ?? "unknown", userId: r.user_id ?? "unknown", mandateId: r.mandate_id ?? "none",
      outOfMandate: findings.some(f => f.severity === "block") ? "yes" : "no",
      productVerdict: json<{ categoryVerdict?: string }>(r.check_json, {}).categoryVerdict ?? "not_checked",
      disputed: disputedOrderIds.has(r.id) ? "yes" : "no",
    };
  });

  const disputeRows = db.prepare(`
    SELECT d.id, d.paypal_dispute_id, d.reason, d.status, d.amount_cents, d.workflow_state, d.decision_json, d.created_at,
           o.currency, o.category, o.mandate_id, m.user_id, m.agent_id
      FROM disputes d
      LEFT JOIN orders o ON o.id = d.order_id
      LEFT JOIN mandates m ON m.id = o.mandate_id
     ORDER BY d.id`).all() as any[];

  const disputes: DisputeRow[] = disputeRows.map(r => {
    const p = json<any>(r.decision_json, {});
    const codes: string[] = (p.findings ?? []).map((f: { code: string }) => f.code);
    const blocking: string[] = (p.findings ?? []).filter((f: { severity: string }) => f.severity === "block").map((f: { code: string }) => f.code);
    const amount = major(r.amount_cents);
    const limit = major(p.mandate?.maxAmountCents);
    return {
      id: r.id, paypalDisputeId: r.paypal_dispute_id, openedAt: toIso(r.created_at), day: day(r.created_at), reason: r.reason ?? "UNKNOWN",
      paypalStatus: r.status ?? "UNKNOWN", workflowState: r.workflow_state, recommendedAction: p.decision?.action ?? "none",
      actionReason: p.decision?.reason ?? "", amount, currency: r.currency ?? p.purchase?.currency ?? "USD",
      agentId: r.agent_id ?? "unknown", userId: r.user_id ?? "unknown", mandateId: r.mandate_id ?? "none",
      mandateLimit: limit, overLimitBy: limit > 0 && amount > limit ? Math.round((amount - limit) * 100) / 100 : 0,
      category: r.category ?? "unspecified", signature: p.signatureValid ? "valid" : "invalid",
      findings: codes.length ? codes.join(", ") : "none", primaryFinding: blocking[0] ?? codes[0] ?? "none",
      productVerdict: p.productCheck?.categoryVerdict ?? "not_checked", hasDeliveryProof: p.deliveryProof?.length ? "yes" : "no",
      missingEvidence: (p.missingEvidence ?? []).join(", ") || "none", narrativeSource: p.narrativeSource ?? "template",
      similarCases: p.precedents?.summary?.total ?? 0, similarCasesDismissed: p.precedents?.summary?.dismissedByMerchant ?? 0,
      precedentMode: p.precedents?.mode ?? "not_used",
    };
  });

  // Per-agent risk: which buyer agents keep producing out-of-mandate or disputed purchases?
  const byAgent = new Map<string, AgentRow & { _codes: Map<string, number> }>();
  const agentRow = (id: string) => {
    let a = byAgent.get(id);
    if (!a) byAgent.set(id, a = { agentId: id, orders: 0, spend: 0, disputes: 0, outOfMandateOrders: 0, disputeRatePct: 0, topFinding: "none", _codes: new Map() });
    return a;
  };
  for (const o of orders) { const a = agentRow(o.agentId); a.orders++; a.spend += o.amount; if (o.outOfMandate === "yes") a.outOfMandateOrders++; }
  for (const d of disputes) {
    const a = agentRow(d.agentId); a.disputes++;
    if (d.primaryFinding !== "none") a._codes.set(d.primaryFinding, (a._codes.get(d.primaryFinding) ?? 0) + 1);
  }
  const agents: AgentRow[] = [...byAgent.values()].map(({ _codes, ...a }) => ({
    ...a, spend: Math.round(a.spend * 100) / 100,
    disputeRatePct: a.orders ? Math.round((a.disputes / a.orders) * 1000) / 10 : 0,
    topFinding: [..._codes.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? "none",
  })).sort((a, b) => b.disputeRatePct - a.disputeRatePct || b.spend - a.spend);

  const agentSteps: AgentStepRow[] = (db.prepare("SELECT id, run_id, dispute_id, agent_type, tool_name, event_type, status, created_at FROM agent_events ORDER BY id DESC LIMIT 2000").all() as any[])
    .map(r => ({ id: r.id, runId: r.run_id, disputeId: r.dispute_id, agentType: r.agent_type, toolName: r.tool_name, eventType: r.event_type, status: r.status, day: day(r.created_at) }));

  return { generatedAt: now.toISOString(), disputes, orders, agents, agentSteps };
}
