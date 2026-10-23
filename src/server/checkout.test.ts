import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { openDb } from "../db/index.js";
import { buildMandate, buyFromRequest, cartFor, newAgent, newUser, signFor } from "../agent/buyer.js";
import { signCart, signMandate } from "../mandate/sign.js";
import { signControl, type ControlAction, type ControlRequest } from "../mandate/control.js";
import { getMandateUsage, linkPaymentToken, registerAgentKey, registerUserKey, reserveMandateUse } from "../repo.js";
import type { DisputesApi } from "../paypal/disputes.js";
import { createApp } from "./app.js";

const MERCHANT = "warrant-demo-merchant";
const cfg = {
  PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", DATABASE_PATH: ":memory:", PORT: 0, APP_URL: "http://localhost",
  ADMIN_TOKEN: "admin", ANTHROPIC_MODEL: "m", GEMINI_MODEL: "g", ENFORCE_MANDATE: false, MERCHANT_ID: MERCHANT, ELASTIC_INDEX: "i",
  CHECKOUT_HOLD_MINUTES: 30,
} as Config;
const noDisputes: DisputesApi = { get: async () => ({}) as any, provideEvidence: async () => {}, makeOffer: async () => {}, acceptClaim: async () => {} };

let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base: string;
let orders = 0;
let charges: { body: any; requestId?: string }[] = [];
let failCharge = false;
let channel3Down = false;
let chargeThrows = false;
let chargeDelay = 0;
let channel3Products: any[] = [];
const realFetch = globalThis.fetch;

async function setup(config: Config = cfg) {
  const db = openDb();
  const user = newUser("u1"), agent = newAgent("agent-1", "u1");
  registerUserKey(db, user.userId, user.publicKeyPem);
  registerAgentKey(db, agent.agentId, agent.publicKeyPem);
  server = createApp(config, db, { disputes: noDisputes }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { db, user, agent };
}

const post = (body: unknown) => realFetch(`${base}/api/checkout`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json() as any }));

beforeEach(() => {
  orders = 0;
  charges = [];
  failCharge = false;
  channel3Down = false;
  chargeThrows = false;
  chargeDelay = 0;
  channel3Products = [];
  // Only PayPal is faked. Requests to the local test server go through untouched.
  vi.stubGlobal("fetch", (url: string, init?: any) => {
    if (String(url).startsWith("https://channel3.test")) {
      if (channel3Down) return Promise.resolve(new Response("{}", { status: 503 }));
      return Promise.resolve(new Response(JSON.stringify({ products: channel3Products }), { status: 200 }));
    }
    if (!String(url).startsWith("https://api-m.sandbox.paypal.com")) return realFetch(url, init);
    const json = (o: unknown) => Promise.resolve(new Response(JSON.stringify(o), { status: 200 }));
    if (String(url).includes("/oauth2/token")) return json({ access_token: "t", expires_in: 3600 });
    const sent = init?.body ? JSON.parse(init.body) : undefined;
    if (sent?.payment_source?.token) {
      charges.push({ body: sent, requestId: init.headers["PayPal-Request-Id"] });
      if (chargeThrows) return Promise.reject(new TypeError("fetch failed"));
      if (chargeDelay) { const n = charges.length; return new Promise(r => setTimeout(r, chargeDelay)).then(() => json({ id: `CHARGE-${n}`, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: `CAP-${n}`, status: "COMPLETED" }] } }] })); }
      if (failCharge) return Promise.resolve(new Response(JSON.stringify({ name: "UNPROCESSABLE_ENTITY" }), { status: 422 }));
      return json({ id: `CHARGE-${charges.length}`, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: `CAP-${charges.length}`, status: "COMPLETED" }] } }] });
    }
    orders++;
    return json({ id: `ORDER-${orders}`, status: "CREATED", links: [{ rel: "payer-action", href: "https://pay.example/approve", method: "GET" }] });
  });
});
afterEach(() => { vi.unstubAllGlobals(); server?.close(); });

