import express, { type NextFunction, type Request, type Response } from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { verifyWebhook } from "../paypal/webhooks.js";
import { captureOrder, chargeVaultedToken, createOrder, createPayPalSetupToken, exchangePayPalLoginCode, exchangePayPalSetupToken, getAccessToken, getPayPalProfile, PAYPAL_LOGIN_BASE, PayPalHttpError } from "../paypal/client.js";
import { paypalDisputes, type DisputesApi } from "../paypal/disputes.js";
import { anthropicClient, geminiClient, type LlmClient } from "../ai/draft.js";
import { addDeliveryEvidence, approveDispute, getDispute, listDisputes, processDispute, rejectDispute, ServiceError, type Deps } from "../disputes/service.js";
import { Cart, Mandate, type Purchase } from "../mandate/types.js";
import { checkPaymentAuthorization, checkPurchase } from "../mandate/check.js";
import { ControlRequest, controlIsFresh, verifyControl, type ControlAction } from "../mandate/control.js";
import { verifyAuthorization } from "../mandate/authorize.js";
import { isEd25519PublicKeyPem } from "../mandate/sign.js";
import { cartAlreadyUsed, getAgentEvent, getAgentKey, getAgentOwner, getAgentPause, getMandateUsage, getPaymentAuthorization, getRevocation, getUserKey, linkPaymentToken, listMandateUses, listUserOrders, markCaptured, markMandateUse, recordControlEvent, recordKeyChange, recordOrder, registerAgentKey, registerUserKey, reserveMandateUse, revokePaymentAuthorization, saveMandate, saveProductCheck, toIso, type UseStatus } from "../repo.js";
import { adminPageHtml } from "./adminPage.js";
import { productFindings, searchChannel3, verifyProduct } from "../integrations/channel3.js";
import { caseSummary, findSimilarCases, indexAgentEvent, indexDisputeCase, outcomeOf, searchAgentEvents, type DisputeCase } from "../integrations/elastic.js";
import { buildZapierEvent, notifyZapier } from "../integrations/zapier.js";
import { buildAnalytics } from "../analytics/datasets.js";

const CheckoutBody = z.object({
  signedMandate: z.object({ mandate: Mandate, mandateHash: z.string(), signature: z.string() }),
  signedCart: z.object({ cart: Cart, cartHash: z.string(), signature: z.string() }),
  /** "approve" (default): return a PayPal link for the buyer to click. "autonomous": charge the user's saved account now. */
  mode: z.enum(["approve", "autonomous"]).default("approve"),
  purchase: z.object({
    amountCents: z.number().int().positive(),
    currency: z.string().length(3).optional(),
    category: z.string().optional(),
    description: z.string().max(127).optional(),
  }),
});

// Prototype page where a user signs spending rules and stop requests in their own browser.
const userPageHtml = readFileSync(new URL("./userPage.html", import.meta.url), "utf8");

