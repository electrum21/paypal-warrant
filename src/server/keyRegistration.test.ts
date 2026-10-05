import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../db/index.js";
import { generateKeys } from "../mandate/sign.js";
import { getAgentKey, getAgentOwner, getUserKey, registerAgentKey } from "../repo.js";
import { createApp } from "./app.js";

const cfg = {
  PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", DATABASE_PATH: ":memory:", PORT: 0, APP_URL: "http://localhost",
  ADMIN_TOKEN: "admin-token-for-tests", AUTH_SESSION_HOURS: 24, ANTHROPIC_MODEL: "m", GEMINI_MODEL: "g", ENFORCE_MANDATE: false,
  MERCHANT_ID: "warrant-demo-merchant", ELASTIC_INDEX: "warrant-agent-events",
} as any;

let closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of closers) await c(); closers = []; });

/** Starts the app on a random port and returns a tiny client. `as(userId)` sends a real signed-in session cookie. */
function start() {
  const db: Db = openDb();
  const server = createApp(cfg, db).listen(0);
  closers.push(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sessions = new Map<string, string>();
  const signIn = (userId: string) => {
    let token = sessions.get(userId);
    if (!token) {
      token = randomUUID() + randomUUID();
      db.prepare("INSERT INTO auth_sessions (session_id_hash, user_id, email, display_name, expires_at) VALUES (?, ?, NULL, NULL, ?)")
        .run(createHash("sha256").update(token).digest("hex"), userId, new Date(Date.now() + 3600_000).toISOString());
      sessions.set(userId, token);
    }
    return token;
  };
  const post = (path: string, body: unknown, o: { as?: string; admin?: boolean } = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(o.as ? { cookie: `warrant_session=${signIn(o.as)}` } : {}),
        ...(o.admin ? { "x-admin-token": cfg.ADMIN_TOKEN } : {}),
      },
      body: JSON.stringify(body),
    });
  return { db, post };
}