describe("POST /api/checkout authorization", () => {
  const purchase = { amountCents: 11500, category: "footwear", description: "test" };

  it("creates an order when the user signed the mandate and the agent signed the cart", async () => {
    const { user, agent } = await setup();
    const sm = signFor(user, buildMandate(agent, MERCHANT));
    const r = await post({ signedMandate: sm, signedCart: cartFor(agent, sm, { merchantId: MERCHANT, amountCents: 11500, category: "footwear" }), purchase });
    expect(r.status).toBe(201);
    expect(r.body.findings).toEqual([]);
  });

  it("refuses a mandate the agent signed itself, even with a valid cart", async () => {
    const { agent } = await setup();
    const forged = signMandate(buildMandate(agent, MERCHANT), agent.privateKeyPem);
    const r = await post({ signedMandate: forged, signedCart: cartFor(agent, forged, { merchantId: MERCHANT, amountCents: 11500, category: "footwear" }), purchase });
    expect(r.status).toBe(400);
    expect(r.body.checks.mandateSignedByUser).toBe(false);
    expect(orders).toBe(0);
  });

  it("refuses a mandate from a user with no registered key", async () => {
    const { agent } = await setup();
    const stranger = newUser("stranger");
    const m = { ...buildMandate(agent, MERCHANT), userId: "stranger" };
    const sm = signFor(stranger, m);
    const r = await post({ signedMandate: sm, signedCart: cartFor(agent, sm, { merchantId: MERCHANT, amountCents: 11500, category: "footwear" }), purchase });
    expect(r.status).toBe(400);
    expect(r.body.problems.join(" ")).toContain("No key is registered for user stranger");
  });

  it("refuses a request with no signed cart", async () => {
    const { user, agent } = await setup();
    const r = await post({ signedMandate: signFor(user, buildMandate(agent, MERCHANT)), purchase });
    expect(r.status).toBe(400);
  });

  it("refuses a cart that does not match the purchase being requested", async () => {
    const { user, agent } = await setup();
    const sm = signFor(user, buildMandate(agent, MERCHANT));
    const cart = cartFor(agent, sm, { merchantId: MERCHANT, amountCents: 9500, category: "footwear" });
    const r = await post({ signedMandate: sm, signedCart: cart, purchase: { ...purchase, amountCents: 13500 } });
    expect(r.status).toBe(400);
    expect(r.body.checks.cartMatchesPurchase).toBe(false);
  });

  it("refuses a cart signed by a key that is not the agent's", async () => {
    const { user, agent } = await setup();
    const sm = signFor(user, buildMandate(agent, MERCHANT));
    const real = cartFor(agent, sm, { merchantId: MERCHANT, amountCents: 11500, category: "footwear" });
    const r = await post({ signedMandate: sm, signedCart: signCart(real.cart, newAgent().privateKeyPem), purchase });
    expect(r.status).toBe(400);
    expect(r.body.checks.cartSignedByAgent).toBe(false);
  });

  it("accepts each signed cart once: replaying it is a 409 and creates no second order", async () => {
    const { user, agent } = await setup();
    const sm = signFor(user, buildMandate(agent, MERCHANT));
    const body = { signedMandate: sm, signedCart: cartFor(agent, sm, { merchantId: MERCHANT, amountCents: 11500, category: "footwear" }), purchase };
    expect((await post(body)).status).toBe(201);
    expect((await post(body)).status).toBe(409);
    expect(orders).toBe(1);
  });

  it("still records (not refuses) an over-limit purchase that is properly signed", async () => {
    const { user, agent } = await setup();
    const sm = signFor(user, buildMandate(agent, MERCHANT));
    const r = await post({ signedMandate: sm, signedCart: cartFor(agent, sm, { merchantId: MERCHANT, amountCents: 13500, category: "footwear" }), purchase: { ...purchase, amountCents: 13500 } });
    expect(r.status).toBe(201);
    expect(r.body.findings.map((f: any) => f.code)).toEqual(["AMOUNT_EXCEEDS_MAX"]);
  });

  it("enforces the mandate when ENFORCE_MANDATE is enabled", async () => {
    const { user, agent } = await setup({ ...cfg, ENFORCE_MANDATE: true });
    const sm = signFor(user, buildMandate(agent, MERCHANT));
    const r = await post({
      signedMandate: sm,
      signedCart: cartFor(agent, sm, { merchantId: MERCHANT, amountCents: 13500, category: "footwear" }),
      purchase: { ...purchase, amountCents: 13500 },
    });
    expect(r.status).toBe(422);
    expect(r.body.findings.map((f: any) => f.code)).toEqual(["AMOUNT_EXCEEDS_MAX"]);
    expect(orders).toBe(0);
  });
});

describe("POST /api/checkout autonomous mode", () => {
  const purchase = { amountCents: 11500, category: "footwear", description: "test" };
  const signed = (user: ReturnType<typeof newUser>, agent: ReturnType<typeof newAgent>, amountCents = 11500) => {
    const sm = signFor(user, buildMandate(agent, MERCHANT));
    return { sm, cart: cartFor(agent, sm, { merchantId: MERCHANT, amountCents, category: "footwear" }) };
  };

  it("charges the saved account with no approval link and records the capture", async () => {
    const { db, user, agent } = await setup();
    linkPaymentToken(db, user.userId, "TOK-1");
    const { sm, cart } = signed(user, agent);
    const r = await post({ signedMandate: sm, signedCart: cart, purchase, mode: "autonomous" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ orderId: "CHARGE-1", captureId: "CAP-1", status: "CAPTURED" });
    expect(r.body.approveUrl).toBeUndefined();
    expect(charges[0].body.payment_source.token).toEqual({ id: "TOK-1", type: "PAYMENT_METHOD_TOKEN" });
    expect(charges[0].requestId).toBe(`charge-${cart.cart.cartId}`);
    expect(db.prepare("SELECT status, paypal_capture_id, cart_id FROM orders").get()).toEqual({ status: "CAPTURED", paypal_capture_id: "CAP-1", cart_id: cart.cart.cartId });
  });

  it("refuses when the user has no linked payment method, and charges nothing", async () => {
    const { user, agent } = await setup();
    const { sm, cart } = signed(user, agent);
    const r = await post({ signedMandate: sm, signedCart: cart, purchase, mode: "autonomous" });
    expect(r.status).toBe(409);
    expect(charges).toHaveLength(0);
  });

  it("refuses an out-of-mandate purchase even though ENFORCE_MANDATE is off", async () => {
    const { db, user, agent } = await setup();
    linkPaymentToken(db, user.userId, "TOK-1");
    const { sm, cart } = signed(user, agent, 13500);
    const r = await post({ signedMandate: sm, signedCart: cart, purchase: { ...purchase, amountCents: 13500 }, mode: "autonomous" });
    expect(r.status).toBe(422);
    expect(r.body.findings.map((f: any) => f.code)).toEqual(["AMOUNT_EXCEEDS_MAX"]);
    expect(charges).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) c FROM orders").get()).toEqual({ c: 0 });
  });

  it("does not charge when the authorization signatures fail", async () => {
    const { db, user, agent } = await setup();
    linkPaymentToken(db, user.userId, "TOK-1");
    const forged = signMandate(buildMandate(agent, MERCHANT), agent.privateKeyPem);
    const cart = cartFor(agent, forged, { merchantId: MERCHANT, amountCents: 11500, category: "footwear" });
    const r = await post({ signedMandate: forged, signedCart: cart, purchase, mode: "autonomous" });
    expect(r.status).toBe(400);
    expect(charges).toHaveLength(0);
  });

  it("charges once: replaying the same signed cart is a 409 with no second charge", async () => {
    const { db, user, agent } = await setup();
    linkPaymentToken(db, user.userId, "TOK-1");
    const { sm, cart } = signed(user, agent);
    const body = { signedMandate: sm, signedCart: cart, purchase, mode: "autonomous" };
    expect((await post(body)).status).toBe(201);
    expect((await post(body)).status).toBe(409);
    expect(charges).toHaveLength(1);
  });

  it("returns 502 and records no order when PayPal refuses the charge, so the cart can be retried", async () => {
    const { db, user, agent } = await setup();
    linkPaymentToken(db, user.userId, "TOK-1");
    const { sm, cart } = signed(user, agent);
    const body = { signedMandate: sm, signedCart: cart, purchase, mode: "autonomous" };
    failCharge = true;
    const r = await post(body);
    expect(r.status).toBe(502);
    expect(db.prepare("SELECT COUNT(*) c FROM orders").get()).toEqual({ c: 0 });
    failCharge = false;
    expect((await post(body)).status).toBe(201);
  });

  it("cannot link a payment method to a user with no registered key", async () => {
    await setup();
    const r = await realFetch(`${base}/api/users/payment-token`, {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": "admin" },
      body: JSON.stringify({ userId: "nobody", tokenId: "TOK-9" }),
    });
    expect(r.status).toBe(409);
  });
});

