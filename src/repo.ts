import { createHash } from "node:crypto";
import type { Db } from "./db/index.js";
import type { Finding, Mandate, SignedCart, SignedMandate } from "./mandate/types.js";
import { checkCumulative } from "./mandate/check.js";
import type { ControlAction } from "./mandate/control.js";
import type { ProductCheck } from "./integrations/channel3.js";

/** SQLite's datetime('now') has no zone marker; Date.parse would read it as local time. */
export function toIso(s: string): string {
  return /(Z|[+-]\d\d:\d\d)$/i.test(s) ? s : `${s.replace(" ", "T")}Z`;
}

/**
 * `ownerUserId` is recorded only when the agent is first created; replacing a key never changes the owner.
 * Leave it out for merchant-admin registrations (the agent is then admin-owned).
 */
export function registerAgentKey(db: Db, agentId: string, publicKeyPem: string, ownerUserId?: string) {
  db.prepare("INSERT INTO agent_keys (agent_id, public_key_pem, owner_user_id) VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET public_key_pem = excluded.public_key_pem")
    .run(agentId, publicKeyPem, ownerUserId ?? null);
}

/** The user who registered the agent, or null if the merchant admin did. */
export function getAgentOwner(db: Db, agentId: string): string | null {
  return (db.prepare("SELECT owner_user_id FROM agent_keys WHERE agent_id = ?").get(agentId) as { owner_user_id: string | null } | undefined)?.owner_user_id ?? null;
}

const fingerprint = (pem: string) => createHash("sha256").update(pem).digest("hex");

export function recordKeyChange(db: Db, e: { kind: "user" | "agent"; subjectId: string; actor: string; oldKeyPem?: string; newKeyPem: string }) {
  db.prepare("INSERT INTO key_changes (kind, subject_id, actor, action, old_key_sha256, new_key_sha256) VALUES (?, ?, ?, ?, ?, ?)")
    .run(e.kind, e.subjectId, e.actor, e.oldKeyPem ? "replaced" : "registered", e.oldKeyPem ? fingerprint(e.oldKeyPem) : null, fingerprint(e.newKeyPem));
}

export function registerUserKey(db: Db, userId: string, publicKeyPem: string) {
  db.prepare("INSERT INTO user_keys (user_id, public_key_pem) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET public_key_pem = excluded.public_key_pem")
    .run(userId, publicKeyPem);
}

export function getUserKey(db: Db, userId: string): string | undefined {
  return (db.prepare("SELECT public_key_pem FROM user_keys WHERE user_id = ?").get(userId) as { public_key_pem: string } | undefined)?.public_key_pem;
}

/** The user must already have a registered key (foreign key). */
export function linkPaymentToken(db: Db, userId: string, tokenId: string, paypalCustomerId?: string, expiresAt?: string) {
  // Linking (or re-linking) makes the authorization ACTIVE again.
  db.prepare(`INSERT INTO payment_tokens (user_id, token_id, paypal_customer_id, expires_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET token_id = excluded.token_id, paypal_customer_id = excluded.paypal_customer_id,
                expires_at = excluded.expires_at, status = 'ACTIVE', linked_at = datetime('now')`)
    .run(userId, tokenId, paypalCustomerId ?? null, expiresAt ?? null);
}

export interface PaymentAuthorization { tokenId: string; status: string; expiresAt: string | null }

export function getPaymentAuthorization(db: Db, userId: string): PaymentAuthorization | undefined {
  const r = db.prepare("SELECT token_id, status, expires_at FROM payment_tokens WHERE user_id = ?").get(userId) as
    { token_id: string; status: string; expires_at: string | null } | undefined;
  return r ? { tokenId: r.token_id, status: r.status, expiresAt: r.expires_at } : undefined;
}

export function revokePaymentAuthorization(db: Db, userId: string) {
  db.prepare("UPDATE payment_tokens SET status = 'REVOKED' WHERE user_id = ?").run(userId);
}

