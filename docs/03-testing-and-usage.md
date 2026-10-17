# Warrant: how to test and use it

*Personal runbook. Work top to bottom; each part builds on the one before. Parts A to C need no PayPal account.*

**Status note (updated 5 Oct 2026).** Parts A to F were run end to end against the PayPal **sandbox**: order creation, capture, dispute import, and two of the three response paths (contest, accept claim). The PayPal Vault payment-method connection was also run successfully: setup-token approval and exchange for a payment-method token both work. The third dispute path (partial refund) is **not available** from PayPal for this dispute type, so Warrant shows it as a blocked proposal. The three sponsor integrations (Channel3, Elastic, Zapier) were each run live (part G2). The PayPal webhook receiver and local verification/deduplication tests are implemented; live webhook delivery and signature verification still require a public deployment. Part K records exactly what was observed and what was not.

## A. Prerequisites and install

- **Node 22.13 or newer** (the project uses Node's built-in `node:sqlite`). Check with `node -v`.
- Unzip the project, then:

```
cd warrant
npm install
```

## B. Try it with no credentials

### B1. Run the automated tests

```
npm test            # 51 tests expected
npm run typecheck   # should print nothing if clean
```

What the tests cover:

| File | Covers |
|---|---|
| `src/mandate/mandate.test.ts` | Signing, tampering, key mismatch, every purchase-check rule, revoked mandates |
| `src/disputes/disputes.test.ts` | Decision rules, evidence pack |
| `src/disputes/service.test.ts` | Propose, approve, retry after failure, reject, escalate, idempotency, LLM draft accepted, proposals PayPal does not allow are blocked |
| `src/ai/draft.test.ts` | LLM output validation; fallbacks for bad JSON, errors, invented numbers |
| `src/agent/agent.test.ts` | The three demo scenarios end to end with a fake PayPal |
| `src/integrations/channel3.test.ts` | Channel3 adapter: URL and header, cheapest in-budget offer, currency and budget filtering, description length, errors |
| `src/server/app.test.ts` | Database schema creation |

### B2. Watch the whole story

```
npm run demo:offline            # all three scenarios
npm run demo:offline -- over    # just one: within | over | category
```

This runs the **real** pipeline (signing, checking, deciding, evidence, approval) with a **fake PayPal**. Expected output (trimmed):

```
=== within: Shoes for $115, inside the $120 limit
Checked at order:  within the mandate
Warrant proposes:  contest
Sent to PayPal before approval: 0 calls
After merchant approves:        provide-evidence {"chars":737}  -> SUBMITTED

=== over: Shoes for $135, $15 over the limit
Checked at order:  AMOUNT_EXCEEDS_MAX
Warrant proposes:  offer_partial_refund (refund 15.00 USD)
After merchant approves:        make-offer {"amountCents":1500,"currency":"USD"}  -> SUBMITTED

=== category: A $115 gadget; the mandate only covers footwear
Checked at order:  CATEGORY_NOT_ALLOWED
Warrant proposes:  accept_claim
After merchant approves:        accept-claim {}  -> SUBMITTED
```

Every scenario ends with `Matches expectation (...): yes`. The key line to point at in a demo is **"Sent to PayPal before approval: 0 calls"**.

**Offline vs real PayPal.** The fake PayPal accepts a partial-refund offer. The real sandbox does **not** offer that action for an unauthorized dispute (see part F and K), so in the live flow the `over` scenario ends in a blocked proposal instead of a submission.

### B3. See the AI explanations (optional)

```
$env:GEMINI_API_KEY="your-key"; npm run demo:offline      # PowerShell
$env:ANTHROPIC_API_KEY="your-key"; npm run demo:offline   # PowerShell, Anthropic instead
```

The header changes to "LLM on" and the `Why:` line becomes model-written. If the model's output breaks a rule (bad JSON, an invented number), you silently get template text instead; the admin page shows which one you got. If both keys are set, Gemini is used.

### B4. See the buyer agent plan

The live demo also accepts a natural-language shopping request. The buyer agent extracts
the budget and category, searches the small demo catalog, selects the cheapest eligible
product, creates a signed mandate from that plan, and submits the checkout:

```
npm run demo -- buy-request "Buy trail running shoes under $120"
```

With `CHANNEL3_URL` and `CHANNEL3_API_KEY` set, the catalog is searched through Channel3 (the output line `Catalog source: channel3`). If Channel3 is not configured or returns an error, the local demo catalog is used and the output says why.

**PowerShell tip:** put the request in **single quotes** (`'Buy trail running shoes under $120'`). Inside double quotes PowerShell treats `$120` as a variable and refuses to run the command.

This is intentionally bounded: the request is converted into a validated plan before
the mandate is signed, and a product outside the budget or category is never selected.
The merchant-side agent's investigation trace is shown in the offline demo and in the
admin page under **Merchant agent activity**. It records read-only steps such as matching
the capture, verifying the mandate, checking the purchase, identifying missing evidence,
and recommending a response. PayPal submission still requires merchant approval.

## C. Configure the project

```
copy .env.example .env      # PowerShell (cp on macOS/Linux)
```

| Variable | Required | Meaning |
|---|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Yes (server, smoke scripts) | **Sandbox** REST app credentials |
| `PAYPAL_WEBHOOK_ID` | For webhooks | ID of the webhook you register (part G) |
| `ADMIN_TOKEN` | For `/admin` and merchant API | Long random string you choose. Without it those routes return 503 |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | No | Enables LLM explanations with Gemini. Default model `gemini-3.1-flash-lite` |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | No | Enables LLM explanations with Anthropic (used only if no Gemini key). Default model `claude-sonnet-5-5` |
| `ENFORCE_MANDATE` | No | `true` makes `/api/checkout` refuse purchases that break the mandate (HTTP 422). Default `false`: record them and defend later |
| `CHANNEL3_URL`, `CHANNEL3_API_KEY` | No | Real product search for `buy-request`. URL is `https://api.trychannel3.com`. Adapter calls `POST /v1/search` with an `x-api-key` header |
| `ELASTIC_URL`, `ELASTIC_API_KEY`, `ELASTIC_INDEX` | No | Indexes the merchant agent's investigation events and enables `/api/agent-events/search`. URL is the Elasticsearch endpoint (not Kibana). Default index `warrant-agent-events` |
| `ZAPIER_WEBHOOK_URL` | No | A Zapier Catch Hook URL. Receives a `proposal_ready` message when a proposal is created |
| `MERCHANT_ID` | No | Merchant id mandates must list. Default `warrant-demo-merchant`. Server and demo CLI must agree |
| `DATABASE_PATH`, `PORT`, `APP_URL` | No | Defaults `./warrant.db`, `8787`, `http://localhost:8787` |

The server reads `.env` only at startup, so **restart `npm run dev` after any change**. Never commit `.env`. `.gitignore` already excludes it, the database files, and `.demo-agent.json`.

## D. Connect to the PayPal sandbox

PayPal's dashboard layout changes, so menu names below are approximate.

1. Sign in at developer.paypal.com and open the **Sandbox** area.
2. Make sure you have two sandbox accounts: a **Business** account (the merchant) and a **Personal** account (the buyer). The dashboard usually creates defaults; note the buyer's email and password.
3. Create a **REST app** under the Business account (Apps & Credentials, Sandbox). Copy the Client ID and Secret into `.env`.
4. Set `ADMIN_TOKEN` in `.env` (any long random string).
5. Initialize and test:

```
npm run db:init
npm run smoke:auth     # prints success if your keys work
npm run smoke:order    # creates a $10 order and prints an approval link
```

6. For the order test, start `npm run dev` first (the return page captures the payment), then open the printed link **in a private window** and approve as the sandbox **Personal** account. You should see "Order ...: COMPLETED" and a Capture ID.

## E. Run the live demo

Terminal 1:

```
npm run dev
```

Check `http://localhost:8787/health`. You want `"admin": true`. `"llm"` is true only if you set a Gemini or Anthropic key. `"webhookVerification"` stays false until part G.

Terminal 2:

```
npm run demo -- register          # one time: tells the merchant the user's and the agent's public keys
npm run demo -- buy within        # or: over | category
```

`buy` prints an order ID, any findings, and a PayPal approval link. Open the link in a private window and approve as the sandbox buyer. The server logs `captured order ... capture ...`.

**Each dispute needs its own payment.** PayPal does not let a buyer open a second dispute on the same transaction (per PayPal's sandbox guide), so run a fresh `buy` for each scenario.

The demo has two signers. The **user** key (`.demo-user.json`) signs the mandate; the **agent** key (`.demo-agent.json`) signs each cart. Delete a file to start with a fresh key, then register again. Both files hold private keys and are git-ignored.

**What the click means.** The default `buy` command uses an approval-based order. The user page also supports connecting a PayPal Vault payment method for autonomous charges, and the full browser-driven autonomous checkout has been verified in the sandbox.

## F. Raise and handle a dispute

Verified route (4 Oct 2026):

1. **Create the dispute as the buyer.** Sign in to the **sandbox** PayPal site as the Personal account, open the payment under Activity, and report a problem. Choose **Unauthorized activity in your PayPal account** then **I suspect my account is being used by someone else**, and make sure the disputed payment is the one selected. Submit. You get a buyer-side case ID (looks like `PP-R-ZVT-10190270`). PayPal then offers a "Secure your account" step; in the sandbox it is safe to skip, but doing so may block that buyer from sending money.
   - The Business account cannot file a case ("you can't file a case on this type of transaction"). Only the buyer files; the merchant responds.
2. **Get the merchant-side dispute ID.** The buyer and merchant receive **different** dispute IDs for unauthorized cases. Import the merchant's. Wait a minute or two, then run the helper script (appendix):

```
npx tsx src/scripts/list-disputes.ts
```

   It prints one line per open dispute the merchant account can see, for example `PP-R-GTN-10190271  UNAUTHORISED  WAITING_FOR_SELLER_RESPONSE  115.00 USD  created ...`. IDs start with `PP-R-`, not `PP-D-`; Warrant does not care about the prefix.
3. **Import it:**

```
npm run demo -- import PP-R-XXXX-NNNNNNNN
```

   or paste the ID into the Import box on the admin page. (With a working webhook, step 3 happens automatically.)
4. Open `http://localhost:8787/admin?token=YOUR_ADMIN_TOKEN`.
5. Read the proposal. Observed:
   - `within` → **contest**. Click **Submit evidence**.
   - `category` → **accept claim** (finding `CATEGORY_NOT_ALLOWED`). Click **Accept claim**.
   - `over` → proposal **offer a partial refund of 15.00 USD**, but flagged as **not available**: the page explains that PayPal does not accept a partial-refund offer at this stage, shows what PayPal does allow, and offers only **Dismiss**. Nothing can be sent.
6. Edit the note if you like, then click the action button. Or **Dismiss** to send nothing.
7. Check the result: re-run the show script (appendix) and read `status`, `evidences`, `money_movements`.

**What a successful contest looks like.** PayPal's case page changes to "Under review" and shows "You shared the following supporting info" with your note. In the API the dispute gains an `evidences` entry with `source: SUBMITTED_BY_SELLER`, and `links` afterwards offer only `provide_supporting_info` (no second evidence submission).

**What a successful accept-claim looks like.** `money_movements` shows the buyer credited and the seller debited the full amount, the transaction becomes `REFUNDED`, and the seller's transaction fee is credited back.

**If PayPal rejects the submission:** the dispute shows as *Failed* with PayPal's error text. Edit the note and click **Try again**; the retry reuses the same request ID. A 400/422 error body is the clue to fix `src/paypal/disputes.ts`.

### The note Warrant sends

When an LLM writes the explanation, the code first prepends an exact block taken from the database: the mandate ID, the sha256 hash, the signature result, and the buyer's instruction in their own words. The LLM paragraph follows. Identifiers are never passed through the model, so they cannot be mangled. When the template text is used instead, it already contains the same details. PayPal truncates at 2000 characters, so the block is placed first.

### Reading the admin screen

- **Left list:** each dispute with its amount, PayPal reason, and state ("Needs approval", "Submitted", ...).
- **Heading:** the proposed action (and refund amount, if any).
- **Small tag:** "Explained by AI" or "Template text" (hover for why a fallback happened).
- **Bar:** purchase vs the mandate limit; red is the part over the limit; the black tick is the limit.
- **Quote:** what the user told their agent. Plain text only.
- **Checks list:** each rule that failed, or "within the mandate".
- **Note box:** exactly what will be sent to PayPal. Editable.
- **"Needs your review"** cases cannot be submitted from Warrant; handle them in PayPal and dismiss.
- **A proposal with only Dismiss and an explanation of what PayPal currently allows** is a proposal PayPal would reject. Handle it in PayPal.

### Blocking at checkout instead

Set `ENFORCE_MANDATE=true` in `.env` and restart. Then `npm run demo -- buy over` fails with `Checkout failed (422)` and the finding `AMOUNT_EXCEEDS_MAX`, and no PayPal order is created. This is how a merchant avoids the partial-refund problem altogether. Set it back to `false` afterwards so the other demos keep working.

## G. Webhooks (needs a public URL) — NOT YET RUN

1. Deploy the server (Render is suggested). **Free-tier disks are ephemeral:** attach a persistent disk and point `DATABASE_PATH` at it, or the database resets on each deploy. Set all `.env` values as environment variables, and set `APP_URL` to the public address.
2. In the PayPal sandbox app, add a webhook to `https://YOUR-HOST/webhooks/paypal`, subscribing to at least the dispute events (e.g. `CUSTOMER.DISPUTE.CREATED`) and payment capture events. Copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID` and redeploy.
3. Create a dispute. Logs should show `webhook CUSTOMER.DISPUTE.CREATED verified=true`, then `dispute ...: proposed ...`. PayPal's guide says to wait a few minutes after creating a dispute before actions become available.
4. If `verified=false`: check the webhook ID, and that the environment is sandbox. Events are still stored, so you can inspect them.

Record **which events actually fire** at each stage in part K.

## G2. Sponsor integrations (Channel3, Elastic, Zapier)

All three are optional and off unless their variables are set. Failures in Elastic and Zapier are logged and swallowed (they never block a proposal), so **look in the server terminal, not the UI,** when something does not arrive. `GET /health` shows which are enabled under `integrations`.

**Channel3 (product discovery).** Test the endpoint directly:

```
Invoke-RestMethod -Method Post -Uri http://localhost:8787/api/catalog/search -ContentType "application/json" -Body '{"query":"trail running shoes","maxAmountCents":12000,"currency":"USD","category":"footwear"}' | ConvertTo-Json -Depth 5
```

You want `"source": "channel3"` with products at or under the budget. Then `npm run demo -- buy-request 'Buy trail running shoes under $120'` and check `Catalog source: channel3`. Real products come from other retailers, so the demo store lists the cheapest in-budget offer as its own item and records the retailer in the description (for example `... (via mountainwarehouse.com)`). The category is the one the buyer asked for; Channel3's own categories are not mapped.

**Zapier (notification).** Import a **new** dispute (a repeat import returns the stored result and notifies nothing), then open the Zap's history. You should see `source: warrant`, `type: proposal_ready`, the Warrant dispute ID, and `data.action` and `data.reason`.

**Elastic (agent event search).** Import a **new** dispute, then:

```
Invoke-RestMethod -Headers @{"x-admin-token"="YOUR_ADMIN_TOKEN"} 'http://localhost:8787/api/agent-events/search?q=recommend_response' | ConvertTo-Json -Depth 6
Invoke-RestMethod -Headers @{"x-admin-token"="YOUR_ADMIN_TOKEN"} 'http://localhost:8787/api/agent-events/search?q=contest'  | ConvertTo-Json -Depth 6
```

The first searches by tool name; the second searches inside an event's stored output. Both should return `"source": "elastic"` with results. Each dispute produces events named `observe_dispute`, `get_dispute`, `match_order`, `recommend_response` (and `investigation_complete` in some cases). The same trail is shown in the admin page under **Merchant agent activity**.

## H. Inspecting the database

No `sqlite3` CLI needed:

```
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('warrant.db');console.log(d.prepare('select id,paypal_dispute_id,workflow_state,submit_error from disputes').all());console.log(d.prepare('select event_type,verified from webhook_events').all())"
```

To see the note that was actually sent for the latest dispute:

```
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('warrant.db');console.log(d.prepare('select note_final from disputes order by id desc limit 1').get())"
```

To start clean, stop the server and delete `warrant.db`, then `npm run db:init`.

## I. API reference

Agent-facing (no token):

| Method and path | Body | Result |
|---|---|---|
| `GET /health` | | Feature flags |
| `POST /api/catalog/search` | `{ query, maxAmountCents, currency?, category? }` | `{ source, products }`. `source` is `channel3` when results came from Channel3, else `not_configured`. Unauthenticated; consider adding auth |
| `POST /api/checkout` | `{ signedMandate, purchase: { amountCents, currency?, category?, description? } }` | `201 { orderId, approveUrl, findings }`. 400 for unknown agent or bad signature, 409 for a reused mandate id, **422 if `ENFORCE_MANDATE=true` and the purchase breaks the mandate** |
| `GET /paypal/return?token=ORDER_ID` | | Captures the payment, stores the capture ID |

Merchant-facing (header `x-admin-token`, or `?token=` on the page):

| Method and path | Body | Result |
|---|---|---|
| `GET /admin` | | Approval page |
| `GET /api/agent-events/search?q=...` | | Searches indexed merchant-agent events in Elastic (`source: not_configured` if Elastic is off) |
| `POST /api/agents` | `{ agentId, publicKeyPem }` | Registers a buyer agent key |
| `GET /api/disputes` | | All disputes with proposals |
| `GET /api/disputes/:id` | | One dispute |
| `POST /api/disputes/import` | `{ paypalDisputeId }` | Builds a proposal (idempotent) |
| `POST /api/disputes/:id/approve` | `{ note? }` | Sends to PayPal. 409 if already handled, needs a human, or PayPal does not allow the proposed response |
| `POST /api/disputes/:id/reject` | | Dismisses; sends nothing |
| `POST /webhooks/paypal` | PayPal event | Stored; verified `CUSTOMER.DISPUTE.CREATED` starts the pipeline |

## J. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Missing or invalid environment variables` on start | `.env` missing, or PayPal keys blank |
| `/health` shows `"admin": false` or `/admin` shows 503 | `ADMIN_TOKEN` not set, or the server was not restarted after setting it |
| `/admin` shows 401 | Token in the URL doesn't match `.env` |
| `register` fails with 401/503 | Same token issue; the CLI reads `ADMIN_TOKEN` from `.env` |
| `buy` says "No key is registered for user ..." or "... for agent ..." | Run `npm run demo -- register` (and again after deleting `.demo-user.json` or `.demo-agent.json`) |
| `buy` says "This signed cart was already used" | Each signed cart is accepted once; run `buy` again to sign a new one |
| Checkout 400 on mandate content | `MERCHANT_ID` in the demo's environment and the server's must match |
| Checkout 422 | `ENFORCE_MANDATE=true` and the purchase breaks the mandate. Intended |
| Import gives "No order in Warrant matches" (escalated) | The dispute's transaction isn't a capture Warrant recorded. Make sure you approved the payment so `/paypal/return` ran, and that you disputed that same payment |
| `list-disputes` shows nothing new | The merchant-side case can lag the buyer's by a minute or two. Retry |
| Imported the buyer's dispute ID by mistake | Use `list-disputes` for the merchant-side ID; the two differ for unauthorized cases |
| Explanation tag says "Template text" | Hover for the reason: no key set, bad JSON, or the validator rejected a number not in the facts |
| `adjudicate` returns `ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE` | PayPal did not offer that action to the merchant account for this dispute (no `adjudicate` link). Not a Warrant bug |
| TS errors about `../repo.js` having no exported member | `src/repo.ts` is empty or replaced; restore the original |
| `SQLite is an experimental feature` warning | Harmless on Node 22/24 |
| `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` | Node older than 22.13 |
| Server will not start: `Missing or invalid environment variables: CHANNEL3_URL, ...` | A sponsor variable is present but blank in `.env` (for example `CHANNEL3_URL=`). `config.ts` must treat blank values as unset (see K) |
| `Channel3 API 403` | Wrong path or auth header. The REST API is `POST {base}/v1/search` with `x-api-key`, not `Authorization: Bearer`. Also check the key is valid |
| `buy-request` fails with `The variable '$120' cannot be retrieved` | PowerShell: use single quotes around the request |
| `/api/agent-events/search` returns `[]` for a word inside an event's output | The search must include `input.*` and `output.*` in its `fields`, not just `output` |
| Elastic indexing fails with a 401/403/404 | `ELASTIC_URL` is the Kibana address instead of Elasticsearch, or the API key is the wrong form or lacks write permission |
| Submission shows Failed with a PayPal 4xx | Request body mismatch; read PayPal's error text and see part F |

## K. Verification checklist (what was observed, 4 to 5 Oct 2026)

- [x] `npm test` and `npm run typecheck` pass on my machine (51 tests).
- [x] `smoke:auth` and `smoke:order` work. Order `COMPLETED`, capture ID printed.
- [x] PayPal Vault payment-method connection works in the sandbox: the setup token reaches the buyer approval page and the approved token is exchanged and stored server-side.
- [x] The low-level Vault charge smoke path works in the sandbox: a saved payment-method token created an order without a buyer approval click and captured $15.00.
- [x] `/api/checkout` creates an order and the approval flow completes. Orders for `within`, `over` and `category` were all created and captured.
- [x] **How a sandbox dispute can be created.** Buyer UI: Unauthorized activity, then "I suspect my account is being used by someone else", with the payment selected. Result: reason `UNAUTHORISED`, stage `CHARGEBACK`, channel `INTERNAL`, status `WAITING_FOR_SELLER_RESPONSE`, response due about 11 days out. The merchant account cannot file a case.
- [x] **Buyer and merchant dispute IDs differ** for unauthorized cases (buyer `PP-R-ZVT-10190270`, merchant `PP-R-GTN-10190271`). IDs start `PP-R-`, not `PP-D-`.
- [x] The dispute's `seller_transaction_id` equals our stored capture ID. The dispute also echoes our order's `custom` field, which holds the mandate ID (for example `mandate-bf24af85`), a second way to link a dispute to its mandate.
- [x] **Evidence format and type:** a JSON body with `evidences: [{ evidence_type: "OTHER", notes }]` is accepted. PayPal recorded it as `SUBMITTED_BY_SELLER` with action `PROVIDE_EVIDENCE`, and the case moved to `UNDER_REVIEW`. Afterwards only `provide_supporting_info` is offered.
- [x] **Accept-claim body:** the dispute's `allowed_response_options.accept_claim.accept_claim_types` listed only `REFUND`. Sending `{ note, accept_claim_type: "REFUND" }` worked: buyer credited, seller debited the full amount, transaction `REFUNDED`, and the seller fee reversed. (The old `accept_claim_reason` field was replaced before it was ever sent, so its valid values were not tested.)
- [x] **Partial refund via make-offer is not available** on an `UNAUTHORISED` dispute at the `CHARGEBACK` stage. The dispute's links offered only `accept_claim` and `provide_evidence`; there was no `make_offer`. Warrant now shows the proposal as blocked, explains why, and allows only Dismiss. `make-offer` itself was **never exercised** against the sandbox.
- [x] The note sent to PayPal passed validation and arrived intact, including the code-written block with the mandate ID, hash, and instruction.
- [x] `ENFORCE_MANDATE=true` refuses an out-of-mandate checkout with a 422 and no PayPal order.
- [x] The webhook receiver preserves the raw body, verifies events through PayPal's verification endpoint, stores verified/unverified events, and deduplicates event IDs. Local tests cover malformed, unverified, and duplicate events.
- [x] A real sandbox dispute reaches the deployed webhook end to end. Created a fresh sandbox order (`9PT70369074983354`, $115.00, "within" scenario) against `warrant-9baj.onrender.com`, approved it as the buyer, then raised a dispute (buyer id `PP-R-NSN-10193233`, merchant-visible id `PP-R-VHE-10193234`, reason `UNAUTHORISED`). `CUSTOMER.DISPUTE.CREATED` arrived and `processDispute` ran automatically (no manual import): matched the order, verified signatures, found nothing wrong, and proposed `contest` — all logged in the agent trace. **Lag observed: about 4 minutes** from dispute creation to the merchant-side case (and the webhook) being visible, longer than the "a minute or two" seen earlier — budget for that when demoing live.
  - **Not yet observed:** which event types fire on dispute *update* and *resolution* (only `CREATED` has been exercised so far).
- [x] The complete browser-driven `/api/checkout` autonomous purchase path against live PayPal.
- [x] PayPal's official MCP server was investigated. Studio can opt in to the sandbox read tools
  `list_disputes`, `get_dispute`, `list_product`, and `show_product_details`; live MCP invocation
  still needs an account-backed test.

### Sponsor integrations (observed 5 Oct 2026)

- [x] **Channel3:** `POST /v1/search` with an `x-api-key` header returns real products. `buy-request` printed `Catalog source: channel3`, selected a real product (a $39.99 trail shoe via mountainwarehouse.com, the cheapest offer inside the $120 budget), signed a mandate, and created a sandbox order with no findings.
  - The first version of the adapter returned `403` because it called `/search` (no `/v1`) with a Bearer header and expected a flat product shape. It was rewritten to Channel3's documented REST API (offers carry the price and retailer domain).
  - Real products come from other retailers, so the demo store lists the chosen offer as its own item (merchant = the Warrant demo merchant) and keeps the retailer in the description. The category is the one the buyer requested; Channel3 categories are not mapped.
  - The agent picks the cheapest eligible product, so a $120 budget bought a $39.99 item.
  - **Broader coverage, 17 Oct 2026, against the live Render deployment:** "running shoes under $90" -> Cloud X3 Running Shoes (geartrade.com, $34.00), no findings. "hiking boots under $200" -> N45 Mid GTX Hiking Boots (cabelas.com, $45.00); the demo buyer's own category guess (`src/scripts/demo.ts`'s regex only recognizes "shoe"/"runner"/"footwear", not "boot") called this "general", but Channel3's real category for the product is footwear, so the enrichment check correctly flagged `PRODUCT_CATEGORY_NOT_ALLOWED` against a mandate that only declared "general". "wireless earbuds under $150" -> Wave-70 True Wireless Earbuds (bestbuy.com, $29.99), same mismatch (Channel3: electronics; declared: general). Both mismatches are the enrichment feature working as designed, not a bug — it catches exactly the case where the buyer's own category guess undersells what Channel3 says was actually bought.
- [x] **Zapier:** after a dispute import the Catch Hook received `source: warrant`, `type: proposal_ready`, `dispute_id: 4`, `data.action: contest`, `data.reason: UNAUTHORISED`.
  - Re-confirmed 17 Oct 2026 against the **live Render deployment** with a fresh Catch Hook and a 16+ char `EVIDENCE_WEBHOOK_SECRET`: posting delivery evidence to dispute 1 re-ran its proposal and the Catch Hook received the `proposal_updated` payload. The **evidence_requested → carrier lookup → Webhooks POST back** half of the loop is still unexercised: it only fires for `escalate_to_human` disputes with no delivery proof, which needs a non-`UNAUTHORISED` dispute reason (e.g. item-not-received) rather than the ones raised so far.
- [x] **Elastic:** events from a dispute import (`observe_dispute`, `get_dispute`, `match_order`, `recommend_response`) were indexed, and `/api/agent-events/search` returns them.
  - Searching by tool name worked first. Searching for a word inside an event's output (`contest`) returned nothing until the query's fields were changed to `input.*` and `output.*`, because inputs and outputs are stored as nested objects.
  - Indexed events carry `disputeId: null` (the event is indexed before Warrant links it to the dispute row). Join on `runId`, which contains the PayPal dispute ID.
  - `createdAt` and `@timestamp` are stored as `2026-10-04 23:40:24` (SQLite format, no `T`/`Z`), so Elastic probably does not treat `@timestamp` as a date. Not checked in Discover.
- [x] A fresh `.env` copied from `.env.example` starts the server. `loadConfig()` was re-run against a copy of `.env.example` (sponsor vars all blank, PayPal/admin credentials filled in) and loaded without error, confirming the blank-as-unset fix (`z.preprocess(blank, ...)` in `src/config.ts`) works for every optional variable including the new `PAYPAL_MCP_*` pair.
- [x] Prompt injection through a `buy-request` (hostile text in the request becomes the mandate description). `npm run smoke:prompt-injection` sends three injected instructions ("ignore previous instructions", a fake system override, a JSON-breakout attempt) through `draftNarrative` against the live Gemini model. All three: the model itself did not echo the injected claims, and `validateLlmOutput`'s number-matching plus the code-written identifier block (mandate id/hash, signature result, quoted buyer instruction) mean an echoed claim would be rejected back to the template regardless.
- [x] `ENFORCE_MANDATE=true` returns 422 on an over-limit checkout with no PayPal order.
- [x] Render deployment and persistent disk. Live at `warrant-9baj.onrender.com`. The persistent disk was confirmed indirectly: an env var change triggered a Render redeploy/restart, and dispute 1's full record (including its agent-event trace from before the restart) was still there afterward through `/api/disputes/1`.
- [ ] The Elastic adapter against anything other than the one request used above. Channel3 now has three varied queries (see above); Elastic still has only the one index/query from 5 Oct.

### Other findings worth knowing

- **`adjudicate` (settle) was not available to the merchant account.** With status `UNDER_REVIEW`, the dispute had no `adjudicate` link and the call returned `ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE`. PayPal's guide describes it as a sandbox testing shortcut; the reason it was withheld here is unconfirmed. Warrant does not depend on it.
- **Sandbox UI wording:** a case where the merchant accepted the claim and the buyer was refunded displayed as "closed in seller's favor". The money did move to the buyer; treat the money movements as the source of truth, not the label.
- **One dispute per transaction** (per PayPal's sandbox guide), so each scenario needs a fresh payment.
- **The category is declared by the agent** at checkout and is not verified by Warrant. In production it would need to come from the merchant's catalog or the cart.
- **The default demo's payment click** stands in for an approval-based payment. PayPal Vault connection and a low-level autonomous charge were demonstrated in the sandbox without a second buyer approval click.
- **The complete browser-driven `/api/checkout` autonomous purchase path** against live PayPal is verified. The default `buy` command remains available for approval-based checkout.

### Scope of the claim

A signed mandate is evidence of **authorization**. It does not prove delivery or that an item matched its description, and nobody can promise how PayPal will rule. Warrant is built for unauthorized and out-of-scope purchase claims; other dispute reasons escalate to a human because no delivery proof is wired in yet.

## Appendix: helper scripts

These are small files you add under `src/scripts/`. Run them with `npx tsx`.

`src/scripts/list-disputes.ts` (one line per open dispute the merchant account can see):

```ts
import { loadConfig } from "../config.js";
import { ppFetch } from "../paypal/client.js";

const cfg = loadConfig();
const r: any = await ppFetch(cfg, "/v1/customer/disputes?page_size=20");
for (const d of r.items ?? []) {
  console.log(`${d.dispute_id}  ${d.reason}  ${d.status}  ${d.dispute_amount?.value} ${d.dispute_amount?.currency_code}  created ${d.create_time}`);
}
if (!(r.items ?? []).length) console.log("No disputes visible to the merchant account yet.");
```

`src/scripts/show-dispute.ts` (full dispute, including `links` and `allowed_response_options`):

```ts
import { loadConfig } from "../config.js";
import { ppFetch } from "../paypal/client.js";

const id = process.argv[2];
const cfg = loadConfig();
console.log(JSON.stringify(await ppFetch(cfg, `/v1/customer/disputes/${id}`), null, 2));
```

Usage: `npx tsx src/scripts/show-dispute.ts PP-R-XXXX-NNNNNNNN`.