describe("natural-language request -> Channel3 -> autonomous checkout", () => {
  const c3cfg = { ...cfg, CHANNEL3_URL: "https://channel3.test", CHANNEL3_API_KEY: "k" } as Config;
  const offer = (id: string, title: string, price: number) => ({ id, title, offers: [{ domain: "shop.example", price: { price, currency: "USD" } }] });

  it("searches Channel3, signs the mandate and cart, charges the saved account and records the capture", async () => {
    const { db, user, agent } = await setup(c3cfg);
    linkPaymentToken(db, user.userId, "TOK-1");
    channel3Products = [offer("p-1", "Ridge Trail Shoe", 99), offer("p-2", "Pricey Trail Shoe", 180)];
    const r = await buyFromRequest(base, "Buy trail running shoes under $120", { user, agent, merchantId: MERCHANT }, "autonomous");
    expect(r.catalogSource).toBe("channel3");
    expect(r.fallbackReason).toBeUndefined();
    expect(r.plan?.product.id).toBe("p-1");
    expect(r.response?.status).toBe(201);
    expect(r.response?.body).toMatchObject({ orderId: "CHARGE-1", captureId: "CAP-1", status: "CAPTURED" });
    expect(r.response?.body.approveUrl).toBeUndefined();
    expect(charges).toHaveLength(1);
    expect(charges[0].body.purchase_units[0].amount.value).toBe("99.00");
    expect(db.prepare("SELECT status, paypal_capture_id FROM orders").get()).toEqual({ status: "CAPTURED", paypal_capture_id: "CAP-1" });
  });

  it("falls back to the local catalog visibly when Channel3 fails", async () => {
    const { db, user, agent } = await setup(c3cfg);
    linkPaymentToken(db, user.userId, "TOK-1");
    channel3Down = true;
    const r = await buyFromRequest(base, "Buy trail running shoes under $120", { user, agent, merchantId: MERCHANT }, "autonomous");
    expect(r.catalogSource).toBe("local fallback");
    expect(r.fallbackReason).toBeTruthy();
    expect(r.plan?.product.id).toBe("trail-a");
    expect(r.response?.status).toBe(201);
  });

  it("falls back visibly when Channel3 is not configured", async () => {
    const { db, user, agent } = await setup();
    linkPaymentToken(db, user.userId, "TOK-1");
    const r = await buyFromRequest(base, "Buy trail running shoes under $120", { user, agent, merchantId: MERCHANT }, "autonomous");
    expect(r.catalogSource).toBe("local fallback");
    expect(r.fallbackReason).toContain("not_configured");
  });

  it("rejects an over-budget request before anything is signed or charged", async () => {
    const { db, user, agent } = await setup();
    linkPaymentToken(db, user.userId, "TOK-1");
    const r = await buyFromRequest(base, "Buy trail running shoes under $50", { user, agent, merchantId: MERCHANT }, "autonomous");
    expect(r.planError).toContain("No product matched");
    expect(r.response).toBeUndefined();
    expect(charges).toHaveLength(0);
  });

  it("rejects a request with no budget before anything is sent", async () => {
    const { user, agent } = await setup();
    const r = await buyFromRequest(base, "Buy trail running shoes", { user, agent, merchantId: MERCHANT }, "autonomous");
    expect(r.planError).toContain("maximum amount");
    expect(r.response).toBeUndefined();
  });

  it("rejects a wrong-category purchase at the server with 422 and no charge", async () => {
    const { db, user, agent } = await setup();
    linkPaymentToken(db, user.userId, "TOK-1");
    const sm = signFor(user, buildMandate(agent, MERCHANT));
    const cart = cartFor(agent, sm, { merchantId: MERCHANT, amountCents: 11500, category: "electronics" });
    const r = await post({ signedMandate: sm, signedCart: cart, purchase: { amountCents: 11500, category: "electronics" }, mode: "autonomous" });
    expect(r.status).toBe(422);
    expect(r.body.findings.map((f: any) => f.code)).toEqual(["CATEGORY_NOT_ALLOWED"]);
    expect(charges).toHaveLength(0);
  });

  it("suggests in-mandate Channel3 alternatives alongside a category refusal", async () => {
    const { db, user, agent } = await setup({ ...cfg, CHANNEL3_URL: "https://channel3.test", CHANNEL3_API_KEY: "k" } as Config);
    linkPaymentToken(db, user.userId, "TOK-1");
    channel3Products = [{ id: "p-1", title: "Ridge Trail Shoe", offers: [{ domain: "shoes.test", price: { price: 89, currency: "USD" } }] }];
    const sm = signFor(user, buildMandate(agent, MERCHANT));                             // mandate: footwear, max $120
    const cart = cartFor(agent, sm, { merchantId: MERCHANT, amountCents: 11500, category: "electronics" });
    const r = await post({ signedMandate: sm, signedCart: cart, purchase: { amountCents: 11500, category: "electronics" }, mode: "autonomous" });
    expect(r.status).toBe(422);
    expect(r.body.alternatives).toEqual([expect.objectContaining({ id: "p-1", amountCents: 8900, source: "channel3" })]);
    expect(charges).toHaveLength(0);
  });

  it("omits alternatives when Channel3 is not configured", async () => {
    const { db, user, agent } = await setup();
    linkPaymentToken(db, user.userId, "TOK-1");
    const sm = signFor(user, buildMandate(agent, MERCHANT));
    const cart = cartFor(agent, sm, { merchantId: MERCHANT, amountCents: 11500, category: "electronics" });
    const r = await post({ signedMandate: sm, signedCart: cart, purchase: { amountCents: 11500, category: "electronics" }, mode: "autonomous" });
    expect(r.status).toBe(422);
    expect(r.body.alternatives).toBeUndefined();
  });

  it("refuses without a linked payment method and charges nothing", async () => {
    const { user, agent } = await setup();
    const r = await buyFromRequest(base, "Buy trail running shoes under $120", { user, agent, merchantId: MERCHANT }, "autonomous");
    expect(r.response?.status).toBe(409);
    expect(charges).toHaveLength(0);
  });
});