export function getPaymentToken(db: Db, userId: string): string | undefined {
  return (db.prepare("SELECT token_id FROM payment_tokens WHERE user_id = ?").get(userId) as { token_id: string } | undefined)?.token_id;
}

export function cartAlreadyUsed(db: Db, cartId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM orders WHERE cart_id = ?").get(cartId));
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
  currency: string; category?: string; findings: Finding[]; at?: string; captureId?: string; signedCart?: SignedCart;
}): number {
  const r = db.prepare(`INSERT INTO orders (paypal_order_id, mandate_id, merchant_id, amount_cents, currency, category,
                          paypal_capture_id, mandate_findings_json, created_at, cart_id, cart_json)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(o.paypalOrderId, o.mandateId, o.merchantId, o.amountCents, o.currency, o.category ?? null,
         o.captureId ?? null, JSON.stringify(o.findings), o.at ?? new Date().toISOString(),
         o.signedCart?.cart.cartId ?? null, o.signedCart ? JSON.stringify(o.signedCart) : null);
  return Number(r.lastInsertRowid);
}

// ---- Product checks (Channel3 enrichment) ------------------------------------------------------------------------

export function saveProductCheck(db: Db, orderId: number, check: ProductCheck): void {
  db.prepare(`INSERT INTO product_checks (order_id, product_id, check_json) VALUES (?, ?, ?)
              ON CONFLICT(order_id) DO UPDATE SET product_id = excluded.product_id, check_json = excluded.check_json, checked_at = datetime('now')`)
    .run(orderId, check.productId, JSON.stringify(check));
}

export function getProductCheck(db: Db, orderId: number): ProductCheck | undefined {
  const row = db.prepare("SELECT check_json FROM product_checks WHERE order_id = ?").get(orderId) as { check_json: string } | undefined;
  return row ? JSON.parse(row.check_json) as ProductCheck : undefined;
}

// ---- Evidence supplied after a dispute opens ------------------------------------------------------------------------

export interface DeliveryEvidence { carrier: string; trackingNumber: string; deliveredAt: string }
export interface EvidenceRow { id: number; disputeId: number; kind: string; source: string; payload: DeliveryEvidence; createdAt: string }

export function addDisputeEvidence(db: Db, disputeId: number, kind: "delivery", source: "zapier" | "admin", payload: DeliveryEvidence): number {
  const r = db.prepare("INSERT INTO dispute_evidence (dispute_id, kind, source, payload_json) VALUES (?, ?, ?, ?)")
    .run(disputeId, kind, source, JSON.stringify(payload));
  return Number(r.lastInsertRowid);
}

export function listDisputeEvidence(db: Db, disputeId: number): EvidenceRow[] {
  return (db.prepare("SELECT * FROM dispute_evidence WHERE dispute_id = ? ORDER BY id").all(disputeId) as any[]).map(r => ({
    id: r.id, disputeId: r.dispute_id, kind: r.kind, source: r.source, payload: JSON.parse(r.payload_json), createdAt: r.created_at,
  }));
}

export function markCaptured(db: Db, paypalOrderId: string, captureId: string) {
  db.prepare("UPDATE orders SET paypal_capture_id = ?, status = 'CAPTURED' WHERE paypal_order_id = ?").run(captureId, paypalOrderId);
}

export function listUserOrders(db: Db, userId: string) {
  return (db.prepare(`SELECT o.id, o.paypal_order_id, o.mandate_id, o.merchant_id, o.amount_cents,
                             o.currency, o.category, o.status, o.paypal_capture_id, o.created_at
                      FROM orders o
                      JOIN mandates m ON m.id = o.mandate_id
                      WHERE m.user_id = ?
                      ORDER BY o.created_at DESC`).all(userId) as any[]).map(row => ({
    id: row.id,
    paypalOrderId: row.paypal_order_id,
    mandateId: row.mandate_id,
    merchantId: row.merchant_id,
    amountCents: row.amount_cents,
    currency: row.currency,
    category: row.category,
    status: row.status,
    captureId: row.paypal_capture_id,
    createdAt: toIso(row.created_at),
  }));
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

export function getAgentEvent(db: Db, id: number): AgentEvent {
  const row = db.prepare("SELECT * FROM agent_events WHERE id = ?").get(id) as any;
  if (!row) throw new Error(`Agent event ${id} was not found.`);
  return {
    id: row.id, runId: row.run_id, agentType: row.agent_type, disputeId: row.dispute_id,
    eventType: row.event_type, toolName: row.tool_name, input: JSON.parse(row.input_json),
    output: JSON.parse(row.output_json), status: row.status, createdAt: row.created_at,
  };
}

// ---- Mandate usage: reserve before charging, confirm or release after -------------------------------------

export type UseStatus = "RESERVED" | "CAPTURED" | "UNKNOWN" | "RELEASED";
export interface MandateUseRow {
  cartId: string; mandateId: string; amountCents: number; status: UseStatus;
  orderId: number | null; paypalOrderId: string | null; captureId: string | null; detail: string | null;
  reservedAt: string; updatedAt: string;
}
const useRow = (r: any): MandateUseRow => ({
  cartId: r.cart_id, mandateId: r.mandate_id, amountCents: r.amount_cents, status: r.status, orderId: r.order_id,
  paypalOrderId: r.paypal_order_id, captureId: r.capture_id, detail: r.detail, reservedAt: toIso(r.reserved_at), updatedAt: toIso(r.updated_at),
});

export function getMandateUsage(db: Db, mandateId: string, excludeCartId?: string) {
  const r = db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS spent, COUNT(*) AS n FROM mandate_uses
                        WHERE mandate_id = ? AND status IN ('RESERVED','CAPTURED','UNKNOWN') AND cart_id IS NOT ?`)
    .get(mandateId, excludeCartId ?? null) as { spent: number; n: number };
  return { spentAmountCents: Number(r.spent), purchaseCount: Number(r.n) };
}

