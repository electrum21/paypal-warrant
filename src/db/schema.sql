PRAGMA foreign_keys = ON;

-- Public keys of buyer agents, so a merchant can verify mandate signatures.
CREATE TABLE IF NOT EXISTS agent_keys (
  agent_id TEXT PRIMARY KEY,
  public_key_pem TEXT NOT NULL,
  registered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agent_keys(agent_id),
  mandate_json TEXT NOT NULL,
  mandate_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  paypal_order_id TEXT UNIQUE,
  mandate_id TEXT REFERENCES mandates(id),
  merchant_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'CREATED',
  paypal_capture_id TEXT,                  -- what a dispute is raised against
  mandate_findings_json TEXT,              -- result of checkPurchase at order time
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY,
  paypal_dispute_id TEXT NOT NULL UNIQUE,
  order_id INTEGER REFERENCES orders(id),
  reason TEXT,
  status TEXT,
  amount_cents INTEGER,
  decision_json TEXT,                      -- proposed action + reason; merchant approves before submission
  merchant_approved_at TEXT,
  workflow_state TEXT NOT NULL DEFAULT 'PROPOSED',  -- PROPOSED | APPROVED | SUBMITTED | FAILED | REJECTED
  note_final TEXT,                         -- the note the merchant approved (may be edited)
  submit_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS evidence_packs (
  id INTEGER PRIMARY KEY,
  dispute_id INTEGER NOT NULL REFERENCES disputes(id),
  pack_json TEXT NOT NULL,
  submitted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  order_id INTEGER REFERENCES orders(id),
  type TEXT NOT NULL,                      -- mandate_presented, mandate_verified, dispute_notice ...
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Auditable tool calls made by the buyer and merchant agents.
CREATE TABLE IF NOT EXISTS agent_events (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,                 -- buyer | merchant-dispute
  dispute_id INTEGER REFERENCES disputes(id),
  event_type TEXT NOT NULL,                 -- tool_call | observation | recommendation
  tool_name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY,
  paypal_event_id TEXT UNIQUE,             -- dedupe retries
  event_type TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
