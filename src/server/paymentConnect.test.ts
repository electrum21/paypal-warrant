import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { openDb } from "../db/index.js";
import { newUser } from "../agent/buyer.js";
import { getPaymentAuthorization, registerUserKey } from "../repo.js";
import { createApp } from "./app.js";

const cfg = {
  PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", DATABASE_PATH: ":memory:", PORT: 0, APP_URL: "https://app.test",
  ADMIN_TOKEN: "admin", ANTHROPIC_MODEL: "m", GEMINI_MODEL: "g", ENFORCE_MANDATE: false, MERCHANT_ID: "warrant-demo-merchant",
  ELASTIC_INDEX: "i", AUTH_SESSION_HOURS: 24,
} as unknown as Config;

const realFetch = globalThis.fetch;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type SetupToken = { id: string; status: string; links: { rel: string; href: string; method?: string }[] };

/** What the fake /v3/vault/setup-tokens endpoint replies with. A lone `self` link is what an unprovisioned app returns. */
let setupTokenReply: SetupToken;
let setupRequests: { body: any }[] = [];

/** PayPal is faked; calls to the local test server go through untouched. */
function stubPayPal() {
  vi.stubGlobal("fetch", (url: string, init?: any) => {
    if (!String(url).startsWith("https://api-m.sandbox.paypal.com")) return realFetch(url, init);
    const json = (o: unknown) => Promise.resolve(new Response(JSON.stringify(o), { status: 200 }));
    if (String(url).includes("/oauth2/token")) return json({ access_token: "t", expires_in: 3600 });
    if (String(url).includes("/v3/vault/payment-tokens")) return json({ id: "PT-1", customer: { id: "CUST-1" } });
    setupRequests.push({ body: init?.body ? JSON.parse(init.body) : undefined });
    return json(setupTokenReply);
  });
}

/** Signs a user in the way /auth/paypal/callback would: a random token whose sha256 is stored server-side. */
function signIn(db: ReturnType<typeof openDb>, userId: string) {
  const token = randomUUID() + randomUUID();
  db.prepare("INSERT INTO auth_sessions (session_id_hash, user_id, email, display_name, expires_at) VALUES (?, ?, ?, ?, ?)")
    .run(hash(token), userId, "buyer@example.com", "Buyer", new Date(Date.now() + 3600_000).toISOString());
  return token;
}

function start(userId: string) {
  const db = openDb();
  const user = newUser(userId);
  registerUserKey(db, user.userId, user.publicKeyPem);
  const token = signIn(db, user.userId);
  const server = createApp(cfg, db, {}).listen(0);
  return { db, token, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const post = (base: string, token: string) => realFetch(`${base}/api/me/payment/start`, {
  method: "POST", headers: { cookie: `warrant_session=${token}`, "content-type": "application/json" }, body: "{}",
});

afterEach(() => {
  vi.unstubAllGlobals();
  setupRequests = [];
});



describe("POST /api/me/payment/start", () => {
  it("answers 502 with actionable diagnostics when PayPal returns a setup token with no payer-action link", async () => {
    // Reproduces the live sandbox failure: status CREATED, self link only, no payer session.
    setupTokenReply = { id: "SETUP-1", status: "CREATED", links: [{ rel: "self", href: "https://api-m.sandbox.paypal.com/v3/vault/setup-tokens/SETUP-1", method: "GET" }] };
    stubPayPal();
    const { db, token, server, base } = start("u1");
    try {
      const r = await post(base, token);
      const body = await r.json() as any;
      expect(r.status).toBe(502);
      expect(body).toMatchObject({ error: "PayPal did not return a payment approval link.", providerStatus: "CREATED", setupTokenId: "SETUP-1", expectedStatus: "PAYER_ACTION_REQUIRED" });
      expect(body.providerLinks.map((l: any) => l.rel)).toEqual(["self"]);
      // The response must tell the operator exactly which dashboard toggles to flip.
      expect(body.fix.join(" ")).toContain("Vault");
      expect(body.fix.join(" ")).toContain("Save PayPal and Venmo payment methods");
      // The request followed the Payment Method Tokens API shape (usage_type under paypal, no Orders-style attributes).
      expect(setupRequests[0].body.payment_source.paypal.usage_type).toBe("MERCHANT");
      expect(setupRequests[0].body.payment_source.paypal.attributes).toBeUndefined();
      expect(setupRequests[0].body.payment_source.paypal.experience_context.return_url).toContain("/paypal/payment-return?state=");
      // A session with no approvable token must not be persisted for the return leg to trip over.
      expect(db.prepare("SELECT COUNT(*) c FROM payment_setup_sessions").get()).toEqual({ c: 0 });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("returns the approve URL and stores the setup session when PayPal opens a payer session", async () => {
    setupTokenReply = { id: "SETUP-2", status: "PAYER_ACTION_REQUIRED", links: [
      { rel: "self", href: "https://api-m.sandbox.paypal.com/v3/vault/setup-tokens/SETUP-2", method: "GET" },
      { rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=SETUP-2", method: "GET" },
    ] };
    stubPayPal();
    const { db, token, server, base } = start("u2");
    try {
      const r = await post(base, token);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=SETUP-2" });
      const row = db.prepare("SELECT user_id, setup_token_id FROM payment_setup_sessions").get() as { user_id: string; setup_token_id: string };
      expect(row).toEqual({ user_id: "u2", setup_token_id: "SETUP-2" });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe("GET /paypal/payment-return", () => {
  const ret = (base: string, qs: string) => realFetch(`${base}/paypal/payment-return?${qs}`, { redirect: "manual" });
  const seed = (db: ReturnType<typeof openDb>, userId: string, state: string, setupTokenId: string) =>
    db.prepare("INSERT INTO payment_setup_sessions (state, user_id, setup_token_id, expires_at) VALUES (?, ?, ?, ?)")
      .run(state, userId, setupTokenId, new Date(Date.now() + 600_000).toISOString());

  it("links the saved payment method when PayPal returns the setup token as approval_token_id", async () => {
    stubPayPal();
    const { db, server, base } = start("u3");
    try {
      seed(db, "u3", "S1", "SETUP-3");
      const r = await ret(base, "state=S1&approval_token_id=SETUP-3&approval_session_id=SESSION-1");
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe("/user?payment=connected");
      expect(getPaymentAuthorization(db, "u3")).toMatchObject({ tokenId: "PT-1", status: "ACTIVE" });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("still accepts the older token query parameter", async () => {
    stubPayPal();
    const { db, server, base } = start("u4");
    try {
      seed(db, "u4", "S2", "SETUP-4");
      expect((await ret(base, "state=S2&token=SETUP-4")).status).toBe(302);
      expect(getPaymentAuthorization(db, "u4")?.tokenId).toBe("PT-1");
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("refuses a return whose setup token is not the one this session started", async () => {
    stubPayPal();
    const { db, server, base } = start("u5");
    try {
      seed(db, "u5", "S3", "SETUP-5");
      expect((await ret(base, "state=S3&approval_token_id=SOMEONE-ELSES")).status).toBe(400);
      expect(getPaymentAuthorization(db, "u5")).toBeUndefined();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