export type Reservation =
  | { ok: true; resumed: boolean }
  | { ok: false; reason: "ALREADY_CAPTURED" }
  | { ok: false; reason: "LIMIT"; findings: Finding[] };

/**
 * Atomically checks the cumulative limits and holds budget for one cart. The read and the write happen inside one
 * IMMEDIATE transaction, so two requests (even from two processes) cannot both pass the same limit.
 * Re-reserving a cart whose earlier attempt is RESERVED or UNKNOWN is allowed: the caller then repeats the charge with
 * the same PayPal idempotency key, which returns the original result instead of charging again.
 * Autonomous mandates are single-use unless the user-signed mandate sets maxPurchases.
 */
export function reserveMandateUse(db: Db, m: Mandate, cartId: string, amountCents: number): Reservation {
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT status FROM mandate_uses WHERE cart_id = ?").get(cartId) as { status: UseStatus } | undefined;
    if (existing?.status === "CAPTURED") { db.exec("COMMIT"); return { ok: false, reason: "ALREADY_CAPTURED" }; }
    const findings = checkCumulative(m, amountCents, getMandateUsage(db, m.id, cartId), 1);
    if (findings.length) { db.exec("COMMIT"); return { ok: false, reason: "LIMIT", findings }; }
    if (existing) {
      db.prepare("UPDATE mandate_uses SET status = 'RESERVED', amount_cents = ?, detail = NULL, updated_at = datetime('now') WHERE cart_id = ?").run(amountCents, cartId);
    } else {
      db.prepare("INSERT INTO mandate_uses (cart_id, mandate_id, amount_cents, status) VALUES (?, ?, ?, 'RESERVED')").run(cartId, m.id, amountCents);
    }
    db.exec("COMMIT");
    return { ok: true, resumed: existing !== undefined && existing.status !== "RELEASED" };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
}