export function createApp(cfg: Config, db: Db, inject: { disputes?: DisputesApi; llm?: LlmClient } = {}) {
  const elasticConfig = () => cfg.ELASTIC_URL && cfg.ELASTIC_API_KEY
    ? { url: cfg.ELASTIC_URL, apiKey: cfg.ELASTIC_API_KEY, index: cfg.ELASTIC_INDEX, caseIndex: cfg.ELASTIC_CASE_INDEX } : undefined;
  const channel3Config = () => cfg.CHANNEL3_URL && cfg.CHANNEL3_API_KEY ? { url: cfg.CHANNEL3_URL, apiKey: cfg.CHANNEL3_API_KEY } : undefined;
  const deps: Deps = {
    db,
    disputes: inject.disputes ?? paypalDisputes(cfg),
    llm: inject.llm ?? (cfg.GEMINI_API_KEY ? geminiClient(cfg.GEMINI_API_KEY, cfg.GEMINI_MODEL)
        : cfg.ANTHROPIC_API_KEY ? anthropicClient(cfg.ANTHROPIC_API_KEY, cfg.ANTHROPIC_MODEL) : undefined),
    onAgentEvent: async eventId => {
      await indexAgentEvent(elasticConfig(), getAgentEvent(db, eventId));
    },
    onProposal: async (disputeId, message, data) => {
      const e = buildZapierEvent({ disputeId, message, data }, cfg.APP_URL);
      await notifyZapier(cfg.ZAPIER_WEBHOOK_URL, e);
    },
    // Channel3: verify WHAT was bought. Elastic: find similar past cases. Both are optional and fail soft.
    verifyProduct: channel3Config() ? (productId, claim) => verifyProduct(channel3Config(), productId, claim) : undefined,
    findPrecedents: elasticConfig() ? (text, excludeDisputeId) => findSimilarCases(elasticConfig(), text, { excludeDisputeId }) : undefined,
    onDisputeChanged: elasticConfig() ? async id => {
      const es = elasticConfig();
      const r = getDispute(db, id);
      const agent = db.prepare(`SELECT m.agent_id AS agent_id FROM disputes d JOIN orders o ON o.id = d.order_id
                                JOIN mandates m ON m.id = o.mandate_id WHERE d.id = ?`).get(id) as { agent_id: string } | undefined;
      const findingCodes = (r.findings ?? []).map(f => f.code);
      const action = r.decision?.action ?? "none";
      const facts = { reason: r.reason ?? "UNKNOWN", action, findingCodes, category: r.purchase?.category, productTitle: r.productCheck?.title,
        productVerdict: r.productCheck?.categoryVerdict, hasDeliveryProof: Boolean(r.deliveryProof?.length) };
      const doc: DisputeCase = { disputeId: r.id, paypalDisputeId: r.paypalDisputeId, merchantOutcome: outcomeOf(r.workflowState), amountCents: r.amountCents,
        currency: r.purchase?.currency ?? "USD", agentId: agent?.agent_id, summary: caseSummary(facts), createdAt: new Date().toISOString(), ...facts };
      await indexDisputeCase(es, doc);
    } : undefined,
  };
  const app = express();
  /** Carts with a charge currently awaiting PayPal in this process. Across processes, PayPal's idempotency key is the backstop. */
  const inFlight = new Set<string>();
  const loginClientId = cfg.PAYPAL_LOGIN_CLIENT_ID ?? cfg.PAYPAL_CLIENT_ID;
  const loginClientSecret = cfg.PAYPAL_LOGIN_CLIENT_SECRET ?? cfg.PAYPAL_CLIENT_SECRET;
  const cookieName = "warrant_session";
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const isoAfter = (hours: number) => new Date(Date.now() + hours * 3600000).toISOString();
  const readCookie = (req: Request, name: string) => {
    const raw = req.header("cookie") ?? "";
    return raw.split(";").map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1);
  };
  const sessionUser = (req: Request) => {
    const token = readCookie(req, cookieName);
    if (!token) return undefined;
    const row = db.prepare("SELECT user_id, email, display_name, expires_at FROM auth_sessions WHERE session_id_hash = ?").get(hash(token)) as
      { user_id: string; email: string | null; display_name: string | null; expires_at: string } | undefined;
    if (!row || Date.parse(row.expires_at) <= Date.now()) return undefined;
    return { userId: row.user_id, email: row.email, displayName: row.display_name };
  };
  const setSession = (res: Response, userId: string, email?: string, displayName?: string) => {
    const token = randomUUID() + randomUUID();
    const expiresAt = isoAfter(cfg.AUTH_SESSION_HOURS);
    db.prepare("INSERT INTO auth_sessions (session_id_hash, user_id, email, display_name, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(hash(token), userId, email ?? null, displayName ?? null, expiresAt);
    const secure = cfg.APP_URL.startsWith("https://") ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(cfg.AUTH_SESSION_HOURS * 3600)}${secure}`);
  };
  const loginConfigured = Boolean(cfg.PAYPAL_LOGIN_CLIENT_ID || cfg.PAYPAL_CLIENT_ID);

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

  app.get("/", (_req, res) => res.redirect("/studio/"));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, webhookVerification: Boolean(cfg.PAYPAL_WEBHOOK_ID), llm: Boolean(deps.llm), admin: Boolean(cfg.ADMIN_TOKEN),
      paypalLogin: loginConfigured,
      integrations: { channel3: Boolean(cfg.CHANNEL3_URL && cfg.CHANNEL3_API_KEY), elastic: Boolean(cfg.ELASTIC_URL && cfg.ELASTIC_API_KEY),
        zapier: Boolean(cfg.ZAPIER_WEBHOOK_URL), agGrid: true, agStudio: existsSync(fileURLToPath(new URL("../../web/dist", import.meta.url))), studioAgent: Boolean(cfg.STUDIO_LLM_API_KEY), paypalMcp: cfg.PAYPAL_MCP_ENABLED, postman: true, apimatic: true } });
  });

  app.get("/auth/paypal/start", (_req, res) => {
    if (!loginConfigured) return res.status(503).type("text/plain").send("PayPal sign-in is not configured.");
    const state = randomUUID();
    db.prepare("INSERT INTO paypal_oauth_states (state, expires_at) VALUES (?, ?)").run(state, isoAfter(10));
    const params = new URLSearchParams({
      client_id: loginClientId,
      response_type: "code",
      scope: cfg.PAYPAL_LOGIN_SCOPES,
      redirect_uri: `${cfg.APP_URL}/auth/paypal/callback`,
      state,
    });
    res.redirect(`${PAYPAL_LOGIN_BASE}/signin/authorize?${params}`);
  });

  app.get("/auth/paypal/callback", async (req, res) => {
    const state = String(req.query.state ?? "");
    const code = String(req.query.code ?? "");
    const valid = state && code && Boolean(db.prepare("SELECT 1 FROM paypal_oauth_states WHERE state = ? AND expires_at > ?").get(state, new Date().toISOString()));
    db.prepare("DELETE FROM paypal_oauth_states WHERE state = ?").run(state);
    if (!valid) return res.status(400).type("text/plain").send("The PayPal sign-in session expired. Please try again.");
    try {
      const token = await exchangePayPalLoginCode(loginClientId, loginClientSecret, code, `${cfg.APP_URL}/auth/paypal/callback`);
      const profile = await getPayPalProfile(token.access_token);
      const paypalSubject = profile.user_id ?? profile.sub;
      if (!paypalSubject) return res.status(502).type("text/plain").send("PayPal did not return a stable user identity.");
      const userId = `paypal:${paypalSubject}`;
      setSession(res, userId, profile.email, profile.name);
      res.redirect("/user");
    } catch (err) {
      console.error("PayPal sign-in failed", err);
      res.status(502).type("text/plain").send(`PayPal sign-in failed: ${(err as Error).message}`);
    }
  });

  app.get("/api/me/session", (req, res) => {
    const user = sessionUser(req);
    if (!user) return res.status(401).json({ authenticated: false });
    const paymentConnected = getPaymentAuthorization(db, user.userId)?.status === "ACTIVE";
    const agentPause = getAgentPause(db, user.userId);
    res.json({
      authenticated: true,
      ...user,
      paymentConnected,
      automaticShopping: { paused: agentPause.paused, since: agentPause.since, reason: agentPause.reason },
    });
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

  app.get("/paypal/payment-return", async (req, res) => {
    const state = String(req.query.state ?? "");
    // PayPal returns the approved setup token as `approval_token_id`; `token` and `setup_token_id` are accepted too.
    const setupTokenId = String(req.query.approval_token_id ?? req.query.token ?? req.query.setup_token_id ?? "");
    const setup = db.prepare("SELECT user_id, setup_token_id FROM payment_setup_sessions WHERE state = ? AND expires_at > ?").get(state, new Date().toISOString()) as
      { user_id: string; setup_token_id: string } | undefined;
    db.prepare("DELETE FROM payment_setup_sessions WHERE state = ?").run(state);
    if (!setup || !setupTokenId || setup.setup_token_id !== setupTokenId) return res.status(400).type("text/plain").send("The PayPal payment connection session expired. Please try again.");
    try {
      const token = await exchangePayPalSetupToken(cfg, setup.setup_token_id);
      linkPaymentToken(db, setup.user_id, token.id, token.customer?.id);
      res.redirect("/user?payment=connected");
    } catch (err) {
      console.error("PayPal payment connection failed", err);
      res.status(502).type("text/plain").send(`PayPal payment connection failed: ${(err as Error).message}`);
    }
  });

  // Raw body so we log exactly what PayPal sent.
  app.post("/webhooks/paypal", express.raw({ type: "*/*" }), async (req, res) => {
    let event: { id?: string; event_type?: string; resource?: { dispute_id?: string } };
    try {
      event = JSON.parse((req.body as Buffer).toString("utf8"));
    } catch {
      return res.status(400).json({ error: "invalid json" });
    }
    if (!event.id || !event.event_type) {
      return res.status(400).json({ error: "PayPal webhook must include id and event_type" });
    }
    let verified = false;
    try {
      verified = await verifyWebhook(cfg, req.headers, event);
    } catch (err) {
      console.error("webhook verification error", err);
    }
    // Store everything (verified flag recorded) so we can see which events fire.
    const stored = db.prepare(
      `INSERT OR IGNORE INTO webhook_events (paypal_event_id, event_type, verified, payload_json)
       VALUES (?, ?, ?, ?)`,
    ).run(event.id, event.event_type, verified ? 1 : 0, JSON.stringify(event));
    console.log(`webhook ${event.event_type} verified=${verified}`);
    res.sendStatus(200);

    // Only verified events start work. processDispute only stores a PROPOSAL; the merchant approves later.
    const disputeId = event.resource?.dispute_id;
    if (stored.changes === 1 && verified && event.event_type === "CUSTOMER.DISPUTE.CREATED" && disputeId) {
      processDispute(deps, disputeId)
        .then(r => console.log(`dispute ${disputeId}: proposed ${r.decision?.action}`))
        .catch(err => console.error(`processing dispute ${disputeId} failed`, err));
    }
  });

  app.use("/api", express.json({ limit: "100kb" }));

  app.post("/api/catalog/search", wrap(async (req, res) => {
    const b = z.object({
      query: z.string().min(1), maxAmountCents: z.number().int().positive(),
      currency: z.string().length(3).default("USD"), category: z.string().optional(),
    }).safeParse(req.body);
    if (!b.success) return res.status(400).json({ error: "Expected a product search request.", issues: b.error.issues });
    const products = await searchChannel3(cfg.CHANNEL3_URL, cfg.CHANNEL3_API_KEY, { ...b.data, merchantId: cfg.MERCHANT_ID });
    res.json({ source: products.length ? "channel3" : "not_configured", products });
  }));

  // Agent-facing: a buyer agent presents its signed mandate and asks to buy.
  // By default findings are RECORDED, not enforced, so out-of-mandate purchases can be demoed and later defended.
  // Set ENFORCE_MANDATE=true to refuse them with a 422 instead.
  app.post("/api/checkout", wrap(async (req, res) => {
    const body = CheckoutBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid request.", issues: body.error.issues });
    const { signedMandate: sm, signedCart, purchase, mode } = body.data;

    const stored = db.prepare("SELECT mandate_hash, revoked_at FROM mandates WHERE id = ?").get(sm.mandate.id) as
      { mandate_hash: string; revoked_at: string | null } | undefined;
    if (stored && stored.mandate_hash !== sm.mandateHash) {
      return res.status(409).json({ error: "This mandate id was already used with different content." });
    }
    const p: Purchase = {
      merchantId: cfg.MERCHANT_ID, amountCents: purchase.amountCents, currency: purchase.currency ?? sm.mandate.currency,
      category: purchase.category, at: new Date().toISOString(),
    };
    // The user must have signed the mandate; the agent must have signed this exact purchase under it.
    const auth = verifyAuthorization({
      signedMandate: sm, signedCart, purchase: p,
      userPublicKeyPem: getUserKey(db, sm.mandate.userId),
      agentPublicKeyPem: getAgentKey(db, sm.mandate.agentId),
    });
    if (!auth.ok) return res.status(400).json({ error: "Authorization could not be verified.", problems: auth.problems, checks: auth });
    if (cartAlreadyUsed(db, signedCart.cart.cartId)) {
      return res.status(409).json({ error: "This signed cart was already used for an order." });
    }
    // Revocation and pause are read at the moment of the request, so they take effect immediately.
    const revocation = getRevocation(db, sm.mandate.id, sm.mandate.userId);
    const pause = getAgentPause(db, sm.mandate.userId, p.at);
    const mandateFindings = checkPurchase(sm.mandate, p, {
      revokedAt: revocation?.revokedAt ?? null, revokedReason: revocation?.reason, agentPaused: pause.paused ? pause : null,
    });
    // Channel3: the cart commits the agent to a specific product. Check what that product really is, so an agent cannot
    // slip a disallowed item past the mandate by declaring a friendlier category. A failed lookup never blocks a purchase.
    const productId = signedCart.cart.productId;
    const productCheck = productId && channel3Config()
      ? await verifyProduct(channel3Config(), productId, { declaredCategory: p.category, allowedCategories: sm.mandate.allowedCategories, amountCents: p.amountCents, currency: p.currency })
      : undefined;
    const findings = [...mandateFindings, ...productFindings(productCheck)];
    const snapshotProduct = (orderRowId: number) => {
      if (productCheck && productCheck.lookup !== "unavailable") saveProductCheck(db, orderRowId, productCheck);
    };
    const blocked = findings.some(f => f.severity === "block");
    // Autonomous mode moves money with no human in the loop, so it ALWAYS enforces the mandate,
    // whatever ENFORCE_MANDATE says. Out-of-mandate purchases are only ever recorded when a person approves them.
    if ((cfg.ENFORCE_MANDATE || mode === "autonomous") && blocked) {
      return res.status(422).json({ error: "Purchase is outside the mandate and was not processed.", findings });
    }

    if (mode === "autonomous") {
      const payAuth = getPaymentAuthorization(db, sm.mandate.userId);
      if (!payAuth) return res.status(409).json({ error: `User ${sm.mandate.userId} has no linked payment method, so Warrant cannot charge without approval.` });
      const payFindings = checkPaymentAuthorization(payAuth, new Date(p.at));
      if (payFindings.length) {
        return res.status(422).json({ error: "The user's saved payment authorization cannot be used, so nothing was charged.", findings: [...findings, ...payFindings] });
      }
      const tokenId = payAuth.tokenId;
      const cartId = signedCart.cart.cartId;
      if (inFlight.has(cartId)) return res.status(409).json({ error: "A charge for this signed cart is already in progress." });
      saveMandate(db, sm);
      // Hold budget BEFORE calling PayPal. Cumulative limits and single-use are checked in the same transaction as the hold.
      const hold = reserveMandateUse(db, sm.mandate, cartId, p.amountCents);
      if (!hold.ok) {
        if (hold.reason === "ALREADY_CAPTURED") return res.status(409).json({ error: "This signed cart was already used for an order." });
        return res.status(422).json({ error: "Purchase would exceed the mandate's cumulative limits and was not processed.", findings: [...findings, ...hold.findings] });
      }
      inFlight.add(cartId);
      try {
      let paid;
      try {
        // The signed cart id is the idempotency key: a retry returns the same PayPal order instead of charging twice.
        paid = await chargeVaultedToken(cfg, {
          tokenId, amountCents: p.amountCents, currency: p.currency, mandateId: sm.mandate.id,
          chargeKey: cartId, description: purchase.description,
        });
      } catch (err) {
        console.error("autonomous charge failed", err);
        const msg = (err as Error).message;
        // Only a clear PayPal refusal (4xx) proves no money moved. A network error, timeout or 5xx could hide a charge that went
        // through, so the budget stays held and the cart can be retried safely with the same idempotency key.
        const refused = err instanceof PayPalHttpError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
        if (refused) {
          markMandateUse(db, cartId, "RELEASED", { detail: msg.slice(0, 500) });
          return res.status(502).json({ error: `PayPal could not complete the charge: ${msg}`, outcome: "REFUSED", findings });
        }
        markMandateUse(db, cartId, "UNKNOWN", { detail: msg.slice(0, 500) });
        return res.status(502).json({
          error: `PayPal's outcome is unknown: ${msg}. The budget stays held. Retry the same signed cart to resolve it safely.`,
          outcome: "UNKNOWN", findings,
        });
      }
      const capture = paid.purchase_units?.[0]?.payments?.captures?.[0];
      if (paid.status !== "COMPLETED" || !capture?.id) {
        const declined = capture !== undefined && ["DECLINED", "FAILED"].includes(capture.status);
        markMandateUse(db, cartId, declined ? "RELEASED" : "UNKNOWN", { paypalOrderId: paid.id, detail: `PayPal status ${paid.status}` });
        return res.status(502).json({
          error: `PayPal did not complete the payment (status ${paid.status}).`, orderId: paid.id,
          outcome: declined ? "REFUSED" : "UNKNOWN", findings,
        });
      }
      // Money has moved. Record that first, so a crash before the order row is written cannot lose it.
      markMandateUse(db, cartId, "CAPTURED", { paypalOrderId: paid.id, captureId: capture.id });
      try {
        const orderRowId = recordOrder(db, {
          paypalOrderId: paid.id, mandateId: sm.mandate.id, merchantId: p.merchantId, amountCents: p.amountCents,
          currency: p.currency, category: p.category, findings, at: p.at, signedCart, captureId: capture.id,
        });
        markMandateUse(db, cartId, "CAPTURED", { orderId: orderRowId });
        snapshotProduct(orderRowId);
      } catch {
        return res.status(409).json({ error: "This signed cart was already used for an order." });
      }
      markCaptured(db, paid.id, capture.id);
      const usage = getMandateUsage(db, sm.mandate.id);
      return res.status(201).json({
        orderId: paid.id, captureId: capture.id, status: "CAPTURED", findings,
        mandateUsage: {
          ...usage,
          remainingTotalCents: sm.mandate.maxTotalAmountCents === undefined ? undefined : Math.max(0, sm.mandate.maxTotalAmountCents - usage.spentAmountCents),
        },
      });
      } finally {
        inFlight.delete(cartId);
      }
    }

    const order = await createOrder(cfg, {
      amountCents: p.amountCents, currency: p.currency, mandateId: sm.mandate.id, description: purchase.description,
      returnUrl: `${cfg.APP_URL}/paypal/return`, cancelUrl: `${cfg.APP_URL}/paypal/cancel`,
    });
    saveMandate(db, sm);
    snapshotProduct(recordOrder(db, {
      paypalOrderId: order.id, mandateId: sm.mandate.id, merchantId: p.merchantId, amountCents: p.amountCents,
      currency: p.currency, category: p.category, findings, at: p.at, signedCart,
    }));
    const approve = order.links.find(l => l.rel === "payer-action" || l.rel === "approve");
    res.status(201).json({ orderId: order.id, approveUrl: approve?.href, findings });
  }));

  // ---- User controls: revoke a mandate, pause/resume the agent, revoke the saved payment source ----------------------
  // Authorized by the USER's signature (a SignedControl in the body). The merchant admin token may also STOP things
  // (revoke, pause, revoke payment) but can never resume: only the user can turn their agent back on.
  const isAdmin = (req: Request) => {
    if (!cfg.ADMIN_TOKEN || req.header("x-admin-token") === undefined) return false;
    const given = Buffer.from(String(req.header("x-admin-token")));
    const want = Buffer.from(cfg.ADMIN_TOKEN);
    return given.length === want.length && timingSafeEqual(given, want);
  };
  interface Authorized { userId: string; via: "user_signature" | "admin"; issuedAt: string; nonce: string; reason?: string }
  const authorizeControl = (req: Request, spec: {
    action: ControlAction; subjectId: string; allowAdmin: boolean;
    /** The user the target belongs to, when Warrant already knows it. Needed for the admin path. */
    knownUserId?: string; /** For user-scoped actions: the signed request must be about this same user. */ expectUserId?: string;
  }): Authorized => {
    if (isAdmin(req)) {
      if (!spec.allowAdmin) throw new ServiceError(403, "Only the user can do this. Sign the request with the user's key.");
      if (!spec.knownUserId) throw new ServiceError(404, "Warrant does not know this mandate, so only the user can revoke it. Sign the request with the user's key.");
      return { userId: spec.knownUserId, via: "admin", issuedAt: new Date().toISOString(), nonce: `admin-${randomUUID()}`,
        reason: typeof req.body?.reason === "string" ? req.body.reason.slice(0, 300) : undefined };
    }
    const parsed = z.object({ signedControl: z.object({ request: ControlRequest, signature: z.string().min(1) }) }).safeParse(req.body);
    if (!parsed.success) throw new ServiceError(401, "Provide { signedControl: { request, signature } } signed with the user's key.");
    const sc = parsed.data.signedControl, r = sc.request;
    if (r.action !== spec.action || r.subjectId !== spec.subjectId || (spec.expectUserId !== undefined && r.userId !== spec.expectUserId)) {
      throw new ServiceError(400, "The signed request is for a different action or subject than this route.");
    }
    const key = getUserKey(db, r.userId);
    if (!key || !verifyControl(sc, key)) throw new ServiceError(401, `The request was not signed by the registered key of user ${r.userId}.`);
    if (!controlIsFresh(r)) throw new ServiceError(400, "The signed request is too old or dated in the future. Sign a new one.");
    return { userId: r.userId, via: "user_signature", issuedAt: r.issuedAt, nonce: r.nonce, reason: r.reason };
  };
  const record = (a: Authorized, action: ControlAction, subjectId: string) => {
    const ev = recordControlEvent(db, { userId: a.userId, action, subjectId, reason: a.reason, issuedAt: a.issuedAt, nonce: a.nonce, via: a.via });
    if (!ev) throw new ServiceError(409, "This signed request was already used.");
    return ev;
  };

  app.post("/api/mandates/:id/revoke", wrap(async (req, res) => {
    const mandateId = req.params.id;
    const stored = db.prepare("SELECT user_id FROM mandates WHERE id = ?").get(mandateId) as { user_id: string } | undefined;
    const a = authorizeControl(req, { action: "revoke_mandate", subjectId: mandateId, allowAdmin: true, knownUserId: stored?.user_id });
    if (stored && stored.user_id !== a.userId) throw new ServiceError(403, "This mandate belongs to a different user.");
    const already = getRevocation(db, mandateId, a.userId);
    if (already) return res.json({ ok: true, mandateId, userId: a.userId, alreadyRevoked: true, revokedAt: already.revokedAt, reason: already.reason });
    const ev = record(a, "revoke_mandate", mandateId);
    res.json({ ok: true, mandateId, userId: a.userId, alreadyRevoked: false, revokedAt: ev.appliedAt, reason: ev.reason ?? undefined, via: ev.via });
  }));

  const userRoute = (path: string, action: ControlAction, allowAdmin: boolean, run: (userId: string, a: Authorized, res: Response) => unknown) =>
    app.post(`/api/users/:id/${path}`, wrap(async (req, res) => {
      const userId = req.params.id;
      if (!getUserKey(db, userId)) throw new ServiceError(404, `No key is registered for user ${userId}.`);
      const a = authorizeControl(req, { action, subjectId: userId, allowAdmin, knownUserId: userId, expectUserId: userId });
      run(userId, a, res);
    }));

  userRoute("pause-agent", "pause_agent", true, (userId, a, res) => {
    const now = getAgentPause(db, userId);
    if (now.paused) return res.json({ ok: true, userId, paused: true, alreadyPaused: true, since: now.since, reason: now.reason });
    const ev = record(a, "pause_agent", userId);
    res.json({ ok: true, userId, paused: true, alreadyPaused: false, since: ev.appliedAt, reason: ev.reason ?? undefined, via: ev.via });
  });
  userRoute("resume-agent", "resume_agent", false, (userId, a, res) => {
    if (!getAgentPause(db, userId).paused) return res.json({ ok: true, userId, paused: false, alreadyActive: true });
    const ev = record(a, "resume_agent", userId);
    res.json({ ok: true, userId, paused: false, alreadyActive: false, resumedAt: ev.appliedAt, via: ev.via });
  });
  app.post("/api/users/:id/orders", wrap(async (req, res) => {
    const userId = req.params.id;
    if (!getUserKey(db, userId)) throw new ServiceError(404, `No key is registered for user ${userId}.`);
    const a = authorizeControl(req, { action: "view_orders", subjectId: userId, allowAdmin: false, knownUserId: userId, expectUserId: userId });
    record(a, "view_orders", userId);
    res.json(listUserOrders(db, userId));
  }));
  userRoute("revoke-payment", "revoke_payment_authorization", true, (userId, a, res) => {
    const auth = getPaymentAuthorization(db, userId);
    if (!auth) throw new ServiceError(404, `User ${userId} has no linked payment method.`);
    if (auth.status !== "ACTIVE") return res.json({ ok: true, userId, alreadyRevoked: true });
    const ev = record(a, "revoke_payment_authorization", userId);
    revokePaymentAuthorization(db, userId);
    res.json({ ok: true, userId, alreadyRevoked: false, revokedAt: ev.appliedAt, reason: ev.reason ?? undefined, via: ev.via });
  });

  // The page itself holds no secrets and sends no keys; it only serves HTML and calls the routes above.
  // User-controlled authorization page. Keep /me as a backwards-compatible alias.
  app.get(["/user", "/me"], (_req, res) => res.type("html").send(userPageHtml));

  // Merchant-facing (admin token).
  app.get("/admin", adminAuth, (_req, res) => res.type("html").send(adminPageHtml));

  // Registers the public key a user's mandates must verify against. In production this binding would come
  // from the user's wallet or an identity issuer; here the merchant admin registers it.
  app.post("/api/users", adminAuth, wrap(async (req, res) => {
    const b = z.object({ userId: z.string().min(1), publicKeyPem: z.string().min(1) }).safeParse(req.body);
    if (!b.success) return res.status(400).json({ error: "Expected { userId, publicKeyPem }." });
    if (!isEd25519PublicKeyPem(b.data.publicKeyPem)) return res.status(400).json({ error: "publicKeyPem must be an Ed25519 public key in PEM format." });
    recordKeyChange(db, { kind: "user", subjectId: b.data.userId, actor: "admin", oldKeyPem: getUserKey(db, b.data.userId), newKeyPem: b.data.publicKeyPem });
    registerUserKey(db, b.data.userId, b.data.publicKeyPem);
    res.status(201).json({ ok: true });
  }));

  // Self-registration for the user controls page. The caller must be signed in with PayPal AS that user: the
  // session is what ties a key to a person. (A production deployment would bind keys to a passkey or wallet.)
  app.post("/api/me/public-key", wrap(async (req, res) => {
    const b = z.object({ userId: z.string().min(1), publicKeyPem: z.string().min(1), replaceExisting: z.boolean().optional() }).safeParse(req.body);
    if (!b.success) return res.status(400).json({ error: "Expected { userId, publicKeyPem }." });
    const signedIn = sessionUser(req);
    if (!signedIn) return res.status(401).json({ error: "Sign in with PayPal before connecting a device." });
    if (signedIn.userId !== b.data.userId) return res.status(403).json({ error: "This device cannot be connected to another signed-in account." });
    if (!isEd25519PublicKeyPem(b.data.publicKeyPem)) return res.status(400).json({ error: "publicKeyPem must be an Ed25519 public key in PEM format." });
    const existing = getUserKey(db, b.data.userId);
    if (existing && existing !== b.data.publicKeyPem && !b.data.replaceExisting) {
      return res.status(409).json({ error: "A different key is already registered for this user." });
    }
    if (!existing || existing !== b.data.publicKeyPem) {
      recordKeyChange(db, { kind: "user", subjectId: b.data.userId, actor: `session:${signedIn.userId}`, oldKeyPem: existing, newKeyPem: b.data.publicKeyPem });
      registerUserKey(db, b.data.userId, b.data.publicKeyPem);
    }
    res.status(existing && existing === b.data.publicKeyPem ? 200 : 201).json({ ok: true, userId: b.data.userId, replaced: Boolean(existing && existing !== b.data.publicKeyPem) });
  }));

  app.post("/api/me/payment/start", wrap(async (req, res) => {
    const user = sessionUser(req);
    if (!user) return res.status(401).json({ error: "Sign in with PayPal first." });
    if (!getUserKey(db, user.userId)) return res.status(409).json({ error: "Connect this device before connecting a payment method." });
    const state = randomUUID();
    const setup = await createPayPalSetupToken(cfg, {
      returnUrl: `${cfg.APP_URL}/paypal/payment-return?state=${encodeURIComponent(state)}`,
      cancelUrl: `${cfg.APP_URL}/user?payment=cancelled`,
    });
    const approve = setup.links?.find(l => ["payer-action", "approve", "payer-action-url", "approval_url"].includes(l.rel.toLowerCase()));
    if (!approve?.href) {
      // PayPal accepted the request (status CREATED, self link only) but never opened a payer session:
      // no PAYER_ACTION_REQUIRED, so no approve URL exists. Two causes are known. (1) The request body was
      // not in the Payment Method Tokens API shape (usage_type must sit directly under payment_source.paypal);
      // that is fixed in createPayPalSetupToken. (2) The sandbox app or business account is not provisioned for
      // wallet vaulting, which the "fix" steps below cover. Building checkoutnow?token= ourselves does not
      // work around either: it fails with "Things don't appear to be working at the moment", and the later
      // exchange fails with MISSING_BILLING_APPROVAL_TOKEN.
      console.error("PayPal setup token did not include an approval link", {
        setupTokenId: setup.id,
        status: setup.status,
        links: setup.links?.map(l => ({ rel: l.rel, method: l.method })),
      });
      return res.status(502).json({
        error: "PayPal did not return a payment approval link.",
        providerStatus: setup.status ?? "unknown",
        providerLinks: setup.links?.map(l => ({ rel: l.rel, method: l.method })) ?? [],
        setupTokenId: setup.id,
        expectedStatus: "PAYER_ACTION_REQUIRED",
        hint: "PayPal did not open a payer session. If the request shape is correct, this sandbox app or business account is not provisioned for PayPal Wallet vaulting (Payment Method Tokens API).",
        fix: [
          "Developer Dashboard > Apps & Credentials > this app > Sandbox App Settings > App Feature Options: check 'Accept payments', expand Advanced options and enable 'Vault'.",
          "Sandbox Business account > Account Settings > Payment Preferences > 'Save PayPal and Venmo payment methods' > Get Started until the status is Success.",
          "Docs: https://developer.paypal.com/api/save-with-purchase/save-payment-methods/",
        ],
      });
    }
    db.prepare("INSERT INTO payment_setup_sessions (state, user_id, setup_token_id, expires_at) VALUES (?, ?, ?, ?)")
      .run(state, user.userId, setup.id, isoAfter(10));
    res.json({ approveUrl: approve.href });
  }));

  // Browser agent bootstrap used by the one-click shopping flow. A signed-in user may register an agent id
  // that is not taken, and may later change only the agents they registered. Agents registered by the merchant
  // admin, or by another user, cannot be changed here: whoever holds an agent's key can sign carts for every
  // mandate that names that agent.
  app.post("/api/me/agent-key", wrap(async (req, res) => {
    const b = z.object({ agentId: z.string().min(1), publicKeyPem: z.string().min(1), replaceExisting: z.boolean().optional() }).safeParse(req.body);
    if (!b.success) return res.status(400).json({ error: "Expected { agentId, publicKeyPem }." });
    const signedIn = sessionUser(req);
    if (!signedIn) return res.status(401).json({ error: "Sign in with PayPal before connecting a shopping agent." });
    if (!isEd25519PublicKeyPem(b.data.publicKeyPem)) return res.status(400).json({ error: "publicKeyPem must be an Ed25519 public key in PEM format." });
    const existing = getAgentKey(db, b.data.agentId);
    if (existing && existing !== b.data.publicKeyPem) {
      if (getAgentOwner(db, b.data.agentId) !== signedIn.userId) {
        return res.status(403).json({ error: "This agent id belongs to another account or was registered by the merchant. Use a different agent id." });
      }
      if (!b.data.replaceExisting) return res.status(409).json({ error: "A different key is already registered for this agent." });
    }
    if (!existing || existing !== b.data.publicKeyPem) {
      recordKeyChange(db, { kind: "agent", subjectId: b.data.agentId, actor: `session:${signedIn.userId}`, oldKeyPem: existing, newKeyPem: b.data.publicKeyPem });
      registerAgentKey(db, b.data.agentId, b.data.publicKeyPem, signedIn.userId);
    }
    res.status(existing && existing === b.data.publicKeyPem ? 200 : 201).json({ ok: true, agentId: b.data.agentId });
  }));

  // Links the saved PayPal account (vault token) a user's agent may be charged against without a click.
  app.post("/api/users/payment-token", adminAuth, wrap(async (req, res) => {
    const b = z.object({ userId: z.string().min(1), tokenId: z.string().min(1), paypalCustomerId: z.string().optional(), expiresAt: z.string().datetime().optional() }).safeParse(req.body);
    if (!b.success) return res.status(400).json({ error: "Expected { userId, tokenId, paypalCustomerId?, expiresAt? (ISO 8601) }." });
    if (!getUserKey(db, b.data.userId)) return res.status(409).json({ error: `Register a key for user ${b.data.userId} first.` });
    linkPaymentToken(db, b.data.userId, b.data.tokenId, b.data.paypalCustomerId, b.data.expiresAt);
    res.status(201).json({ ok: true });
  }));

  app.post("/api/agents", adminAuth, wrap(async (req, res) => {
    const b = z.object({ agentId: z.string().min(1), publicKeyPem: z.string().min(1) }).safeParse(req.body);
    if (!b.success) return res.status(400).json({ error: "Expected { agentId, publicKeyPem }." });
    if (!isEd25519PublicKeyPem(b.data.publicKeyPem)) return res.status(400).json({ error: "publicKeyPem must be an Ed25519 public key in PEM format." });
    recordKeyChange(db, { kind: "agent", subjectId: b.data.agentId, actor: "admin", oldKeyPem: getAgentKey(db, b.data.agentId), newKeyPem: b.data.publicKeyPem });
    registerAgentKey(db, b.data.agentId, b.data.publicKeyPem);
    res.status(201).json({ ok: true });
  }));

  // Autonomous charges whose outcome needs a human look (status=UNKNOWN), or any status.
  app.get("/api/mandate-uses", adminAuth, wrap(async (req, res) => {
    const st = z.enum(["RESERVED", "CAPTURED", "UNKNOWN", "RELEASED"]).optional().safeParse(req.query.status);
    if (!st.success) return res.status(400).json({ error: "status must be RESERVED, CAPTURED, UNKNOWN or RELEASED." });
    res.json(listMandateUses(db, st.data as UseStatus | undefined));
  }));

  app.get("/api/disputes", adminAuth, wrap(async (_req, res) => res.json(listDisputes(db))));
  app.get("/api/agent-events/search", adminAuth, wrap(async (req, res) => {
    const query = z.string().min(1).safeParse(req.query.q);
    if (!query.success) return res.status(400).json({ error: "Provide ?q=..." });
    const elastic = elasticConfig();
    res.json({ source: elastic ? "elastic" : "not_configured", results: await searchAgentEvents(elastic, query.data) });
  }));

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
  app.post("/api/disputes/:id/reject", adminAuth, wrap(async (req, res) => res.json(rejectDispute(db, idParam(req),
    id => void deps.onDisputeChanged?.(id).catch(err => console.error(`dispute ${id} change hook failed`, err))))));

  // Evidence arriving after a dispute opened. The merchant's Zapier Zap posts carrier data here; the proposal is re-run.
  // Accepts the admin token OR the shared EVIDENCE_WEBHOOK_SECRET, so a Zap never holds the key that can approve responses.
  app.post("/api/disputes/:id/evidence", wrap(async (req, res) => {
    const secret = String(req.header("x-warrant-evidence-secret") ?? "");
    const adminGiven = req.header("x-admin-token") !== undefined;
    const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
    const viaSecret = Boolean(cfg.EVIDENCE_WEBHOOK_SECRET) && secret !== "" && safeEq(secret, cfg.EVIDENCE_WEBHOOK_SECRET!);
    const viaAdmin = adminGiven && Boolean(cfg.ADMIN_TOKEN) && safeEq(String(req.header("x-admin-token")), cfg.ADMIN_TOKEN!);
    if (!viaSecret && !viaAdmin) return res.status(401).json({ error: "Send x-warrant-evidence-secret (or x-admin-token)." });
    res.json(await addDeliveryEvidence(deps, idParam(req), req.body, viaSecret ? "zapier" : "admin"));
  }));

  // Similar past cases (Elastic). Read-only; also used by the Studio agent.
  app.get("/api/precedents", adminAuth, wrap(async (req, res) => {
    const q = z.string().min(1).max(500).safeParse(req.query.q);
    if (!q.success) return res.status(400).json({ error: "Provide ?q=..." });
    const found = await findSimilarCases(elasticConfig(), q.data, { size: 5 });
    res.json(found ?? { mode: "not_configured", cases: [] });
  }));

  // ---- AG Studio: data, the agent's LLM proxy, and the built dashboard ----------------------------------------------
  app.get("/api/analytics/datasets", adminAuth, wrap(async (_req, res) => res.json(buildAnalytics(db))));

  // The Studio agent talks to an OpenAI Responses-compatible API. It goes through here so the provider key stays on the
  // server; the browser only holds the admin token, which Studio sends as the bearer "key". Mounted outside /api for a larger body limit.
  app.post("/studio-api/llm", express.json({ limit: "4mb" }), async (req, res) => {
    if (!cfg.ADMIN_TOKEN) return res.status(503).json({ error: "Set ADMIN_TOKEN." });
    const given = Buffer.from(String(req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    const want = Buffer.from(cfg.ADMIN_TOKEN);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return res.status(401).json({ error: "Invalid admin token." });
    if (!cfg.STUDIO_LLM_API_KEY) return res.status(503).json({ error: "Set STUDIO_LLM_API_KEY to enable the Studio agent." });
    try {
      const body = { ...(req.body ?? {}), ...(cfg.STUDIO_LLM_MODEL ? { model: cfg.STUDIO_LLM_MODEL } : {}) } as Record<string, unknown>;
      if (cfg.PAYPAL_MCP_ENABLED) {
        const accessToken = await getAccessToken(cfg);
        const existingTools = Array.isArray(body.tools) ? body.tools : [];
        body.tools = [...existingTools, {
          type: "mcp",
          server_label: "paypal-sandbox",
          server_url: cfg.PAYPAL_MCP_URL,
          require_approval: "always",
          headers: { Authorization: `Bearer ${accessToken}` },
          allowed_tools: ["list_disputes", "get_dispute", "list_product", "show_product_details"],
        }];
      }
      const upstream = await fetch(cfg.STUDIO_LLM_URL, {
        method: "POST", signal: AbortSignal.timeout(120_000), body: JSON.stringify(body),
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.STUDIO_LLM_API_KEY}`, accept: req.header("accept") ?? "application/json" },
      });
      res.status(upstream.status);
      const ct = upstream.headers.get("content-type"); if (ct) res.setHeader("content-type", ct);
      if (!upstream.body) return res.end();
      Readable.fromWeb(upstream.body as any).pipe(res);   // stream SSE straight through
    } catch (err) {
      console.error("studio llm proxy failed", err);
      if (!res.headersSent) res.status(502).json({ error: "The language model endpoint could not be reached." });
    }
  });

  // The built Studio app (npm run build:web). Static files only: every data call it makes needs the admin token.
  const studioDir = fileURLToPath(new URL("../../web/dist", import.meta.url));
  if (existsSync(studioDir)) app.use("/studio", express.static(studioDir));
  else app.get("/studio", (_req, res) => res.status(404).type("text").send("Studio is not built. Run: npm run build:web"));

  return app;
}