import type { Db } from "../db/index.js";
import type { AuthorizationCheck, Finding, Mandate, Purchase, SignedCart, SignedMandate } from "../mandate/types.js";
import { checkPurchase } from "../mandate/check.js";
import { verifyAuthorization } from "../mandate/authorize.js";
import { decideDisputeResponse, type DisputeDecision } from "./decide.js";
import { buildEvidencePack } from "./evidencePack.js";
import { draftNarrative, formatMoney, type LlmClient } from "../ai/draft.js";
import type { DisputesApi } from "../paypal/disputes.js";
import { getAgentKey, getAgentPause, getRevocation, getUserKey, listAgentEvents, listControlEvents, recordAgentEvent, toIso } from "../repo.js";

export interface Deps {
  db: Db;
  disputes: DisputesApi;
  llm?: LlmClient;
  now?: () => Date;
  onAgentEvent?: (eventId: number) => Promise<void>;
  onProposal?: (disputeId: number, message: string, data: unknown) => Promise<void>;
}

export class ServiceError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type WorkflowState = "PROPOSED" | "APPROVED" | "SUBMITTED" | "FAILED" | "REJECTED";

/** What we store in disputes.decision_json. */
interface Proposal {
  decision: DisputeDecision;
  findings: Finding[];
  signatureValid: boolean;
  /** Who signed what: user on the mandate, agent on the cart. signatureValid is true only if all of it holds. */
  authorization?: AuthorizationCheck;
  explanation: string;
  evidenceNote: string;
  narrativeSource: "llm" | "template";
  narrativeFallbackReason?: string;
  /** Set when PayPal does not currently allow the proposed response. The merchant can only dismiss. */
  blockedReason?: string;
  purchase?: Purchase;
  mandate?: Pick<Mandate, "id" | "description" | "maxAmountCents" | "currency" | "expiresAt">;
}

export interface DisputeRecord extends Partial<Proposal> {
  id: number;
  paypalDisputeId: string;
  reason: string | null;
  paypalStatus: string | null;
  amountCents: number | null;
  workflowState: WorkflowState;
  submitError: string | null;
  approvedAt: string | null;
  agentEvents?: ReturnType<typeof listAgentEvents>;
}

const toCents = (v: string) => Math.round(parseFloat(v) * 100);

/** The PayPal link rel each proposed action needs. */
const REQUIRED_LINK: Record<string, string | undefined> = {
  contest: "provide_evidence",
  offer_partial_refund: "make_offer",
  accept_claim: "accept_claim",
};

/**
 * Checks the proposal against what PayPal says it will accept right now. Returns a plain-language reason
 * when it will not accept it. If PayPal gave no links at all (older fakes, partial data) we cannot tell, so we allow it.
 */
export function blockedReasonFor(decision: DisputeDecision, links: { rel: string }[] | undefined, currency?: string): string | undefined {
  const need = REQUIRED_LINK[decision.action];
  if (!links || !need || links.some(l => l.rel === need)) return undefined;
  const offered = links.map(l => l.rel).filter(r => r !== "self").map(r => r.replace(/_/g, " "));
  const offeredText = offered.length ? `PayPal currently allows: ${offered.join(", ")}.` : "PayPal currently allows no response.";
  if (decision.action === "offer_partial_refund") {
    const excess = decision.refundCents ? formatMoney(decision.refundCents, currency ?? "USD") : "the excess";
    return `PayPal does not accept a partial-refund offer on this dispute at its current stage. ${offeredText} `
      + `To act on this proposal, refund ${excess} yourself in PayPal and respond there, or dismiss it.`;
  }
  return `PayPal does not currently accept this response on the dispute. ${offeredText} Handle it in PayPal, or dismiss this proposal.`;
}

function toRecord(db: Db, row: any): DisputeRecord {
  const p: Partial<Proposal> = row.decision_json ? JSON.parse(row.decision_json) : {};
  return {
    id: row.id, paypalDisputeId: row.paypal_dispute_id, reason: row.reason, paypalStatus: row.status,
    amountCents: row.amount_cents, workflowState: row.workflow_state, submitError: row.submit_error,
    approvedAt: row.merchant_approved_at, ...p,
    agentEvents: listAgentEvents(db, row.id),
  };
}

export function listDisputes(db: Db): DisputeRecord[] {
  return db.prepare("SELECT * FROM disputes ORDER BY id DESC").all().map(row => toRecord(db, row));
}