export function markMandateUse(db: Db, cartId: string, status: UseStatus, f: { orderId?: number; paypalOrderId?: string; captureId?: string; detail?: string } = {}) {
  db.prepare(`UPDATE mandate_uses SET status = ?, order_id = COALESCE(?, order_id), paypal_order_id = COALESCE(?, paypal_order_id),
              capture_id = COALESCE(?, capture_id), detail = COALESCE(?, detail), updated_at = datetime('now') WHERE cart_id = ?`)
    .run(status, f.orderId ?? null, f.paypalOrderId ?? null, f.captureId ?? null, f.detail ?? null, cartId);
}

export function listMandateUses(db: Db, status?: UseStatus): MandateUseRow[] {
  const rows = status
    ? db.prepare("SELECT * FROM mandate_uses WHERE status = ? ORDER BY reserved_at").all(status)
    : db.prepare("SELECT * FROM mandate_uses ORDER BY reserved_at").all();
  return (rows as any[]).map(useRow);
}

// ---- Checkout holds: an autonomous purchase over requireApprovalAboveCents, awaiting the user's decision ----

export type HoldStatus = "PENDING" | "APPROVED" | "DECLINED" | "EXPIRED";
export interface CheckoutHoldRow {
  cartId: string; mandateId: string; userId: string; amountCents: number; currency: string;
  checkout: unknown; status: HoldStatus; expiresAt: string; createdAt: string; updatedAt: string;
}
const holdRow = (r: any): CheckoutHoldRow => ({
  cartId: r.cart_id, mandateId: r.mandate_id, userId: r.user_id, amountCents: r.amount_cents, currency: r.currency,
  checkout: JSON.parse(r.checkout_json), status: r.status,
  expiresAt: toIso(r.expires_at), createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at),
});

/**
 * Creates a hold, or re-arms one left DECLINED or EXPIRED by an earlier attempt at the same cart id (an APPROVED
 * hold, meaning the purchase already went through, is never overwritten).
 */
export function createCheckoutHold(db: Db, h: {
  cartId: string; mandateId: string; userId: string; amountCents: number; currency: string; checkout: unknown; expiresAt: string;
}) {
  db.prepare(`INSERT INTO checkout_holds (cart_id, mandate_id, user_id, amount_cents, currency, checkout_json, expires_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(cart_id) DO UPDATE SET
                status = 'PENDING', amount_cents = excluded.amount_cents, currency = excluded.currency,
                checkout_json = excluded.checkout_json, expires_at = excluded.expires_at, updated_at = datetime('now')
              WHERE checkout_holds.status IN ('DECLINED', 'EXPIRED')`)
    .run(h.cartId, h.mandateId, h.userId, h.amountCents, h.currency, JSON.stringify(h.checkout), h.expiresAt);
}

export function getCheckoutHold(db: Db, cartId: string): CheckoutHoldRow | undefined {
  const row = db.prepare("SELECT * FROM checkout_holds WHERE cart_id = ?").get(cartId) as any;
  return row ? holdRow(row) : undefined;
}

/** Only moves a hold out of PENDING. Returns false if it was already resolved (by a concurrent request, or earlier). */
export function resolveCheckoutHold(db: Db, cartId: string, status: "APPROVED" | "DECLINED" | "EXPIRED"): boolean {
  const r = db.prepare("UPDATE checkout_holds SET status = ?, updated_at = datetime('now') WHERE cart_id = ? AND status = 'PENDING'").run(status, cartId);
  return Number(r.changes) > 0;
}

/**
 * Moves a hold back from APPROVED to PENDING after a charge attempt that did not actually complete (PayPal
 * refused it, or its outcome is unknown) — so it can be approved (safely retried, same idempotency key) or
 * declined again, instead of being stuck "approved" forever with nothing charged.
 */
export function reopenCheckoutHold(db: Db, cartId: string): boolean {
  const r = db.prepare("UPDATE checkout_holds SET status = 'PENDING', updated_at = datetime('now') WHERE cart_id = ? AND status = 'APPROVED'").run(cartId);
  return Number(r.changes) > 0;
}

