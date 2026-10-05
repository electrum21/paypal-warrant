# Warrant

Dispute defense for merchants selling to AI shoppers. A buyer's agent presents a **signed mandate**
when it buys; if the purchase is later disputed, the merchant's agent assembles the evidence,
checks the purchase against the mandate with plain code, and proposes a response through the
**PayPal Disputes API** (sandbox only). The merchant approves before anything is submitted.

> Status: the dispute pipeline is built. A webhook (or manual import) turns a dispute into a stored
> **proposal**: signature check, mandate check, deterministic decision, evidence pack, and an AI-written
> explanation. A merchant approves it on `/admin`; only then are calls made to the PayPal Disputes API.
> Business logic is tested (73 tests). The Express routes, the admin page's connection to real routes, and
> **every PayPal call** (orders, webhooks, disputes) are **untested against the sandbox**. The Disputes API
> request bodies in `src/paypal/disputes.ts` are unverified guesses from PayPal's docs.

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
- Channel3 product discovery for natural-language buyer requests
- Elastic indexing/search for agent investigation events
- AG Grid dispute operations view
- Zapier proposal notifications
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
- [ ] Sandbox: create a dispute from the buyer account and note which webhooks fire
- [ ] Confirm dispute reason codes (the code assumes `UNAUTHORISED`)
- [ ] Submit evidence via the API and see which formats the sandbox accepts
- [ ] Try offer, partial refund and settle
- [ ] Check which of these the PayPal Agent Toolkit exposes
- [ ] Verify the Disputes API request bodies (evidence type, accept-claim reason, JSON vs multipart)
- [ ] Run `smoke:order` then `/api/checkout` against the sandbox and confirm the capture ID matches the dispute's seller transaction
- [ ] Deploy the webhook receiver (Render) and register the webhook ID

MIT licensed.