export function getDispute(db: Db, id: number): DisputeRecord {
  const row = db.prepare("SELECT * FROM disputes WHERE id = ?").get(id);
  if (!row) throw new ServiceError(404, "Dispute not found.");
  return toRecord(db, row);
}

/**
 * Turns a PayPal dispute into a stored PROPOSAL. Nothing is sent to PayPal here.
 * Safe to call twice for the same dispute (webhook retries): the second call returns the first result.
 */
export async function processDispute(deps: Deps, paypalDisputeId: string): Promise<DisputeRecord> {
  const { db } = deps;
  const runId = `dispute-${paypalDisputeId}`;
  const trace = (toolName: string, input: unknown, output: unknown, eventType = "tool_call") => {
    const eventId = recordAgentEvent(db, { runId, agentType: "merchant-dispute", eventType, toolName, input, output });
    if (deps.onAgentEvent) {
      void deps.onAgentEvent(eventId).catch(err => console.error(`agent event ${eventId} integration failed`, err));
    }
    return eventId;
  };
  const existing = db.prepare("SELECT * FROM disputes WHERE paypal_dispute_id = ?").get(paypalDisputeId);
  if (existing) return toRecord(db, existing);

  trace("observe_dispute", { paypalDisputeId }, { status: "received" }, "observation");
  const d = await deps.disputes.get(paypalDisputeId);
  trace("get_dispute", { paypalDisputeId }, { reason: d.reason, status: d.status, links: d.links?.map(l => l.rel) ?? [] });
  const reason = d.reason ?? "UNKNOWN";
  const captureId = d.disputed_transactions?.[0]?.seller_transaction_id;
  const order: any = captureId ? db.prepare("SELECT * FROM orders WHERE paypal_capture_id = ?").get(captureId) : undefined;
  trace("match_order", { captureId }, { matched: Boolean(order), orderId: order?.id ?? null });
  const disputeCents = d.dispute_amount ? toCents(d.dispute_amount.value) : (order?.amount_cents ?? null);

  const save = (orderId: number | null, p: Proposal): DisputeRecord => {
    const r = db.prepare(`INSERT INTO disputes (paypal_dispute_id, order_id, reason, status, amount_cents, decision_json)
                          VALUES (?, ?, ?, ?, ?, ?)`)
      .run(d.dispute_id, orderId, reason, d.status ?? null, disputeCents, JSON.stringify(p));
    db.prepare("UPDATE agent_events SET dispute_id = ? WHERE run_id = ? AND dispute_id IS NULL").run(Number(r.lastInsertRowid), runId);
    trace("recommend_response", { reason, orderId }, { action: p.decision.action, reason: p.decision.reason }, "recommendation");
    db.prepare("UPDATE agent_events SET dispute_id = ? WHERE run_id = ? AND dispute_id IS NULL").run(Number(r.lastInsertRowid), runId);
    if (deps.onProposal) {
      void deps.onProposal(Number(r.lastInsertRowid), `New proposal: ${p.decision.action}`, { action: p.decision.action, reason })
        .catch(err => console.error(`proposal notification for dispute ${r.lastInsertRowid} failed`, err));
    }
    return { ...toRecord(db, db.prepare("SELECT * FROM disputes WHERE id = ?").get(Number(r.lastInsertRowid))) };
  };

  const escalate = (why: string, orderId: number | null): DisputeRecord =>
    save(orderId, {
      decision: { action: "escalate_to_human", reason: why }, findings: [], signatureValid: false,
      explanation: `${why} Warrant cannot respond automatically, so this needs your review in PayPal.`,
      evidenceNote: "", narrativeSource: "template",
    });

  if (!order) return escalate("No order in Warrant matches the disputed transaction.", null);
  const mandateRow: any = order.mandate_id ? db.prepare("SELECT * FROM mandates WHERE id = ?").get(order.mandate_id) : undefined;
  if (!mandateRow) return escalate("The order has no mandate, so it may not be an agent purchase.", order.id);

  const mandate = JSON.parse(mandateRow.mandate_json) as Mandate;
  const signed: SignedMandate = { mandate, mandateHash: mandateRow.mandate_hash, signature: mandateRow.signature };
  const purchase: Purchase = {
    merchantId: order.merchant_id, amountCents: order.amount_cents, currency: order.currency,
    category: order.category ?? undefined, at: toIso(order.created_at),
  };
  const signedCart: SignedCart | undefined = order.cart_json ? JSON.parse(order.cart_json) : undefined;
  const authorization = verifyAuthorization({
    signedMandate: signed, signedCart, purchase,
    userPublicKeyPem: getUserKey(db, mandate.userId), agentPublicKeyPem: getAgentKey(db, mandate.agentId),
  });
  const signatureValid = authorization.ok;
  trace("verify_authorization", { mandateId: mandate.id, userId: mandate.userId, agentId: mandate.agentId, cartId: signedCart?.cart.cartId ?? null },
    { signatureValid, mandateSignedByUser: authorization.mandateSignedByUser, cartSignedByAgent: authorization.cartSignedByAgent,
      cartBoundToMandate: authorization.cartBoundToMandate, cartMatchesPurchase: authorization.cartMatchesPurchase });

  // Revocation and pause are judged as of the purchase time: a stop issued AFTER the purchase does not make it unauthorized.
  const revocation = getRevocation(db, mandate.id, mandate.userId);
  const pause = getAgentPause(db, mandate.userId, purchase.at);
  const findings = checkPurchase(mandate, purchase, {
    revokedAt: revocation?.revokedAt ?? null, revokedReason: revocation?.reason, agentPaused: pause.paused ? pause : null,
  });
  trace("check_purchase", { amountCents: purchase.amountCents, currency: purchase.currency }, { findings: findings.map(f => f.code) });
  const userControls = listControlEvents(db, mandate.userId, mandate.id);
  trace("check_user_controls", { userId: mandate.userId, mandateId: mandate.id }, {
    events: userControls.map(e => ({ action: e.action, appliedAt: e.appliedAt, via: e.via })),
    revokedBeforePurchase: findings.some(f => f.code === "MANDATE_REVOKED"), pausedAtPurchase: findings.some(f => f.code === "AGENT_PAUSED"),
  });
  const decision = decideDisputeResponse({
    reason, orderAmountCents: order.amount_cents, signatureValid, findings, hasDeliveryProof: false, currency: purchase.currency,
  });
  const generatedAt = (deps.now?.() ?? new Date()).toISOString();
  const pack = buildEvidencePack({
    disputeId: d.dispute_id, paypalOrderId: order.paypal_order_id ?? "", signed, signatureValid,
    purchase, findings, decision, generatedAt, signedCart, authorization,
    userControls: userControls.map(e => ({ action: e.action, subjectId: e.subjectId, reason: e.reason ?? undefined, appliedAt: e.appliedAt, via: e.via })),
  });

  const money = (c: number) => formatMoney(c, purchase.currency);
  const facts = {
    disputeReason: reason,
    action: decision.action,
    actionReason: decision.reason,
    refund: decision.refundCents ? money(decision.refundCents) : undefined,
    signatureValid,
    signatureProblems: authorization.problems,
    findings: findings.map(f => ({ code: f.code, message: f.message })),
    mandate: { instruction: mandate.description, limit: money(mandate.maxAmountCents), validFrom: mandate.validFrom, expiresAt: mandate.expiresAt },
    purchase: { amount: money(purchase.amountCents), merchantId: purchase.merchantId, at: purchase.at },
    hasDeliveryProof: false,
  };
  const templateExplanation = `Proposed: ${decision.action.replace(/_/g, " ")}. ${decision.reason}`
    + (findings.length ? ` Findings: ${findings.map(f => f.code).join(", ")}.` : "");
  const narrative = await draftNarrative(
    { facts, template: { explanation: templateExplanation, evidenceNote: pack.notes.slice(0, 1800) } }, deps.llm);

  // Exact identifiers come from the database, never from the LLM. The template note already contains
  // them (it is built from the evidence pack), so only prepend the block when the LLM wrote the text.
  const evidenceNote = narrative.source === "llm"
    ? [
        `Signed mandate ${mandate.id} (sha256 ${signed.mandateHash}).`,
        `Signature check: ${signatureValid ? "VALID" : "INVALID"} (mandate signed by user ${mandate.userId}: ${authorization.mandateSignedByUser ? "yes" : "no"}; cart signed by agent ${mandate.agentId}: ${authorization.cartSignedByAgent ? "yes" : "no"}).`,
        `Buyer instruction to the agent: "${mandate.description.slice(0, 300)}"`,
        ``,
        narrative.evidenceNote,
      ].join("\n")
    : narrative.evidenceNote;

  const blockedReason = blockedReasonFor(decision, d.links, purchase.currency);
  trace("identify_missing_evidence", { reason, hasDeliveryProof: false }, {
    missing: decision.action === "escalate_to_human" ? ["delivery proof"] : [],
  }, "observation");
  // Code-written, so the AI cannot soften or contradict it.
  const explanation = blockedReason ? `${narrative.explanation} ${blockedReason}` : narrative.explanation;

  const rec = save(order.id, {
    decision, findings, signatureValid, authorization, explanation, evidenceNote, blockedReason,
    narrativeSource: narrative.source, narrativeFallbackReason: narrative.fallbackReason, purchase,
    mandate: { id: mandate.id, description: mandate.description, maxAmountCents: mandate.maxAmountCents, currency: mandate.currency, expiresAt: mandate.expiresAt },
  });
  const savedEvents = listAgentEvents(db, rec.id);
  if (savedEvents.length === 0) {
    recordAgentEvent(db, { runId, agentType: "merchant-dispute", disputeId: rec.id, eventType: "observation", toolName: "investigation_complete",
      input: { disputeId: d.dispute_id }, output: { confidence: signatureValid && findings.length === 0 ? "high" : "medium" } });
  } else {
    for (const event of savedEvents) {
      if (event.disputeId === null) {
        db.prepare("UPDATE agent_events SET dispute_id = ? WHERE id = ?").run(rec.id, event.id);
      }
    }
  }
  db.prepare("INSERT INTO evidence_packs (dispute_id, pack_json) VALUES (?, ?)").run(rec.id, JSON.stringify(pack.json));
  return rec;
}

