import { describe, expect, it } from "vitest";
import { openDb } from "../db/index.js";
import { createApp } from "./app.js";

describe("database schema", () => {
  it("creates all tables and enforces unique webhook event ids", () => {
    const db = openDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    for (const t of ["agent_keys", "user_keys", "payment_tokens", "mandates", "orders", "disputes", "evidence_packs", "agent_messages", "agent_events", "webhook_events"]) {
      expect(tables).toContain(t);
    }
    const ins = db.prepare("INSERT OR IGNORE INTO webhook_events (paypal_event_id, event_type, payload_json) VALUES (?,?,?)");
    ins.run("WH-1", "CUSTOMER.DISPUTE.CREATED", "{}");
    ins.run("WH-1", "CUSTOMER.DISPUTE.CREATED", "{}");
    expect(db.prepare("SELECT COUNT(*) c FROM webhook_events").get()).toEqual({ c: 1 });
  });

  describe("JUDGE_TOKEN", () => {
    it("grants the same access to /admin as ADMIN_TOKEN, independently", async () => {
      const cfg = {
        PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", DATABASE_PATH: ":memory:",
        PORT: 0, APP_URL: "http://localhost", ADMIN_TOKEN: "real-admin-token", JUDGE_TOKEN: "disposable-judge-token",
        ANTHROPIC_MODEL: "m", GEMINI_MODEL: "g", ENFORCE_MANDATE: false,
        MERCHANT_ID: "warrant-demo-merchant", ELASTIC_INDEX: "warrant-agent-events",
      } as any;
      const app = createApp(cfg, openDb());
      const server = app.listen(0);
      try {
        const port = (server.address() as { port: number }).port;
        for (const token of ["real-admin-token", "disposable-judge-token"]) {
          const response = await fetch(`http://127.0.0.1:${port}/admin?token=${token}`);
          expect(response.status).toBe(200);
        }
        const rejected = await fetch(`http://127.0.0.1:${port}/admin?token=wrong-token`);
        expect(rejected.status).toBe(401);
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  });

  describe("user authorization page", () => {
    it("serves the user page at /user and keeps /me as an alias", async () => {
      const cfg = {
        PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", DATABASE_PATH: ":memory:",
        PORT: 0, APP_URL: "http://localhost", ADMIN_TOKEN: "admin",
        ANTHROPIC_MODEL: "m", GEMINI_MODEL: "g", ENFORCE_MANDATE: false,
        MERCHANT_ID: "warrant-demo-merchant", ELASTIC_INDEX: "warrant-agent-events",
      } as any;
      const app = createApp(cfg, openDb());
      const server = app.listen(0);
      try {
        const port = (server.address() as { port: number }).port;
        for (const path of ["/user", "/me"]) {
          const response = await fetch(`http://127.0.0.1:${port}${path}`);
          expect(response.status).toBe(200);
          expect(await response.text()).toContain("Warrant: my agent");
        }
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  });
});