export function listCheckoutHolds(db: Db, userId: string, status: HoldStatus = "PENDING"): CheckoutHoldRow[] {
  return (db.prepare("SELECT * FROM checkout_holds WHERE user_id = ? AND status = ? ORDER BY created_at").all(userId, status) as any[]).map(holdRow);
}

// ---- User controls: revocation and pause ------------------------------------------------------------------

export interface ControlEvent {
  id: number; userId: string; action: ControlAction; subjectId: string; reason: string | null;
  issuedAt: string; appliedAt: string; via: "user_signature" | "admin"; nonce: string;
}
const controlRow = (r: any): ControlEvent => ({
  id: r.id, userId: r.user_id, action: r.action, subjectId: r.subject_id, reason: r.reason,
  issuedAt: r.issued_at, appliedAt: r.applied_at, via: r.via, nonce: r.nonce,
});

/** Appends to the audit log. Returns undefined when the nonce was already used (a replayed request). */
export function recordControlEvent(db: Db, e: {
  userId: string; action: ControlAction; subjectId: string; reason?: string; issuedAt: string; nonce: string;
  via: "user_signature" | "admin"; appliedAt?: string;
}): ControlEvent | undefined {
  try {
    const r = db.prepare(`INSERT INTO control_events (user_id, action, subject_id, reason, issued_at, applied_at, via, nonce)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.userId, e.action, e.subjectId, e.reason ?? null, e.issuedAt, e.appliedAt ?? new Date().toISOString(), e.via, e.nonce);
    return controlRow(db.prepare("SELECT * FROM control_events WHERE id = ?").get(Number(r.lastInsertRowid)));
  } catch (err) {
    if (/UNIQUE/i.test((err as Error).message)) return undefined;
    throw err;
  }
}

/**
 * When the user revoked this mandate, if they did. Only a revocation by the mandate's own user counts, so nobody can
 * pre-revoke someone else's mandate id. Also honours the older `mandates.revoked_at` column.
 */
export function getRevocation(db: Db, mandateId: string, userId: string): { revokedAt: string; reason?: string } | undefined {
  const ev = db.prepare("SELECT applied_at, reason FROM control_events WHERE action = 'revoke_mandate' AND subject_id = ? AND user_id = ? ORDER BY id LIMIT 1")
    .get(mandateId, userId) as { applied_at: string; reason: string | null } | undefined;
  const legacy = (db.prepare("SELECT revoked_at FROM mandates WHERE id = ?").get(mandateId) as { revoked_at: string | null } | undefined)?.revoked_at;
  const a = ev ? { revokedAt: ev.applied_at, reason: ev.reason ?? undefined } : undefined;
  const b = legacy ? { revokedAt: toIso(legacy) } : undefined;
  if (a && b) return Date.parse(a.revokedAt) <= Date.parse(b.revokedAt) ? a : b;
  return a ?? b;
}

/** Whether the user's agent was paused at `at` (default: now), from the last pause/resume before that moment. */
export function getAgentPause(db: Db, userId: string, at: string = new Date().toISOString()): { paused: boolean; reason?: string; since?: string } {
  const cutoff = Date.parse(at);
  const events = (db.prepare("SELECT * FROM control_events WHERE user_id = ? AND action IN ('pause_agent','resume_agent') ORDER BY id").all(userId) as any[])
    .map(controlRow).filter(e => Date.parse(e.appliedAt) <= cutoff);
  const last = events[events.length - 1];
  return last?.action === "pause_agent" ? { paused: true, reason: last.reason ?? undefined, since: last.appliedAt } : { paused: false };
}

/** Everything the user did to limit their agent that bears on one mandate. Chronological. */
export function listControlEvents(db: Db, userId: string, mandateId?: string): ControlEvent[] {
  return (db.prepare(`SELECT * FROM control_events WHERE user_id = ? AND (action != 'revoke_mandate' OR subject_id = ?) ORDER BY id`)
    .all(userId, mandateId ?? "") as any[]).map(controlRow);
}
