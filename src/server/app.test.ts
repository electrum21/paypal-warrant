import { describe, expect, it } from "vitest";
import { openDb } from "../db/index.js";

describe("database schema", () => {
  it("creates all tables and enforces unique webhook event ids", () => {
    const db = openDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    for (const t of ["agent_keys", "mandates", "orders", "disputes", "evidence_packs", "agent_messages", "agent_events", "webhook_events"]) {
      expect(tables).toContain(t);
    }
    const ins = db.prepare("INSERT OR IGNORE INTO webhook_events (paypal_event_id, event_type, payload_json) VALUES (?,?,?)");
    ins.run("WH-1", "CUSTOMER.DISPUTE.CREATED", "{}");
    ins.run("WH-1", "CUSTOMER.DISPUTE.CREATED", "{}");
    expect(db.prepare("SELECT COUNT(*) c FROM webhook_events").get()).toEqual({ c: 1 });
  });
});