describe("POST /api/me/public-key (user keys)", () => {
  it("refuses a caller who is not signed in, even for a brand-new user id", async () => {
    const { db, post } = start();
    const r = await post("/api/me/public-key", { userId: "paypal:NEW", publicKeyPem: generateKeys().publicKeyPem });
    expect(r.status).toBe(401);
    expect(getUserKey(db, "paypal:NEW")).toBeUndefined();
  });

  it("lets a signed-in user register their own key, repeat it harmlessly, and rotate it deliberately", async () => {
    const { db, post } = start();
    const k1 = generateKeys(), k2 = generateKeys();
    const body = { userId: "paypal:ME", publicKeyPem: k1.publicKeyPem };
    expect((await post("/api/me/public-key", body, { as: "paypal:ME" })).status).toBe(201);
    expect((await post("/api/me/public-key", body, { as: "paypal:ME" })).status).toBe(200);
    expect((await post("/api/me/public-key", { ...body, publicKeyPem: k2.publicKeyPem }, { as: "paypal:ME" })).status).toBe(409);
    expect(getUserKey(db, "paypal:ME")).toBe(k1.publicKeyPem);
    const rotated = await post("/api/me/public-key", { ...body, publicKeyPem: k2.publicKeyPem, replaceExisting: true }, { as: "paypal:ME" });
    expect(rotated.status).toBe(201);
    expect(getUserKey(db, "paypal:ME")).toBe(k2.publicKeyPem);
  });

  it("REGRESSION: an anonymous caller cannot replace another user's key, with or without replaceExisting", async () => {
    const { db, post } = start();
    const victim = generateKeys(), attacker = generateKeys();
    await post("/api/me/public-key", { userId: "paypal:VICTIM", publicKeyPem: victim.publicKeyPem }, { as: "paypal:VICTIM" });
    for (const replaceExisting of [false, true]) {
      const r = await post("/api/me/public-key", { userId: "paypal:VICTIM", publicKeyPem: attacker.publicKeyPem, replaceExisting });
      expect(r.status).toBe(401);
    }
    expect(getUserKey(db, "paypal:VICTIM")).toBe(victim.publicKeyPem);
  });

  it("REGRESSION: a different signed-in user cannot replace it either", async () => {
    const { db, post } = start();
    const victim = generateKeys(), attacker = generateKeys();
    await post("/api/me/public-key", { userId: "paypal:VICTIM", publicKeyPem: victim.publicKeyPem }, { as: "paypal:VICTIM" });
    const r = await post("/api/me/public-key", { userId: "paypal:VICTIM", publicKeyPem: attacker.publicKeyPem, replaceExisting: true }, { as: "paypal:ATTACKER" });
    expect(r.status).toBe(403);
    expect(getUserKey(db, "paypal:VICTIM")).toBe(victim.publicKeyPem);
  });

  it("rejects text that is not an Ed25519 public key", async () => {
    const { db, post } = start();
    expect((await post("/api/me/public-key", { userId: "paypal:ME", publicKeyPem: "demo-public-key" }, { as: "paypal:ME" })).status).toBe(400);
    expect(getUserKey(db, "paypal:ME")).toBeUndefined();
  });

  it("records every registration and replacement, as fingerprints, never as raw keys", async () => {
    const { db, post } = start();
    const k1 = generateKeys(), k2 = generateKeys();
    await post("/api/me/public-key", { userId: "paypal:ME", publicKeyPem: k1.publicKeyPem }, { as: "paypal:ME" });
    await post("/api/me/public-key", { userId: "paypal:ME", publicKeyPem: k2.publicKeyPem, replaceExisting: true }, { as: "paypal:ME" });
    const rows = db.prepare("SELECT kind, subject_id, actor, action, old_key_sha256, new_key_sha256 FROM key_changes ORDER BY id").all() as any[];
    expect(rows.map(r => r.action)).toEqual(["registered", "replaced"]);
    expect(rows[1]).toMatchObject({ kind: "user", subject_id: "paypal:ME", actor: "session:paypal:ME" });
    expect(rows[1].old_key_sha256).toBe(createHash("sha256").update(k1.publicKeyPem).digest("hex"));
    expect(JSON.stringify(rows)).not.toContain("BEGIN PUBLIC KEY");
  });
});

