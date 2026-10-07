import type { Db } from "../db/index.js";
import type { AuthorizationCheck, Finding, Mandate, Purchase, SignedCart, SignedMandate } from "../mandate/types.js";
import { checkPurchase } from "../mandate/check.js";
import { verifyAuthorization } from "../mandate/authorize.js";
import { decideDisputeResponse, type DisputeDecision } from "./decide.js";
import { buildEvidencePack } from "./evidencePack.js";
import { draftNarrative, formatMoney, type LlmClient } from "../ai/draft.js";
import type { DisputesApi, PayPalDispute } from "../paypal/disputes.js";
import { addDisputeEvidence, getAgentKey, getAgentPause, getProductCheck, getRevocation, getUserKey, listAgentEvents, listControlEvents, listDisputeEvidence, recordAgentEvent, saveProductCheck, toIso, type DeliveryEvidence } from "../repo.js";
import { productFindings, type ProductCheck } from "../integrations/channel3.js";
import { caseSummary, summarizePrecedents, type Precedent, type PrecedentSummary, type RetrievalMode } from "../integrations/elastic.js";

export interface Deps {
  db: Db;
  disputes: DisputesApi;
  llm?: LlmClient;
  now?: () => Date;
  onAgentEvent?: (eventId: number) => Promise<void>;
  onProposal?: (disputeId: number, message: string, data: unknown) => Promise<void>;
  /** Channel3 enrichment: what is this product, really? Absent when Channel3 is not configured. */
  verifyProduct?: (productId: string, claim: { declaredCategory?: string; allowedCategories?: string[]; amountCents: number; currency: string }) => Promise<ProductCheck>;
  /** Elastic retrieval: similar past cases. Advisory only. Absent when Elastic is not configured. */
  findPrecedents?: (queryText: string, excludeDisputeId?: number) => Promise<{ mode: RetrievalMode; cases: Precedent[] } | undefined>;
  /** Called after a dispute is created or changes, so an external index can follow. Failures are logged, never block the workflow. */
  onDisputeChanged?: (disputeId: number) => Promise<void>;
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
  /** Channel3's independent view of what was bought. Only a confirmed out-of-mandate category changes the decision. */
  productCheck?: ProductCheck;
  /** Similar past cases from Elastic. Shown to the merchant; never changes the action. */
  precedents?: { mode: RetrievalMode; cases: Precedent[]; summary: PrecedentSummary };
  /** Delivery proof received after the dispute opened. */
  deliveryProof?: DeliveryEvidence[];
  /** What would let Warrant respond automatically. Drives the evidence request sent to Zapier. */
  missingEvidence?: string[];
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

type Trace = (toolName: string, input: unknown, output: unknown, eventType?: string, status?: string) => number;

function makeTrace(deps: Deps, runId: string, disputeId?: number): Trace {
  return (toolName, input, output, eventType = "tool_call", status) => {
    const eventId = recordAgentEvent(deps.db, { runId, agentType: "merchant-dispute", disputeId, eventType, toolName, input, output, status });
    if (deps.onAgentEvent) {
      void deps.onAgentEvent(eventId).catch(err => console.error(`agent event ${eventId} integration failed`, err));
    }
    return eventId;
  };
}

const notifyChanged = (deps: Deps, id: number) => {
  if (deps.onDisputeChanged) void deps.onDisputeChanged(id).catch(err => console.error(`dispute ${id} change hook failed`, err));
};

interface Computed { orderId: number | null; proposal: Proposal; pack?: ReturnType<typeof buildEvidencePack> }

/**
 * Everything that turns a PayPal dispute into a proposal, with no writes to the disputes table. Used for the first
 * proposal and again when new evidence arrives. `existingDisputeId` is set on a re-run so earlier evidence is included.
 */
async function computeProposal(deps: Deps, d: PayPalDispute, trace: Trace, existingDisputeId?: number): Promise<Computed> {
  const { db } = deps;
  const reason = d.reason ?? "UNKNOWN";
  const captureId = d.disputed_transactions?.[0]?.seller_transaction_id;
  const order: any = captureId ? db.prepare("SELECT * FROM orders WHERE paypal_capture_id = ?").get(captureId) : undefined;
  trace("match_order", { captureId }, { matched: Boolean(order), orderId: order?.id ?? null });

  const escalate = (why: string, orderId: number | null): Computed => ({
    orderId,
    proposal: {
      decision: { action: "escalate_to_human", reason: why }, findings: [], signatureValid: false,
      explanation: `${why} Warrant cannot respond automatically, so this needs your review in PayPal.`,
      evidenceNote: "", narrativeSource: "template",
    },
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
  const mandateFindings = checkPurchase(mandate, purchase, {
    revokedAt: revocation?.revokedAt ?? null, revokedReason: revocation?.reason, agentPaused: pause.paused ? pause : null,
  });
  trace("check_purchase", { amountCents: purchase.amountCents, currency: purchase.currency }, { findings: mandateFindings.map(f => f.code) });

  // Channel3: what was actually bought? The snapshot taken at checkout wins; otherwise look it up now.
  let productCheck = getProductCheck(db, order.id);
  const productId = signedCart?.cart.productId;
  if (!productCheck && productId && deps.verifyProduct) {
    productCheck = await deps.verifyProduct(productId, {
      declaredCategory: purchase.category, allowedCategories: mandate.allowedCategories, amountCents: purchase.amountCents, currency: purchase.currency,
    });
    if (productCheck.lookup !== "unavailable") saveProductCheck(db, order.id, productCheck);
  }
  if (productCheck) {
    trace("verify_product", { productId: productCheck.productId, declaredCategory: purchase.category },
      { lookup: productCheck.lookup, verdict: productCheck.categoryVerdict, observedCategory: productCheck.observedCategory ?? null,
        paidWithinListedRange: productCheck.paidWithinListedRange ?? null });
  }
  const findings = [...mandateFindings, ...productFindings(productCheck)];

  const userControls = listControlEvents(db, mandate.userId, mandate.id);
  trace("check_user_controls", { userId: mandate.userId, mandateId: mandate.id }, {
    events: userControls.map(e => ({ action: e.action, appliedAt: e.appliedAt, via: e.via })),
    revokedBeforePurchase: findings.some(f => f.code === "MANDATE_REVOKED"), pausedAtPurchase: findings.some(f => f.code === "AGENT_PAUSED"),
  });

  // Evidence that arrived after the dispute opened (Zapier). Only delivery proof exists so far.
  const deliveryProof = existingDisputeId ? listDisputeEvidence(db, existingDisputeId).filter(e => e.kind === "delivery").map(e => e.payload) : [];
  const hasDeliveryProof = deliveryProof.length > 0;
  if (existingDisputeId) trace("collect_evidence", { disputeId: existingDisputeId }, { deliveryProofCount: deliveryProof.length });

  const decision = decideDisputeResponse({
    reason, orderAmountCents: order.amount_cents, signatureValid, findings, hasDeliveryProof, currency: purchase.currency,
  });

  // Elastic: similar past cases. Advisory; a failure here never affects the decision.
  let precedents: Proposal["precedents"];
  if (deps.findPrecedents) {
    const queryText = caseSummary({ reason, action: decision.action, findingCodes: findings.map(f => f.code), category: purchase.category,
      productTitle: productCheck?.title, productVerdict: productCheck?.categoryVerdict, hasDeliveryProof });
    try {
      const r = await deps.findPrecedents(queryText, existingDisputeId);
      if (r) {
        precedents = { mode: r.mode, cases: r.cases, summary: summarizePrecedents(r.cases) };
        trace("search_precedents", { query: queryText }, { mode: r.mode, total: r.cases.length, summary: precedents.summary.text });
      }
    } catch (err) {
      trace("search_precedents", { query: queryText }, { error: (err as Error).message.slice(0, 300) }, "observation", "failed");
    }
  }

  const generatedAt = (deps.now?.() ?? new Date()).toISOString();
  const pack = buildEvidencePack({
    disputeId: d.dispute_id, paypalOrderId: order.paypal_order_id ?? "", signed, signatureValid,
    purchase, findings, decision, generatedAt, signedCart, authorization, productCheck, deliveryProof,
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
    hasDeliveryProof,
    deliveredAt: deliveryProof[0]?.deliveredAt,
    product: productCheck?.lookup === "found" ? {
      productTitle: productCheck.title?.slice(0, 80), brand: productCheck.brand, categoryVerdict: productCheck.categoryVerdict,
      listedFrom: productCheck.marketLowCents !== undefined ? money(productCheck.marketLowCents) : undefined,
      listedTo: productCheck.marketHighCents !== undefined ? money(productCheck.marketHighCents) : undefined,
    } : undefined,
    similarPastCases: precedents ? { total: precedents.summary.total, merchantDismissed: precedents.summary.dismissedByMerchant } : undefined,
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
        ...(productCheck ? [`Product verification (Channel3): ${productCheck.note}`] : []),
        ...(deliveryProof.length ? [`Delivery proof: ${deliveryProof.map(x => `${x.carrier} ${x.trackingNumber}, delivered ${x.deliveredAt}`).join("; ")}.`] : []),
        ``,
        narrative.evidenceNote,
      ].join("\n")
    : narrative.evidenceNote;

  const blockedReason = blockedReasonFor(decision, d.links, purchase.currency);
  const missingEvidence = decision.action === "escalate_to_human" && !hasDeliveryProof ? ["delivery proof"] : [];
  trace("identify_missing_evidence", { reason, hasDeliveryProof }, { missing: missingEvidence }, "observation");
  // Code-written, so the AI cannot soften or contradict it.
  const explanation = blockedReason ? `${narrative.explanation} ${blockedReason}` : narrative.explanation;

  return {
    orderId: order.id, pack,
    proposal: {
      decision, findings, signatureValid, authorization, explanation, evidenceNote, blockedReason,
      narrativeSource: narrative.source, narrativeFallbackReason: narrative.fallbackReason, purchase,
      mandate: { id: mandate.id, description: mandate.description, maxAmountCents: mandate.maxAmountCents, currency: mandate.currency, expiresAt: mandate.expiresAt },
      productCheck, precedents, deliveryProof: deliveryProof.length ? deliveryProof : undefined, missingEvidence,
    },
  };
}

/**
 * Turns a PayPal dispute into a stored PROPOSAL. Nothing is sent to PayPal here.
 * Safe to call twice for the same dispute (webhook retries): the second call returns the first result.
 */
export async function processDispute(deps: Deps, paypalDisputeId: string): Promise<DisputeRecord> {
  const { db } = deps;
  const runId = `dispute-${paypalDisputeId}`;
  const trace = makeTrace(deps, runId);
  const existing = db.prepare("SELECT * FROM disputes WHERE paypal_dispute_id = ?").get(paypalDisputeId);
  if (existing) return toRecord(db, existing);

  trace("observe_dispute", { paypalDisputeId }, { status: "received" }, "observation");
  const d = await deps.disputes.get(paypalDisputeId);
  trace("get_dispute", { paypalDisputeId }, { reason: d.reason, status: d.status, links: d.links?.map(l => l.rel) ?? [] });
  const reason = d.reason ?? "UNKNOWN";
  const built = await computeProposal(deps, d, trace);
  const order: any = built.orderId ? db.prepare("SELECT amount_cents FROM orders WHERE id = ?").get(built.orderId) : undefined;
  const disputeCents = d.dispute_amount ? toCents(d.dispute_amount.value) : (order?.amount_cents ?? null);
  const p = built.proposal;

  const r = db.prepare(`INSERT INTO disputes (paypal_dispute_id, order_id, reason, status, amount_cents, decision_json)
                        VALUES (?, ?, ?, ?, ?, ?)`)
    .run(d.dispute_id, built.orderId, reason, d.status ?? null, disputeCents, JSON.stringify(p));
  const id = Number(r.lastInsertRowid);
  db.prepare("UPDATE agent_events SET dispute_id = ? WHERE run_id = ? AND dispute_id IS NULL").run(id, runId);
  trace("recommend_response", { reason, orderId: built.orderId }, { action: p.decision.action, reason: p.decision.reason }, "recommendation");
  db.prepare("UPDATE agent_events SET dispute_id = ? WHERE run_id = ? AND dispute_id IS NULL").run(id, runId);
  if (built.pack) db.prepare("INSERT INTO evidence_packs (dispute_id, pack_json) VALUES (?, ?)").run(id, JSON.stringify(built.pack.json));
  if (deps.onProposal) {
    void deps.onProposal(id, `New proposal: ${p.decision.action}`, { action: p.decision.action, reason, missing: p.missingEvidence ?? [] })
      .catch(err => console.error(`proposal notification for dispute ${id} failed`, err));
  }
  notifyChanged(deps, id);
  return toRecord(db, db.prepare("SELECT * FROM disputes WHERE id = ?").get(id));
}

/** Re-runs the proposal for a dispute that has not been submitted yet, for example after new evidence arrived. */
export async function refreshProposal(deps: Deps, id: number): Promise<DisputeRecord> {
  const { db } = deps;
  const row: any = db.prepare("SELECT * FROM disputes WHERE id = ?").get(id);
  if (!row) throw new ServiceError(404, "Dispute not found.");
  if (!["PROPOSED", "FAILED"].includes(row.workflow_state)) throw new ServiceError(409, `Dispute is already ${String(row.workflow_state).toLowerCase()}.`);
  const trace = makeTrace(deps, `dispute-${row.paypal_dispute_id}-refresh-${(deps.now?.() ?? new Date()).getTime()}`, id);
  trace("observe_new_evidence", { disputeId: id }, { status: "received" }, "observation");
  const d = await deps.disputes.get(row.paypal_dispute_id);
  const built = await computeProposal(deps, d, trace, id);
  const p = built.proposal;
  db.prepare("UPDATE disputes SET decision_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(p), id);
  if (built.pack) {
    const changed = db.prepare("UPDATE evidence_packs SET pack_json = ? WHERE dispute_id = ? AND submitted_at IS NULL").run(JSON.stringify(built.pack.json), id);
    if (Number(changed.changes) === 0) db.prepare("INSERT INTO evidence_packs (dispute_id, pack_json) VALUES (?, ?)").run(id, JSON.stringify(built.pack.json));
  }
  trace("recommend_response", { reason: row.reason }, { action: p.decision.action, reason: p.decision.reason }, "recommendation");
  if (deps.onProposal) {
    void deps.onProposal(id, `Proposal updated: ${p.decision.action}`, { action: p.decision.action, reason: row.reason, missing: p.missingEvidence ?? [], updated: true })
      .catch(err => console.error(`proposal notification for dispute ${id} failed`, err));
  }
  notifyChanged(deps, id);
  return getDispute(db, id);
}

const CARRIER = /^[A-Za-z0-9 .&-]{1,40}$/;
const TRACKING = /^[A-Za-z0-9-]{4,60}$/;

/**
 * Accepts delivery proof for an open dispute (typically pushed by a Zapier Zap that looked up the carrier), then re-runs
 * the proposal. Fields are validated strictly because this is third-party data that ends up in a note sent to PayPal.
 */
export async function addDeliveryEvidence(deps: Deps, id: number, input: unknown, source: "zapier" | "admin"): Promise<DisputeRecord> {
  const { db } = deps;
  const i = (input ?? {}) as Record<string, unknown>;
  const carrier = typeof i.carrier === "string" ? i.carrier.trim() : "";
  const trackingNumber = typeof i.trackingNumber === "string" ? i.trackingNumber.trim() : "";
  const deliveredMs = typeof i.deliveredAt === "string" ? Date.parse(i.deliveredAt) : NaN;
  if (!CARRIER.test(carrier)) throw new ServiceError(400, "carrier must be 1-40 letters, digits, spaces, dots, ampersands or hyphens.");
  if (!TRACKING.test(trackingNumber)) throw new ServiceError(400, "trackingNumber must be 4-60 letters, digits or hyphens.");
  if (!Number.isFinite(deliveredMs)) throw new ServiceError(400, "deliveredAt must be an ISO 8601 date.");
  if (deliveredMs > (deps.now?.() ?? new Date()).getTime() + 5 * 60_000) throw new ServiceError(400, "deliveredAt cannot be in the future.");
  const rec = getDispute(db, id);
  if (!["PROPOSED", "FAILED"].includes(rec.workflowState)) throw new ServiceError(409, `Dispute is already ${rec.workflowState.toLowerCase()}.`);
  addDisputeEvidence(db, id, "delivery", source, { carrier, trackingNumber, deliveredAt: new Date(deliveredMs).toISOString() });
  return refreshProposal(deps, id);
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
  notifyChanged(deps, id);
  return getDispute(db, id);
}

export function rejectDispute(db: Db, id: number, onChanged?: (id: number) => void): DisputeRecord {
  const r = db.prepare(
    "UPDATE disputes SET workflow_state = 'REJECTED', updated_at = datetime('now') WHERE id = ? AND workflow_state IN ('PROPOSED','FAILED')",
  ).run(id);
  if (Number(r.changes) !== 1) {
    const rec = getDispute(db, id); // throws 404 if missing
    throw new ServiceError(409, `Dispute is already ${rec.workflowState.toLowerCase()}.`);
  }
  onChanged?.(id);
  return getDispute(db, id);
}