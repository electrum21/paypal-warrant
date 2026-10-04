import express, { type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { verifyWebhook } from "../paypal/webhooks.js";
import { captureOrder, createOrder } from "../paypal/client.js";
import { paypalDisputes, type DisputesApi } from "../paypal/disputes.js";
import { anthropicClient, geminiClient, type LlmClient } from "../ai/draft.js";
import { approveDispute, getDispute, listDisputes, processDispute, rejectDispute, ServiceError, type Deps } from "../disputes/service.js";
import { Mandate, type Purchase } from "../mandate/types.js";
import { checkPurchase } from "../mandate/check.js";
import { verifyMandate } from "../mandate/sign.js";
import { getAgentKey, markCaptured, recordOrder, registerAgentKey, saveMandate, toIso } from "../repo.js";
import { adminPageHtml } from "./adminPage.js";

const CheckoutBody = z.object({
  signedMandate: z.object({ mandate: Mandate, mandateHash: z.string(), signature: z.string() }),
  purchase: z.object({
    amountCents: z.number().int().positive(),
    currency: z.string().length(3).optional(),
    category: z.string().optional(),
    description: z.string().max(127).optional(),
  }),
});

export function createApp(cfg: Config, db: Db, inject: { disputes?: DisputesApi; llm?: LlmClient } = {}) {
  const deps: Deps = {
    db,
    disputes: inject.disputes ?? paypalDisputes(cfg),
    llm: inject.llm ?? (cfg.GEMINI_API_KEY ? geminiClient(cfg.GEMINI_API_KEY, cfg.GEMINI_MODEL)
        : cfg.ANTHROPIC_API_KEY ? anthropicClient(cfg.ANTHROPIC_API_KEY, cfg.ANTHROPIC_MODEL) : undefined),
  };
  const app = express();

  /** Express 4 does not catch async errors; this turns them (and ServiceErrors) into JSON responses. */
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
    fn(req, res).catch(err => {
      if (err instanceof ServiceError) return res.status(err.status).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: (err as Error).message });
    });
  };

  // Approving a dispute response moves money, so every merchant route needs the admin token.
  const adminAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!cfg.ADMIN_TOKEN) return res.status(503).json({ error: "Set ADMIN_TOKEN in .env to use the approval screen." });
    const given = Buffer.from(String(req.header("x-admin-token") ?? req.query.token ?? ""));
    const want = Buffer.from(cfg.ADMIN_TOKEN);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return res.status(401).json({ error: "Invalid admin token." });
    next();
  };

  app.get("/health", (_req, res) => {
    res.json({ ok: true, webhookVerification: Boolean(cfg.PAYPAL_WEBHOOK_ID), llm: Boolean(deps.llm), admin: Boolean(cfg.ADMIN_TOKEN) });
  });

  // PayPal sends the buyer here after approval (?token=<order id>). We capture the payment.
  app.get("/paypal/return", async (req, res) => {
    const orderId = String(req.query.token ?? "");
    if (!orderId) return res.status(400).type("text/plain").send("Missing order token.");
    try {
      const cap = await captureOrder(cfg, orderId);
      const c = cap.purchase_units?.[0]?.payments?.captures?.[0];
      if (c?.id) markCaptured(db, cap.id, c.id);
      console.log(`captured order ${cap.id}: ${cap.status}, capture ${c?.id}`);
      res.type("text/plain").send(
        `Order ${cap.id}: ${cap.status}\nCapture ID: ${c?.id}\nAmount: ${c?.amount.value} ${c?.amount.currency_code}\n\nYou can close this tab.`,
      );
    } catch (err) {
      console.error("capture failed", err);
      res.status(500).type("text/plain").send(`Capture failed:\n${(err as Error).message}`);
    }
  });
  app.get("/paypal/cancel", (_req, res) => res.type("text/plain").send("Payment cancelled."));

  // Raw body so we log exactly what PayPal sent.
  app.post("/webhooks/paypal", express.raw({ type: "*/*" }), async (req, res) => {
    let event: { id?: string; event_type?: string; resource?: { dispute_id?: string } };
    try {
      event = JSON.parse((req.body as Buffer).toString("utf8"));
    } catch {
      return res.status(400).json({ error: "invalid json" });
    }
    let verified = false;
    try {
      verified = await verifyWebhook(cfg, req.headers, event);
    } catch (err) {
      console.error("webhook verification error", err);
    }
    // Store everything (verified flag recorded) so we can see which events fire.
    db.prepare(
      `INSERT OR IGNORE INTO webhook_events (paypal_event_id, event_type, verified, payload_json)
       VALUES (?, ?, ?, ?)`,
    ).run(event.id ?? null, event.event_type ?? "UNKNOWN", verified ? 1 : 0, JSON.stringify(event));
    console.log(`webhook ${event.event_type} verified=${verified}`);
    res.sendStatus(200);

    // Only verified events start work. processDispute only stores a PROPOSAL; the merchant approves later.
    const disputeId = event.resource?.dispute_id;
    if (verified && event.event_type === "CUSTOMER.DISPUTE.CREATED" && disputeId) {
      processDispute(deps, disputeId)
        .then(r => console.log(`dispute ${disputeId}: proposed ${r.decision?.action}`))
        .catch(err => console.error(`processing dispute ${disputeId} failed`, err));
    }
  });

  app.use("/api", express.json({ limit: "100kb" }));

  // Agent-facing: a buyer agent presents its signed mandate and asks to buy.
  // By default findings are RECORDED, not enforced, so out-of-mandate purchases can be demoed and later defended.
  // Set ENFORCE_MANDATE=true to refuse them with a 422 instead.
  app.post("/api/checkout", wrap(async (req, res) => {
    const body = CheckoutBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid request.", issues: body.error.issues });
    const { signedMandate: sm, purchase } = body.data;
    const pem = getAgentKey(db, sm.mandate.agentId);
    if (!pem) return res.status(400).json({ error: `Agent ${sm.mandate.agentId} is not registered with this merchant.` });
    if (!verifyMandate(sm, pem)) return res.status(400).json({ error: "Mandate signature is invalid." });

    const stored = db.prepare("SELECT mandate_hash, revoked_at FROM mandates WHERE id = ?").get(sm.mandate.id) as
      { mandate_hash: string; revoked_at: string | null } | undefined;
    if (stored && stored.mandate_hash !== sm.mandateHash) {
      return res.status(409).json({ error: "This mandate id was already used with different content." });
    }
    const p: Purchase = {
      merchantId: cfg.MERCHANT_ID, amountCents: purchase.amountCents, currency: purchase.currency ?? sm.mandate.currency,
      category: purchase.category, at: new Date().toISOString(),
    };
    const findings = checkPurchase(sm.mandate, p, { revokedAt: stored?.revoked_at ? toIso(stored.revoked_at) : null });
    if (cfg.ENFORCE_MANDATE && findings.some(f => f.severity === "block")) {
      return res.status(422).json({ error: "Purchase is outside the mandate and was not processed.", findings });
    }

    const order = await createOrder(cfg, {
      amountCents: p.amountCents, currency: p.currency, mandateId: sm.mandate.id, description: purchase.description,
      returnUrl: `${cfg.APP_URL}/paypal/return`, cancelUrl: `${cfg.APP_URL}/paypal/cancel`,
    });
    saveMandate(db, sm);
    recordOrder(db, {
      paypalOrderId: order.id, mandateId: sm.mandate.id, merchantId: p.merchantId, amountCents: p.amountCents,
      currency: p.currency, category: p.category, findings, at: p.at,
    });
    const approve = order.links.find(l => l.rel === "payer-action" || l.rel === "approve");
    res.status(201).json({ orderId: order.id, approveUrl: approve?.href, findings });
  }));

  // Merchant-facing (admin token).
  app.get("/admin", adminAuth, (_req, res) => res.type("html").send(adminPageHtml));

  app.post("/api/agents", adminAuth, wrap(async (req, res) => {
    const b = z.object({ agentId: z.string().min(1), publicKeyPem: z.string().min(1) }).safeParse(req.body);
    if (!b.success) return res.status(400).json({ error: "Expected { agentId, publicKeyPem }." });
    registerAgentKey(db, b.data.agentId, b.data.publicKeyPem);
    res.status(201).json({ ok: true });
  }));

  app.get("/api/disputes", adminAuth, wrap(async (_req, res) => res.json(listDisputes(db))));

  app.post("/api/disputes/import", adminAuth, wrap(async (req, res) => {
    const id = z.string().min(1).safeParse(req.body?.paypalDisputeId);
    if (!id.success) return res.status(400).json({ error: "Expected { paypalDisputeId }." });
    res.status(201).json(await processDispute(deps, id.data));
  }));

  const idParam = (req: Request) => {
    const n = Number(req.params.id);
    if (!Number.isInteger(n)) throw new ServiceError(400, "Bad dispute id.");
    return n;
  };
  app.get("/api/disputes/:id", adminAuth, wrap(async (req, res) => res.json(getDispute(db, idParam(req)))));
  app.post("/api/disputes/:id/approve", adminAuth, wrap(async (req, res) =>
    res.json(await approveDispute(deps, idParam(req), typeof req.body?.note === "string" ? req.body.note : undefined))));
  app.post("/api/disputes/:id/reject", adminAuth, wrap(async (req, res) => res.json(rejectDispute(db, idParam(req)))));

  return app;
}