/**
 * The only path that sends anything to PayPal, and only after the merchant approves.
 * Retries after a failure reuse the same PayPal-Request-Id, so they cannot double-submit.
 */
export async function approveDispute(deps: Deps, id: number, noteOverride?: string): Promise<DisputeRecord> {
  const { db } = deps;
  const rec = getDispute(db, id);
  const decision = rec.decision;
  if (!decision) throw new ServiceError(409, "This dispute has no proposal.");
  if (decision.action === "escalate_to_human") {
    throw new ServiceError(409, "This case needs a human decision and cannot be submitted from Warrant. Handle it in PayPal.");
  }
  if (rec.blockedReason) throw new ServiceError(409, rec.blockedReason);
  const claimed = db.prepare(
    "UPDATE disputes SET workflow_state = 'APPROVED', merchant_approved_at = ?, submit_error = NULL, updated_at = datetime('now') WHERE id = ? AND workflow_state IN ('PROPOSED','FAILED')",
  ).run((deps.now?.() ?? new Date()).toISOString(), id);
  if (Number(claimed.changes) !== 1) throw new ServiceError(409, `Dispute is already ${rec.workflowState.toLowerCase()}.`);

  const note = (noteOverride?.trim() || rec.evidenceNote || decision.reason).slice(0, 2000);
  const requestId = `warrant-${rec.paypalDisputeId}-${decision.action}`;
  try {
    if (decision.action === "contest") {
      await deps.disputes.provideEvidence(rec.paypalDisputeId, note, requestId);
    } else if (decision.action === "offer_partial_refund") {
      await deps.disputes.makeOffer(rec.paypalDisputeId, { note, amountCents: decision.refundCents ?? 0, currency: rec.purchase?.currency ?? "USD" }, requestId);
    } else {
      await deps.disputes.acceptClaim(rec.paypalDisputeId, note, requestId);
    }
  } catch (err) {
    db.prepare("UPDATE disputes SET workflow_state = 'FAILED', submit_error = ?, note_final = ?, updated_at = datetime('now') WHERE id = ?")
      .run((err as Error).message.slice(0, 1000), note, id);
    return getDispute(db, id);
  }
  db.prepare("UPDATE disputes SET workflow_state = 'SUBMITTED', note_final = ?, updated_at = datetime('now') WHERE id = ?").run(note, id);
  db.prepare("UPDATE evidence_packs SET submitted_at = datetime('now') WHERE dispute_id = ?").run(id);
  return getDispute(db, id);
}

export function rejectDispute(db: Db, id: number): DisputeRecord {
  const r = db.prepare(
    "UPDATE disputes SET workflow_state = 'REJECTED', updated_at = datetime('now') WHERE id = ? AND workflow_state IN ('PROPOSED','FAILED')",
  ).run(id);
  if (Number(r.changes) !== 1) {
    const rec = getDispute(db, id); // throws 404 if missing
    throw new ServiceError(409, `Dispute is already ${rec.workflowState.toLowerCase()}.`);
  }
  return getDispute(db, id);
}