describe("POST /api/me/agent-key (agent keys)", () => {
  it("refuses a caller who is not signed in", async () => {
    const { db, post } = start();
    const r = await post("/api/me/agent-key", { agentId: "shopper", publicKeyPem: generateKeys().publicKeyPem });
    expect(r.status).toBe(401);
    expect(getAgentKey(db, "shopper")).toBeUndefined();
  });

  it("the first signed-in user to register an agent id owns it and may rotate its key", async () => {
    const { db, post } = start();
    const a1 = generateKeys(), a2 = generateKeys();
    expect((await post("/api/me/agent-key", { agentId: "shopper", publicKeyPem: a1.publicKeyPem }, { as: "paypal:OWNER" })).status).toBe(201);
    expect(getAgentOwner(db, "shopper")).toBe("paypal:OWNER");
    expect((await post("/api/me/agent-key", { agentId: "shopper", publicKeyPem: a2.publicKeyPem }, { as: "paypal:OWNER" })).status).toBe(409);
    expect((await post("/api/me/agent-key", { agentId: "shopper", publicKeyPem: a2.publicKeyPem, replaceExisting: true }, { as: "paypal:OWNER" })).status).toBe(201);
    expect(getAgentKey(db, "shopper")).toBe(a2.publicKeyPem);
    expect(getAgentOwner(db, "shopper")).toBe("paypal:OWNER");
  });

  it("REGRESSION: nobody else, signed in or not, can take over an agent id", async () => {
    const { db, post } = start();
    const owner = generateKeys(), attacker = generateKeys();
    await post("/api/me/agent-key", { agentId: "shopper", publicKeyPem: owner.publicKeyPem }, { as: "paypal:OWNER" });
    const body = { agentId: "shopper", publicKeyPem: attacker.publicKeyPem, replaceExisting: true };
    expect((await post("/api/me/agent-key", body)).status).toBe(401);
    expect((await post("/api/me/agent-key", body, { as: "paypal:ATTACKER" })).status).toBe(403);
    expect(getAgentKey(db, "shopper")).toBe(owner.publicKeyPem);
  });

  it("REGRESSION: a user cannot replace an agent the merchant registered", async () => {
    const { db, post } = start();
    const merchantKey = generateKeys(), attacker = generateKeys();
    registerAgentKey(db, "demo-buyer-agent", merchantKey.publicKeyPem);
    const r = await post("/api/me/agent-key", { agentId: "demo-buyer-agent", publicKeyPem: attacker.publicKeyPem, replaceExisting: true }, { as: "paypal:ANYONE" });
    expect(r.status).toBe(403);
    expect(getAgentKey(db, "demo-buyer-agent")).toBe(merchantKey.publicKeyPem);
  });

  it("re-sending the same key is accepted for any signed-in user and changes nothing", async () => {
    const { db, post } = start();
    const k = generateKeys();
    registerAgentKey(db, "demo-buyer-agent", k.publicKeyPem);
    const r = await post("/api/me/agent-key", { agentId: "demo-buyer-agent", publicKeyPem: k.publicKeyPem }, { as: "paypal:ANYONE" });
    expect(r.status).toBe(200);
    expect(getAgentOwner(db, "demo-buyer-agent")).toBeNull();
  });
});

describe("merchant-admin key routes", () => {
  it("still work with the admin token, validate the key, and write the audit log", async () => {
    const { db, post } = start();
    const k = generateKeys();
    expect((await post("/api/users", { userId: "u1", publicKeyPem: "junk" }, { admin: true })).status).toBe(400);
    expect((await post("/api/users", { userId: "u1", publicKeyPem: k.publicKeyPem }, { admin: true })).status).toBe(201);
    expect((await post("/api/agents", { agentId: "a1", publicKeyPem: k.publicKeyPem }, { admin: true })).status).toBe(201);
    expect((await post("/api/users", { userId: "u2", publicKeyPem: k.publicKeyPem })).status).toBe(401);
    expect(db.prepare("SELECT actor FROM key_changes ORDER BY id").all()).toEqual([{ actor: "admin" }, { actor: "admin" }]);
  });

  it("an admin replacing a user-owned agent's key leaves the owner unchanged", async () => {
    const { db, post } = start();
    registerAgentKey(db, "mine", generateKeys().publicKeyPem, "paypal:OWNER");
    await post("/api/agents", { agentId: "mine", publicKeyPem: generateKeys().publicKeyPem }, { admin: true });
    expect(getAgentOwner(db, "mine")).toBe("paypal:OWNER");
  });
});

describe("existing databases", () => {
  it("opening a database whose agent_keys table predates owners adds the column and keeps the rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "warrant-"));
    const path = join(dir, "old.db");
    try {
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      const old = new DatabaseSync(path);
      old.exec("CREATE TABLE agent_keys (agent_id TEXT PRIMARY KEY, public_key_pem TEXT NOT NULL, registered_at TEXT NOT NULL DEFAULT (datetime('now')))");
      old.prepare("INSERT INTO agent_keys (agent_id, public_key_pem) VALUES ('legacy-agent', 'PEM')").run();
      old.close();

      const db = openDb(path);
      expect((db.prepare("PRAGMA table_info(agent_keys)").all() as { name: string }[]).map(c => c.name)).toContain("owner_user_id");
      expect(getAgentKey(db, "legacy-agent")).toBe("PEM");
      expect(getAgentOwner(db, "legacy-agent")).toBeNull();   // legacy agents are admin-owned
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
