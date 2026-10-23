PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS auth_sessions (
  session_id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS paypal_oauth_states (
  state TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payment_setup_sessions (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  setup_token_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Public keys of buyer agents, so a merchant can verify mandate signatures.
CREATE TABLE IF NOT EXISTS agent_keys (
  agent_id TEXT PRIMARY KEY,
  public_key_pem TEXT NOT NULL,
  -- The signed-in user who first registered this agent. Only that user (or the merchant admin) may change its key.
  -- NULL means the merchant admin registered it, so only the admin may change it.
  owner_user_id TEXT,
  registered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only record of every key registration and replacement (keys are stored as sha256 fingerprints).
CREATE TABLE IF NOT EXISTS key_changes (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                       -- user | agent
  subject_id TEXT NOT NULL,                 -- user id or agent id
  actor TEXT NOT NULL,                      -- session:<user id> | admin
  action TEXT NOT NULL,                     -- registered | replaced
  old_key_sha256 TEXT,
  new_key_sha256 TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Public keys of USERS. A mandate must verify against its user's key; the buyer agent never holds this key.
CREATE TABLE IF NOT EXISTS user_keys (
  user_id TEXT PRIMARY KEY,
  public_key_pem TEXT NOT NULL,
  registered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- PayPal vault token for a user's saved account. Lets the merchant charge without a buyer click, so
-- every charge made with it must pass the mandate checks first. Treat the token as a secret.
CREATE TABLE IF NOT EXISTS payment_tokens (
  user_id TEXT PRIMARY KEY REFERENCES user_keys(user_id),
  token_id TEXT NOT NULL,
  paypal_customer_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE | REVOKED
  expires_at TEXT,                          -- ISO 8601; autonomous charges stop at this time
  linked_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  cart_id TEXT,                            -- the agent-signed cart this order was made from (one order per cart)
  cart_json TEXT,                          -- signed cart: { cart, cartHash, signature }
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

-- One row per autonomous charge attempt, keyed by the agent-signed cart. A row is RESERVED before PayPal is called,
-- so concurrent or repeated requests cannot spend the same mandate budget twice.
--   RESERVED  budget held; charge in flight, or the process stopped before knowing the outcome
--   CAPTURED  PayPal confirmed the payment
--   UNKNOWN   PayPal's outcome could not be determined; budget stays held until someone reconciles it
--   RELEASED  PayPal definitively refused; budget returned
CREATE TABLE IF NOT EXISTS mandate_uses (
  cart_id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RESERVED','CAPTURED','UNKNOWN','RELEASED')),
  order_id INTEGER,
  paypal_order_id TEXT,
  capture_id TEXT,
  detail TEXT,
  reserved_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mandate_uses_mandate ON mandate_uses(mandate_id);

-- Append-only log of what the USER (or, for stop actions only, the merchant admin) did to limit an agent.
-- One source for checkout, dispute evidence and audit. The nonce makes each signed request usable once.
CREATE TABLE IF NOT EXISTS control_events (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,                     -- revoke_mandate | pause_agent | resume_agent | revoke_payment_authorization
  subject_id TEXT NOT NULL,                 -- mandate id, or the user id
  reason TEXT,
  issued_at TEXT NOT NULL,                  -- the user's clock (checked for freshness)
  applied_at TEXT NOT NULL,                 -- the server's clock (used for "before this purchase" decisions)
  via TEXT NOT NULL,                        -- user_signature | admin
  nonce TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_control_user ON control_events(user_id, id);
CREATE INDEX IF NOT EXISTS idx_control_subject ON control_events(action, subject_id);

-- An autonomous purchase that exceeded the mandate's requireApprovalAboveCents threshold. Budget is already held
-- in mandate_uses; PayPal is not charged until the user approves it here, or the hold expires.
--   PENDING   awaiting the user's decision
--   APPROVED  the user approved it; chargeAndRecord ran (or is running)
--   DECLINED  the user (or admin) declined it; budget was released
--   EXPIRED   nobody decided before expires_at; budget was released
CREATE TABLE IF NOT EXISTS checkout_holds (
  cart_id TEXT PRIMARY KEY REFERENCES mandate_uses(cart_id),
  mandate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  checkout_json TEXT NOT NULL,              -- the validated request needed to resume the charge
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','DECLINED','EXPIRED')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_checkout_holds_user ON checkout_holds(user_id, status);

-- What Channel3 said the purchased product was, captured when the order was made (and re-checked at dispute time if missing).
CREATE TABLE IF NOT EXISTS product_checks (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id),
  product_id TEXT NOT NULL,
  check_json TEXT NOT NULL,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Evidence that arrives AFTER a dispute is opened (for example delivery proof pushed in by a Zapier Zap).
-- Append-only. Rows are third-party data: validated on the way in, rendered as plain text, never shown to the LLM verbatim.
CREATE TABLE IF NOT EXISTS dispute_evidence (
  id INTEGER PRIMARY KEY,
  dispute_id INTEGER NOT NULL REFERENCES disputes(id),
  kind TEXT NOT NULL,                       -- delivery
  source TEXT NOT NULL,                     -- zapier | admin
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dispute_evidence_dispute ON dispute_evidence(dispute_id, kind);
