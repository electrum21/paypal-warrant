import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

// Loaded via require so test tooling doesn't try to bundle the built-in module.
const { DatabaseSync: Database } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function addColumnIfMissing(db: Db, table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/** Uses Node's built-in SQLite (no native build step). Requires Node 22.13+ or 24. */
export function openDb(path = ":memory:"): Db {
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  // Migrations for databases created before these columns existed.
  addColumnIfMissing(db, "agent_keys", "owner_user_id", "TEXT");
  addColumnIfMissing(db, "orders", "paypal_capture_id", "TEXT");
  addColumnIfMissing(db, "orders", "cart_id", "TEXT");
  addColumnIfMissing(db, "orders", "cart_json", "TEXT");
  addColumnIfMissing(db, "payment_tokens", "status", "TEXT NOT NULL DEFAULT 'ACTIVE'");
  addColumnIfMissing(db, "payment_tokens", "expires_at", "TEXT");
  addColumnIfMissing(db, "disputes", "workflow_state", "TEXT NOT NULL DEFAULT 'PROPOSED'");
  addColumnIfMissing(db, "disputes", "note_final", "TEXT");
  addColumnIfMissing(db, "disputes", "submit_error", "TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS agent_events (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    dispute_id INTEGER REFERENCES disputes(id),
    event_type TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    input_json TEXT NOT NULL,
    output_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_capture ON orders(paypal_capture_id) WHERE paypal_capture_id IS NOT NULL");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_cart ON orders(cart_id) WHERE cart_id IS NOT NULL");
  return db;
}