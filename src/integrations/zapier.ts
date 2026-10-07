export async function notifyZapier(webhookUrl: string | undefined, event: {
  type: string; disputeId: number; message: string; data?: unknown;
}): Promise<void> {
  if (!webhookUrl) return;
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "warrant", ...event }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Zapier webhook ${res.status}`);
}

/**
 * What Warrant tells a Zap, and what it asks the Zap to do about it.
 *
 *   proposal_ready      a proposal exists. Route it to the merchant (Slack, email, a ticket).
 *   evidence_requested  the proposal is blocked on evidence only the merchant's systems have (carrier tracking, an order
 *                       management system). The Zap looks it up and POSTs it to `evidenceRequest.callbackUrl`;
 *                       Warrant re-runs the proposal. This is how "item not received" disputes stop being manual.
 *   proposal_updated    the proposal changed after evidence arrived.
 *
 * Approval is deliberately NOT something a Zap can do. `links.review` opens the approval screen, where a person decides.
 */
export interface ZapierEvent {
  type: "proposal_ready" | "evidence_requested" | "proposal_updated";
  disputeId: number;
  message: string;
  data: unknown;
  links: { review: string };
  evidenceRequest?: {
    needed: string[];
    callbackUrl: string;
    method: "POST";
    authHeader: "x-warrant-evidence-secret";
    body: { carrier: string; trackingNumber: string; deliveredAt: string };
    note: string;
  };
}

export function buildZapierEvent(
  input: { disputeId: number; message: string; data: unknown }, appUrl: string,
): ZapierEvent {
  const base = appUrl.replace(/\/$/, "");
  const d = (input.data ?? {}) as { missing?: unknown; updated?: unknown };
  const needed = Array.isArray(d.missing) ? d.missing.filter((m): m is string => typeof m === "string") : [];
  const event: ZapierEvent = {
    type: d.updated ? "proposal_updated" : needed.length ? "evidence_requested" : "proposal_ready",
    disputeId: input.disputeId, message: input.message, data: input.data,
    links: { review: `${base}/admin` },
  };
  if (needed.length) {
    event.type = d.updated ? "proposal_updated" : "evidence_requested";
    event.evidenceRequest = {
      needed, callbackUrl: `${base}/api/disputes/${input.disputeId}/evidence`, method: "POST", authHeader: "x-warrant-evidence-secret",
      body: { carrier: "UPS", trackingNumber: "1Z999AA10123456784", deliveredAt: "2026-11-03T15:00:00Z" },
      note: "Example body. Send the real carrier, tracking number and delivery time. Warrant validates every field.",
    };
  }
  return event;
}
