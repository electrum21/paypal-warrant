# Warrant

Dispute defense for merchants selling to AI shoppers. A buyer's agent presents a **signed mandate**
when it buys; if the purchase is later disputed, the merchant's agent assembles the evidence,
checks the purchase against the mandate with plain code, and proposes a response through the
**PayPal Disputes API** (sandbox only). The merchant approves before anything is submitted.

> **Status (verified 4–5 October 2026).** The dispute pipeline is built. A webhook (or manual import)
> turns a dispute into a stored **proposal**: signature check, mandate check, deterministic decision,
> evidence pack, and an AI-written explanation. A merchant approves it on `/admin`; only then are calls
> made to the PayPal Disputes API.
>
> **Tested:** 165 tests in 15 files pass (`npm test`); `npm run typecheck` is clean. The Express routes are
> covered with a stubbed PayPal: checkout, key registration, payment-method connect, webhook verification
> and deduplication, and the user page. Business logic, mandate signing, and the decision engine are
> covered directly.
>
> **Run against the PayPal sandbox:** order create and capture, **Log in with PayPal** identity sign-in,
> dispute creation from the buyer account, dispute import and matching to the stored capture,
> `provide-evidence` (JSON, `evidence_type: "OTHER"` → case moved to `UNDER_REVIEW`), `accept-claim`
> (`{ note, accept_claim_type: "REFUND" }` → buyer refunded), `ENFORCE_MANDATE=true` → 422, the PayPal
> Vault payment-method connection, and the buyer agent making a **no-click autonomous purchase** with the
> linked payment method. Channel3, Elastic, and Zapier were each run live.
>
> **Not verified:** live webhook delivery and signature verification (needs a public URL), the Render
> deployment, `make-offer` against a dispute that allows it (PayPal does not offer it on an `UNAUTHORISED`
> dispute, so the over-limit case is shown as a **blocked proposal**), `adjudicate` (not offered to the
> sandbox merchant account), a prompt-injection attempt through `buy-request`, and startup from a fresh
> `.env` copied from `.env.example`.

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
3. A dispute is raised on that capture. `CUSTOMER.DISPUTE.CREATED` (receiver implemented and locally tested; live delivery not yet confirmed) or `POST /api/disputes/import` runs the pipeline.
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

## Verification checklist
Verified (4–5 Oct 2026, full detail in `docs/03-testing-and-usage.md` part K):
- [x] Sandbox: create a dispute from the buyer account (buyer UI path documented in `docs/03` part F)
- [x] Confirm dispute reason codes (observed `UNAUTHORISED`, stage `CHARGEBACK`; buyer and merchant get different dispute IDs)
- [x] Submit evidence via the API (JSON body, `evidence_type: "OTHER"`; the case moved to `UNDER_REVIEW`)
- [x] Accept a claim (`{ note, accept_claim_type: "REFUND" }`; buyer refunded, seller fee reversed)
- [x] Verify the Disputes API request bodies for evidence and accept-claim
- [x] Run `smoke:order` then `/api/checkout` against the sandbox and confirm the capture ID matches the dispute's seller transaction
- [x] PayPal Vault payment-method connection (`link-payment`) and a no-click autonomous charge
- [x] Log in with PayPal identity sign-in (`docs/10-sso-quick-run-guide.md`) and the buyer agent completing an autonomous purchase with the linked payment method (5 Oct 2026)

Still open:
- [ ] Which webhook event types PayPal sends at creation, update, and resolution; deploy the webhook receiver (Render), register the webhook ID, and confirm `verified=1`
- [ ] `make-offer` / partial refund and `adjudicate` against a dispute type that allows them (neither is offered on `UNAUTHORISED` at `CHARGEBACK`)
- [ ] Check which of these the PayPal Agent Toolkit exposes
- [ ] Prompt injection through `buy-request`
- [ ] Start the server from a fresh `.env` copied from `.env.example`

MIT licensed.