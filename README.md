# Warrant

Dispute defense for merchants selling to AI shoppers. A buyer's agent presents a **signed mandate**
when it buys; if the purchase is later disputed, the merchant's agent assembles the evidence,
checks the purchase against the mandate with plain code, and proposes a response through the
**PayPal Disputes API** (sandbox only). The merchant approves before anything is submitted.

> Status: the dispute pipeline is built. A webhook (or manual import) turns a dispute into a stored
> **proposal**: signature check, mandate check, deterministic decision, evidence pack, and an AI-written
> explanation. A merchant approves it on `/admin`; only then are calls made to the PayPal Disputes API.
> Business logic and Express routes are covered by 213 automated tests. Core order, Vault, dispute
> import, evidence, and accept-claim flows have also been exercised against the PayPal sandbox.
> Live webhook delivery, public deployment, and the optional sponsor services still require final
> environment-specific validation.

## Honest scope
- The buyer agent and merchant agent are both built by us; PayPal's real dispute process is not simulated beyond the sandbox.
- The mandate format is **AP2-inspired, not AP2-compliant**.
- Decisions are proposals. The LLM explains and drafts notes; it never decides whether money moves. Its output must be JSON, within length limits, and may only use numbers present in the verified facts, otherwise a plain template is used.
- Mandate descriptions are third-party text. They are shown to the LLM as quoted data and rendered in the admin page as plain text only.
- This is not legal advice, and a signed mandate is evidence, not a guarantee of any dispute outcome.

## Run
```
npm install
cp .env.example .env     # add PayPal SANDBOX credentials
npm test                 # no credentials needed
npm run db:init
npm run smoke:auth       # confirms your keys work
npm run smoke:order      # creates a sandbox order and prints an approval link
npm run dev              # server on :8787 (webhooks, checkout, /admin)
```

Set `ADMIN_TOKEN` in `.env`, then open `http://localhost:8787/admin?token=<ADMIN_TOKEN>`.
Set `ANTHROPIC_API_KEY` to get LLM explanations (optional; a template is used without it).
Without a public webhook URL you can still test: import a sandbox dispute by its ID on the admin page.

## Demo and docs
```
npm run demo:offline     # whole story, fake PayPal, no credentials
npm run demo -- register # live: register the demo user's key and the buyer agent's key
npm run demo -- buy over # live: within | over | category
npm run demo -- link-payment <VAULT_TOKEN_ID> # live: link a saved PayPal account (see docs/04)
npm run demo -- buy-auto over # live: pay with no click; out-of-mandate buys are refused
npm run demo -- buy-request "Buy trail running shoes under $120"
npm run demo -- import <PAYPAL_DISPUTE_ID>
```
Docs in `docs/`: project overview, plain-English summary, testing and usage guide.
Sponsor adapters and setup notes are in `docs/08-sponsor-integrations.md`.

Optional sponsor integrations:
- Channel3 product discovery, plus verification of what was actually bought (category and retailer prices)
- Elastic: agent-trace search and precedent retrieval over past disputes (semantic + keyword)
- AG Grid dispute queue on the approval screen, and an AG Studio analytics dashboard at `/studio`
- Zapier: proposal notifications and an evidence loop that brings delivery proof back
- PayPal's official sandbox MCP server can optionally provide read-only dispute and catalog context to the Studio analyst (`PAYPAL_MCP_ENABLED=true`)
- Render deployment with persistent SQLite storage
- Postman collection and APIMatic-ready `openapi.yaml`

## Flow
1. Buyer agent `POST /api/checkout` with the **user-signed mandate** and an **agent-signed cart** (the exact purchase). Warrant verifies both signatures against the registered user and agent keys, checks the cart is bound to the mandate and matches the purchase, accepts each cart once, records findings, and creates the PayPal order.
2. Buyer approves; `/paypal/return` captures and stores the capture ID.
3. A dispute is raised on that capture. `CUSTOMER.DISPUTE.CREATED` (verified) or `POST /api/disputes/import` runs the pipeline.
4. Merchant reviews the proposal on `/admin`, edits the note, approves or dismisses.
5. On approve: evidence, offer or accept-claim is sent with a stable `PayPal-Request-Id`. Failures are recorded and retryable.

## Layout
- `src/mandate/`  sign, verify and check mandates and carts (ed25519, canonical JSON); `authorize.ts` checks who signed what
- `src/disputes/` deterministic decision, evidence pack, and the service that proposes / approves / rejects
- `src/ai/`       LLM drafting with validation and template fallback
- `src/paypal/`   sandbox-pinned REST client, Disputes API client, webhook verification
- `src/server/`   Express app: webhook, checkout, admin API, admin page
- `src/repo.ts`   small helpers for keys, mandates and orders
- `src/db/`       SQLite schema

## Week-1 checklist
Superseded by the full verification log in `docs/03-testing-and-usage.md` section K; kept here only as a quick scorecard.
- [x] Sandbox: create a dispute from the buyer account. Reason `UNAUTHORISED`, stage `CHARGEBACK`. **Still open:** which webhook fires on creation, since there's no public URL to receive it yet (needs the Render deploy below)
- [x] Confirm dispute reason codes (the code assumes `UNAUTHORISED`) — confirmed against a real sandbox dispute
- [x] Submit evidence via the API and see which formats the sandbox accepts — a JSON `evidences: [{ evidence_type: "OTHER", notes }]` body is accepted
- [x] Try offer, partial refund and settle — `make-offer` is not offered for this dispute type/stage, and `adjudicate` returns `ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE` for this merchant account. Neither works around it
- [x] Check what PayPal's MCP server exposes — its sandbox read tools are allow-listed for the Studio analyst; the PayPal Agent Toolkit itself was not separately investigated
- [x] Verify the Disputes API request bodies (evidence type, accept-claim reason, JSON vs multipart) — both confirmed against the sandbox
- [x] Run `smoke:order` then `/api/checkout` against the sandbox and confirm the capture ID matches the dispute's seller transaction — confirmed
- [x] Deploy the webhook receiver (Render) and register the webhook ID — live at `warrant-9baj.onrender.com`, `/health` confirms `webhookVerification: true`

MIT licensed.