describe("autonomous mandate budget: cumulative limits, single use, reservation", () => {
  const codes = (r: { body: any }) => (r.body.findings ?? []).map((f: any) => f.code);
  const prep = async (limits: { maxTotalAmountCents?: number; maxPurchases?: number; requireApprovalAboveCents?: number } = {}) => {
    const s = await setup();
    linkPaymentToken(s.db, s.user.userId, "TOK-1");
    const sm = signFor(s.user, buildMandate(s.agent, MERCHANT, new Date(), limits));
    const buy = (amountCents: number, mode: "autonomous" | "approve" = "autonomous", cart = cartFor(s.agent, sm, { merchantId: MERCHANT, amountCents, category: "footwear" })) =>
      post({ signedMandate: sm, signedCart: cart, purchase: { amountCents, category: "footwear" }, mode }).then(r => ({ ...r, cart }));
    return { ...s, sm, buy };
  };

  it("is single-use by default: a second cart under the same mandate is refused before charging", async () => {
    const { buy } = await prep();
    expect((await buy(9500)).status).toBe(201);
    const second = await buy(9500);
    expect(second.status).toBe(422);
    expect(codes(second)).toEqual(["PURCHASE_COUNT_EXCEEDED"]);
    expect(second.body.findings[0].message).toContain("single-use");
    expect(charges).toHaveLength(1);
  });

  it("enforces the purchase-count limit the user signed", async () => {
    const { buy } = await prep({ maxPurchases: 2, maxTotalAmountCents: 20000 });
    expect((await buy(9500)).status).toBe(201);
    expect((await buy(9500)).status).toBe(201);
    const third = await buy(1000);
    expect(third.status).toBe(422);
    expect(codes(third)).toEqual(["PURCHASE_COUNT_EXCEEDED"]);
    expect(charges).toHaveLength(2);
  });

  it("enforces the cumulative amount limit and reports the remaining budget", async () => {
    const { buy } = await prep({ maxPurchases: 5, maxTotalAmountCents: 15000 });
    const first = await buy(9500);
    expect(first.body.mandateUsage).toEqual({ spentAmountCents: 9500, purchaseCount: 1, remainingTotalCents: 5500 });
    const over = await buy(9500);
    expect(over.status).toBe(422);
    expect(codes(over)).toEqual(["CUMULATIVE_AMOUNT_EXCEEDED"]);
    expect(charges).toHaveLength(1);
    expect((await buy(5000)).status).toBe(201);          // a smaller purchase still fits
    expect(charges).toHaveLength(2);
  });

  it("does not let the agent raise a cumulative limit: editing the signed mandate breaks the signature", async () => {
    const { user, agent } = await setup();
    const sm = signFor(user, buildMandate(agent, MERCHANT, new Date(), { maxTotalAmountCents: 12000, maxPurchases: 1 }));
    const widened = { ...sm, mandate: { ...sm.mandate, maxTotalAmountCents: 999999, maxPurchases: 50 } };
    const r = await post({ signedMandate: widened, signedCart: cartFor(agent, widened, { merchantId: MERCHANT, amountCents: 11500, category: "footwear" }), purchase: { amountCents: 11500, category: "footwear" }, mode: "autonomous" });
    expect(r.status).toBe(400);
    expect(charges).toHaveLength(0);
  });

  it("a refused PayPal charge does not consume budget", async () => {
    const { db, sm, buy } = await prep();
    failCharge = true;
    const refused = await buy(9500);
    expect(refused.status).toBe(502);
    expect(refused.body.outcome).toBe("REFUSED");
    expect(getMandateUsage(db, sm.mandate.id)).toEqual({ spentAmountCents: 0, purchaseCount: 0 });
    failCharge = false;
    expect((await buy(9500)).status).toBe(201);          // a different cart can use the freed budget
    expect(getMandateUsage(db, sm.mandate.id)).toEqual({ spentAmountCents: 9500, purchaseCount: 1 });
  });

  it("a successful charge consumes budget exactly once, even if the same cart is replayed", async () => {
    const { db, sm, buy } = await prep({ maxPurchases: 3, maxTotalAmountCents: 30000 });
    const first = await buy(9500);
    expect(first.status).toBe(201);
    expect((await buy(9500, "autonomous", first.cart)).status).toBe(409);
    expect(getMandateUsage(db, sm.mandate.id)).toEqual({ spentAmountCents: 9500, purchaseCount: 1 });
    expect(charges).toHaveLength(1);
    expect(db.prepare("SELECT status, order_id, capture_id FROM mandate_uses").get()).toEqual({ status: "CAPTURED", order_id: 1, capture_id: "CAP-1" });
  });

  it("two simultaneous requests on one single-use mandate charge only once", async () => {
    const { buy } = await prep();
    chargeDelay = 40;
    const [a, b] = await Promise.all([buy(9500), buy(9500)]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    expect(charges).toHaveLength(1);
  });

  it("two simultaneous requests for the same cart charge only once", async () => {
    const { buy, sm, agent } = await prep({ maxPurchases: 5 });
    const cart = cartFor(agent, sm, { merchantId: MERCHANT, amountCents: 9500, category: "footwear" });
    chargeDelay = 40;
    const [a, b] = await Promise.all([buy(9500, "autonomous", cart), buy(9500, "autonomous", cart)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(charges).toHaveLength(1);
  });

  it("an unknown PayPal outcome keeps the budget held, is listed for reconciliation, and resolves on retry with the same key", async () => {
    const { db, sm, buy } = await prep();
    chargeThrows = true;
    const first = await buy(9500);
    expect(first.status).toBe(502);
    expect(first.body.outcome).toBe("UNKNOWN");
    expect(getMandateUsage(db, sm.mandate.id)).toEqual({ spentAmountCents: 9500, purchaseCount: 1 });
    expect((await buy(9500)).status).toBe(422);                       // a new cart cannot spend the held budget
    const list = await realFetch(`${base}/api/mandate-uses?status=UNKNOWN`, { headers: { "x-admin-token": "admin" } }).then(r => r.json()) as any[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "UNKNOWN", amountCents: 9500 });

    chargeThrows = false;
    const retry = await buy(9500, "autonomous", first.cart);          // same cart: resumes
    expect(retry.status).toBe(201);
    expect(charges[1].requestId).toBe(charges[0].requestId);           // same idempotency key, so PayPal cannot charge twice
    expect(getMandateUsage(db, sm.mandate.id)).toEqual({ spentAmountCents: 9500, purchaseCount: 1 });
  });

  it("after a crash that left a reservation behind, a retry reuses the idempotency key and does not double count", async () => {
    const { db, sm, buy, agent } = await prep();
    const cart = cartFor(agent, sm, { merchantId: MERCHANT, amountCents: 9500, category: "footwear" });
    // Simulate: the process reserved budget, then died before hearing from PayPal.
    expect(reserveMandateUse(db, sm.mandate, cart.cart.cartId, 9500)).toEqual({ ok: true, resumed: false });
    expect((await buy(9500)).status).toBe(422);                       // someone else's cart is blocked meanwhile
    const retry = await buy(9500, "autonomous", cart);
    expect(retry.status).toBe(201);
    expect(charges).toHaveLength(1);
    expect(charges[0].requestId).toBe(`charge-${cart.cart.cartId}`);
    expect(getMandateUsage(db, sm.mandate.id)).toEqual({ spentAmountCents: 9500, purchaseCount: 1 });
  });

  it("leaves approval mode unchanged: several approval-based purchases under one mandate are still allowed", async () => {
    const { buy } = await prep({ maxPurchases: 1, maxTotalAmountCents: 10000 });
    expect((await buy(9500, "approve")).status).toBe(201);
    expect((await buy(9500, "approve")).status).toBe(201);
    expect(charges).toHaveLength(0);
  });
});

describe("POST /api/checkout autonomous hold (requireApprovalAboveCents)", () => {
  const postJson = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    realFetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
      .then(async r => ({ status: r.status, body: await r.json() as any }));
  const control = (user: ReturnType<typeof newUser>, action: ControlAction, subjectId: string, over: Partial<ControlRequest> = {}) => ({
    signedControl: signControl({ action, userId: user.userId, subjectId, issuedAt: new Date().toISOString(), nonce: randomUUID(), ...over }, user.privateKeyPem),
  });
  const admin = { "x-admin-token": "admin" };

  const prep = async (requireApprovalAboveCents = 10000) => {
    const s = await setup();
    linkPaymentToken(s.db, s.user.userId, "TOK-1");
    const sm = signFor(s.user, buildMandate(s.agent, MERCHANT, new Date(), { maxTotalAmountCents: 30000, maxPurchases: 3, requireApprovalAboveCents }));
    const cart = cartFor(s.agent, sm, { merchantId: MERCHANT, amountCents: 11500, category: "footwear" });
    const buy = () => post({ signedMandate: sm, signedCart: cart, purchase: { amountCents: 11500, category: "footwear" }, mode: "autonomous" });
    const approve = (extra: Partial<ControlRequest> = {}) => postJson(`/api/checkouts/${cart.cart.cartId}/approve`, control(s.user, "approve_checkout", cart.cart.cartId, extra));
    const decline = (extra: Partial<ControlRequest> = {}) => postJson(`/api/checkouts/${cart.cart.cartId}/decline`, control(s.user, "decline_checkout", cart.cart.cartId, extra));
    return { ...s, sm, cart, buy, approve, decline };
  };

  it("holds an over-threshold purchase instead of charging, with budget already reserved", async () => {
    const { db, sm, cart, buy } = await prep();
    const r = await buy();
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: "PENDING_APPROVAL", cartId: cart.cart.cartId, amountCents: 11500, thresholdCents: 10000 });
    expect(charges).toHaveLength(0);
    expect(db.prepare("SELECT status FROM mandate_uses WHERE cart_id = ?").get(cart.cart.cartId)).toEqual({ status: "RESERVED" });
    expect(db.prepare("SELECT status FROM checkout_holds WHERE cart_id = ?").get(cart.cart.cartId)).toEqual({ status: "PENDING" });
    expect(getMandateUsage(db, sm.mandate.id)).toEqual({ spentAmountCents: 11500, purchaseCount: 1 }); // held, so it counts against the budget already
  });

  it("does not hold a purchase at or under the threshold", async () => {
    const { buy } = await prep(11500);
    expect((await buy()).status).toBe(201);
    expect(charges).toHaveLength(1);
  });

  it("charges only once the user approves it, with their own signature", async () => {
    const { db, cart, buy, approve } = await prep();
    expect((await buy()).status).toBe(202);
    const r = await approve();
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "CAPTURED", orderId: "CHARGE-1", captureId: "CAP-1" });
    expect(charges).toHaveLength(1);
    expect(charges[0].requestId).toBe(`charge-${cart.cart.cartId}`);
    expect(db.prepare("SELECT status FROM checkout_holds WHERE cart_id = ?").get(cart.cart.cartId)).toEqual({ status: "APPROVED" });
    expect(db.prepare("SELECT status FROM mandate_uses WHERE cart_id = ?").get(cart.cart.cartId)).toEqual({ status: "CAPTURED" });
  });

  it("reopens the hold for retry if PayPal refuses the charge on approval, instead of leaving it stuck APPROVED", async () => {
    const { db, sm, cart, buy, approve } = await prep();
    expect((await buy()).status).toBe(202);
    failCharge = true;
    const refused = await approve();
    expect(refused.status).toBe(502);
    expect(refused.body.outcome).toBe("REFUSED");
    expect(db.prepare("SELECT status FROM checkout_holds WHERE cart_id = ?").get(cart.cart.cartId)).toEqual({ status: "PENDING" });
    expect(getMandateUsage(db, sm.mandate.id)).toEqual({ spentAmountCents: 0, purchaseCount: 0 }); // released, not stuck held
    failCharge = false;
    const retried = await approve();                 // the hold is PENDING again, so approving it is accepted
    expect(retried.status).toBe(201);
    expect(retried.body).toMatchObject({ status: "CAPTURED" });
    expect(db.prepare("SELECT status FROM checkout_holds WHERE cart_id = ?").get(cart.cart.cartId)).toEqual({ status: "APPROVED" });
    expect(charges).toHaveLength(2); // the refused attempt, then the successful retry
  });

  it("reopens the hold if PayPal's outcome is unknown on approval, and the retry reuses the same idempotency key", async () => {
    const { db, sm, cart, buy, approve } = await prep();
    expect((await buy()).status).toBe(202);
    chargeThrows = true;
    const unknown = await approve();
    expect(unknown.status).toBe(502);
    expect(unknown.body.outcome).toBe("UNKNOWN");
    expect(db.prepare("SELECT status FROM checkout_holds WHERE cart_id = ?").get(cart.cart.cartId)).toEqual({ status: "PENDING" });
    expect(getMandateUsage(db, sm.mandate.id)).toEqual({ spentAmountCents: 11500, purchaseCount: 1 }); // stays held, not released
    chargeThrows = false;
    const retried = await approve();
    expect(retried.status).toBe(201);
    expect(charges).toHaveLength(2);
    expect(charges[1].requestId).toBe(charges[0].requestId); // same idempotency key, so PayPal cannot charge twice
  });

  it("declining after a reopened (refused) hold still works", async () => {
    const { db, sm, cart, buy, approve, decline } = await prep();
    expect((await buy()).status).toBe(202);
    failCharge = true;
    await approve();
    failCharge = false;
    const declined = await decline();
    expect(declined.status).toBe(200);
    expect(getMandateUsage(db, sm.mandate.id)).toEqual({ spentAmountCents: 0, purchaseCount: 0 });
    expect(charges).toHaveLength(1); // the earlier refused attempt; declining makes no further PayPal call
  });

  it("refuses to approve with the admin token: only the user can release held money", async () => {
    const { buy, cart } = await prep();
    await buy();
    const r = await postJson(`/api/checkouts/${cart.cart.cartId}/approve`, {}, admin);
    expect(r.status).toBe(403);
    expect(charges).toHaveLength(0);
  });

  it("refuses to approve with someone else's signature", async () => {
    const { db, user, buy, cart } = await prep();
    await buy();
    const mallory = newUser("mallory");
    registerUserKey(db, mallory.userId, mallory.publicKeyPem);
    // Right user id and subject, but signed with the wrong (mallory's) key.
    const forged = { signedControl: signControl(
      { action: "approve_checkout", userId: user.userId, subjectId: cart.cart.cartId, issuedAt: new Date().toISOString(), nonce: randomUUID() },
      mallory.privateKeyPem,
    ) };
    const r = await postJson(`/api/checkouts/${cart.cart.cartId}/approve`, forged);
    expect(r.status).toBe(401);
    expect(charges).toHaveLength(0);
  });

  it("declining releases the held budget and charges nothing; the admin token may also decline", async () => {
    const { db, sm, buy, decline } = await prep();
    await buy();
    const r = await decline({ reason: "didn't mean to" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: "DECLINED" });
    expect(charges).toHaveLength(0);
    expect(getMandateUsage(db, sm.mandate.id)).toEqual({ spentAmountCents: 0, purchaseCount: 0 });
  });

  it("cannot approve or decline the same hold twice", async () => {
    const { buy, approve, decline } = await prep();
    await buy();
    expect((await approve()).status).toBe(201);
    expect((await decline()).status).toBe(409);
  });

  it("404s for a cart id with no held checkout", async () => {
    const { user } = await prep();
    const r = await postJson("/api/checkouts/no-such-cart/approve", control(user, "approve_checkout", "no-such-cart"));
    expect(r.status).toBe(404);
  });

  it("expires a hold whose window has passed, releasing its budget", async () => {
    const { db, sm, cart, buy, approve } = await prep();
    await buy();
    db.prepare("UPDATE checkout_holds SET expires_at = datetime('now', '-1 minute') WHERE cart_id = ?").run(cart.cart.cartId);
    const r = await approve();
    expect(r.status).toBe(409);
    expect(r.body.status).toBe("EXPIRED");
    expect(charges).toHaveLength(0);
    expect(getMandateUsage(db, sm.mandate.id)).toEqual({ spentAmountCents: 0, purchaseCount: 0 });
    expect(db.prepare("SELECT status FROM mandate_uses WHERE cart_id = ?").get(cart.cart.cartId)).toEqual({ status: "RELEASED" });
  });

  it("refuses to approve a hold for a mandate the user revoked while it was pending", async () => {
    const { db, user, sm, buy, approve } = await prep();
    await buy();
    const revoked = await postJson(`/api/mandates/${sm.mandate.id}/revoke`, control(user, "revoke_mandate", sm.mandate.id));
    expect(revoked.status).toBe(200);
    const r = await approve();
    expect(r.status).toBe(422);
    expect(r.body.findings.map((f: any) => f.code)).toContain("MANDATE_REVOKED");
    expect(charges).toHaveLength(0);
    expect(getMandateUsage(db, sm.mandate.id)).toEqual({ spentAmountCents: 0, purchaseCount: 0 });
  });

  it("refuses to approve a hold while the agent is paused, even though it was not paused when the hold was created", async () => {
    const { user, buy, approve } = await prep();
    await buy();
    const paused = await postJson(`/api/users/${user.userId}/pause-agent`, control(user, "pause_agent", user.userId));
    expect(paused.status).toBe(200);
    const r = await approve();
    expect(r.status).toBe(422);
    expect(r.body.findings.map((f: any) => f.code)).toContain("AGENT_PAUSED");
    expect(charges).toHaveLength(0);
  });

  it("lists pending holds for a user, and they disappear once resolved", async () => {
    const { db, user, cart, buy, decline } = await prep();
    await buy();
    const listed = await postJson(`/api/users/${user.userId}/holds`, control(user, "view_orders", user.userId));
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([expect.objectContaining({ cartId: cart.cart.cartId, status: "PENDING", amountCents: 11500 })]);
    await decline();
    const after = await postJson(`/api/users/${user.userId}/holds`, control(user, "view_orders", user.userId));
    expect(after.body).toEqual([]);
  });
});

describe("user controls: revocation, pause, payment revocation", () => {
  const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    realFetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
      .then(async r => ({ status: r.status, body: await r.json() as any }));
  const control = (user: ReturnType<typeof newUser>, action: ControlAction, subjectId: string, over: Partial<ControlRequest> = {}) => ({
    signedControl: signControl({ action, userId: user.userId, subjectId, issuedAt: new Date().toISOString(), nonce: randomUUID(), ...over }, user.privateKeyPem),
  });
  const admin = { "x-admin-token": "admin" };
  const codes = (r: { body: any }) => (r.body.findings ?? []).map((f: any) => f.code);

  const prep = async () => {
    const s = await setup();
    linkPaymentToken(s.db, s.user.userId, "TOK-1");
    const sm = signFor(s.user, buildMandate(s.agent, MERCHANT));
    const buy = () => post({ signedMandate: sm, signedCart: cartFor(s.agent, sm, { merchantId: MERCHANT, amountCents: 9500, category: "footwear" }),
      purchase: { amountCents: 9500, category: "footwear" }, mode: "autonomous" });
    const revoke = (extra: Partial<ControlRequest> = {}) => postJson(`/api/mandates/${sm.mandate.id}/revoke`, control(s.user, "revoke_mandate", sm.mandate.id, extra));
    const pause = (extra: Partial<ControlRequest> = {}) => postJson(`/api/users/${s.user.userId}/pause-agent`, control(s.user, "pause_agent", s.user.userId, extra));
    const resume = (extra: Partial<ControlRequest> = {}) => postJson(`/api/users/${s.user.userId}/resume-agent`, control(s.user, "resume_agent", s.user.userId, extra));
    return { ...s, sm, buy, revoke, pause, resume };
  };

  it("a revoked mandate cannot charge, takes effect immediately, and returns the reason", async () => {
    const { buy, revoke } = await prep();
    const r = await revoke({ reason: "changed my mind" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, alreadyRevoked: false, reason: "changed my mind", via: "user_signature" });
    const attempt = await buy();                                       // the very next request
    expect(attempt.status).toBe(422);
    expect(codes(attempt)).toEqual(["MANDATE_REVOKED"]);
    expect(attempt.body.findings[0].message).toContain("changed my mind");
    expect(charges).toHaveLength(0);
  });

  it("lets a user revoke a mandate Warrant has never seen, and refuses it when it is later presented", async () => {
    const { user, agent, db } = await setup();
    linkPaymentToken(db, user.userId, "TOK-1");
    const sm = signFor(user, buildMandate(agent, MERCHANT));
    expect((await postJson(`/api/mandates/${sm.mandate.id}/revoke`, control(user, "revoke_mandate", sm.mandate.id))).status).toBe(200);
    const r = await post({ signedMandate: sm, signedCart: cartFor(agent, sm, { merchantId: MERCHANT, amountCents: 9500, category: "footwear" }),
      purchase: { amountCents: 9500, category: "footwear" }, mode: "autonomous" });
    expect(r.status).toBe(422);
    expect(codes(r)).toEqual(["MANDATE_REVOKED"]);
  });

  it("does not let another user pre-revoke someone else's mandate", async () => {
    const { user, agent, db } = await setup();
    const mallory = newUser("mallory");
    registerUserKey(db, mallory.userId, mallory.publicKeyPem);
    linkPaymentToken(db, user.userId, "TOK-1");
    const sm = signFor(user, buildMandate(agent, MERCHANT));
    await postJson(`/api/mandates/${sm.mandate.id}/revoke`, control(mallory, "revoke_mandate", sm.mandate.id));
    const r = await post({ signedMandate: sm, signedCart: cartFor(agent, sm, { merchantId: MERCHANT, amountCents: 9500, category: "footwear" }),
      purchase: { amountCents: 9500, category: "footwear" }, mode: "autonomous" });
    expect(r.status).toBe(201);
  });

  it("refuses a revocation of a stored mandate by a different user", async () => {
    const { db, sm, buy } = await prep();
    const mallory = newUser("mallory");
    registerUserKey(db, mallory.userId, mallory.publicKeyPem);
    expect((await buy()).status).toBe(201);                            // this stores the mandate
    const r = await postJson(`/api/mandates/${sm.mandate.id}/revoke`, control(mallory, "revoke_mandate", sm.mandate.id));
    expect(r.status).toBe(403);
  });

  it("rejects bad signatures, wrong subjects, stale and future requests", async () => {
    const { sm, agent, user, revoke, pause } = await prep();
    const forged = { signedControl: signControl({ action: "revoke_mandate", userId: user.userId, subjectId: sm.mandate.id, issuedAt: new Date().toISOString(), nonce: randomUUID() }, agent.privateKeyPem) };
    expect((await postJson(`/api/mandates/${sm.mandate.id}/revoke`, forged)).status).toBe(401);
    expect((await postJson(`/api/mandates/${sm.mandate.id}/revoke`, {})).status).toBe(401);
    expect((await postJson(`/api/mandates/other-mandate/revoke`, control(user, "revoke_mandate", sm.mandate.id))).status).toBe(400);
    expect((await postJson(`/api/users/${user.userId}/pause-agent`, control(user, "revoke_mandate", user.userId))).status).toBe(400);
    expect((await revoke({ issuedAt: new Date(Date.now() - 3_600_000).toISOString() })).status).toBe(400);
    expect((await pause({ issuedAt: new Date(Date.now() + 3_600_000).toISOString() })).status).toBe(400);
  });

  it("accepts each signed request once", async () => {
    const { user, pause, resume } = await prep();
    const signed = control(user, "resume_agent", user.userId);
    expect((await pause()).status).toBe(200);
    expect((await postJson(`/api/users/${user.userId}/resume-agent`, signed)).status).toBe(200);
    expect((await pause()).status).toBe(200);
    expect((await postJson(`/api/users/${user.userId}/resume-agent`, signed)).status).toBe(409);   // replayed
    expect((await resume()).status).toBe(200);                                                      // a fresh one works
  });

  it("a paused user cannot be charged, with the reason returned; resuming allows it again", async () => {
    const { pause, resume, buy } = await prep();
    expect((await pause({ reason: "lost my phone" })).body).toMatchObject({ paused: true, alreadyPaused: false });
    const refused = await buy();
    expect(refused.status).toBe(422);
    expect(codes(refused)).toEqual(["AGENT_PAUSED"]);
    expect(refused.body.findings[0].message).toContain("lost my phone");
    expect(charges).toHaveLength(0);
    expect((await resume()).body).toMatchObject({ paused: false });
    expect((await buy()).status).toBe(201);                            // pausing consumed no budget
  });

  it("pausing twice and resuming when not paused are harmless", async () => {
    const { pause, resume } = await prep();
    expect((await resume()).body.alreadyActive).toBe(true);
    await pause();
    expect((await pause()).body.alreadyPaused).toBe(true);
  });

  it("the merchant admin can stop an agent but cannot turn it back on", async () => {
    const { user, db, buy } = await prep();
    expect((await postJson(`/api/users/${user.userId}/pause-agent`, { reason: "fraud review" }, admin)).body).toMatchObject({ paused: true, via: "admin" });
    expect((await buy()).status).toBe(422);
    expect((await postJson(`/api/users/${user.userId}/resume-agent`, {}, admin)).status).toBe(403);
    expect((await postJson(`/api/users/${user.userId}/resume-agent`, {}, { "x-admin-token": "wrong" })).status).toBe(401);
    expect(db.prepare("SELECT action, via FROM control_events ORDER BY id").all()).toEqual([{ action: "pause_agent", via: "admin" }]);
  });

  it("the admin can revoke a mandate Warrant knows, but not one it has never seen", async () => {
    const { sm, buy } = await prep();
    expect((await postJson(`/api/mandates/${sm.mandate.id}/revoke`, {}, admin)).status).toBe(404);   // never presented yet
    expect((await buy()).status).toBe(201);                                                          // now it is stored
    expect((await postJson(`/api/mandates/${sm.mandate.id}/revoke`, { reason: "dispute" }, admin)).body)
      .toMatchObject({ ok: true, via: "admin", reason: "dispute" });
  });

  it("revoking the payment authorization stops charges until the user links a payment method again", async () => {
    const { user, db, buy } = await prep();
    const r = await postJson(`/api/users/${user.userId}/revoke-payment`, control(user, "revoke_payment_authorization", user.userId));
    expect(r.body).toMatchObject({ ok: true, alreadyRevoked: false });
    const refused = await buy();
    expect(refused.status).toBe(422);
    expect(codes(refused)).toEqual(["PAYMENT_AUTHORIZATION_REVOKED"]);
    expect(charges).toHaveLength(0);
    linkPaymentToken(db, user.userId, "TOK-2");
    expect((await buy()).status).toBe(201);
    expect(charges[0].body.payment_source.token.id).toBe("TOK-2");
  });

  it("does not charge an expired payment authorization", async () => {
    const { user, db, buy } = await prep();
    linkPaymentToken(db, user.userId, "TOK-1", undefined, "2020-01-01T00:00:00.000Z");
    const refused = await buy();
    expect(refused.status).toBe(422);
    expect(codes(refused)).toEqual(["PAYMENT_AUTHORIZATION_EXPIRED"]);
    expect(charges).toHaveLength(0);
  });

  it("records every control action in the audit log", async () => {
    const { db, user, sm, revoke, pause, resume } = await prep();
    await pause({ reason: "r1" }); await resume(); await revoke({ reason: "r2" });
    const rows = db.prepare("SELECT user_id, action, subject_id, reason, via FROM control_events ORDER BY id").all();
    expect(rows).toEqual([
      { user_id: user.userId, action: "pause_agent", subject_id: user.userId, reason: "r1", via: "user_signature" },
      { user_id: user.userId, action: "resume_agent", subject_id: user.userId, reason: null, via: "user_signature" },
      { user_id: user.userId, action: "revoke_mandate", subject_id: sm.mandate.id, reason: "r2", via: "user_signature" },
    ]);
  });
});
