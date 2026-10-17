# Sponsor strategy

Written 6 Oct 2026 from the hackathon's public sponsor pages. Prizes and criteria may change; recheck the
Devpost "Prizes" and each sponsor's details page before submitting.

## Where the prize money actually is

| Sponsor | What the page offers | What it rewards | Where Warrant stood | Where it stands now |
|---|---|---|---|---|
| **AG Grid** | $5k / $2k / $1k x3 | **AG Studio**: custom widgets, theming, layout, the Studio Agent Framework. "Not just AG Grid on its own" | Library loaded but **never instantiated**; the docs said it was in use | Real grid on `/admin`; a Studio dashboard with theme, custom widget and agent scaffold |
| **Channel3** | $1,500 (one winner) | "Search, product enrichment, or recommendations" | Search only; results relabeled with the category the *buyer asked for* | Search, enrichment (verifies what was bought against Channel3's own data), and recommendations (in-mandate alternatives after a refusal) |
| APIMatic | $1k x3 + subscriptions | Using APIMatic output (SDKs, context plugins) | `openapi.yaml` existed but was never put through APIMatic | `openapi.yaml` covers the new routes; **generating a client is still to do** |
| Render | $1k / $750 / $500 credits | A deployed, working project | `render.yaml` written, never deployed | **Deployed and live** at `warrant-9baj.onrender.com`; `/health` confirms `webhookVerification: true` with the PayPal webhook registered against it |
| Bryntum | $1k x3 | Gantt / Scheduler / Calendar | Not used | Not used (idea below) |
| Elastic, Zapier | No cash prize listed; tools and judges | A multi-step agent using retrieval (Elastic); automation/MCP (Zapier) | Log search; one-way webhook | Retrieval the agent uses; the proposal→Catch Hook leg confirmed live against the Render deployment. The evidence-request→callback leg is built but not yet exercised live (needs a non-UNAUTHORISED dispute) |

## The principle behind every change

Warrant's rule is *code decides, a person approves, the LLM only explains*. A sponsor integration is
"meaningful" here when it feeds a deterministic check or removes a manual step, and it must never get a
way to move money or approve a response. So:

- **Channel3** supplies a fact (the product's category) that the existing mandate check can use.
- **Elastic** supplies context (similar past cases) the merchant sees but that never changes the action.
- **Zapier** supplies missing evidence, which re-runs the same deterministic decision.
- **AG Studio's agent** can read and chart, and has no tool that approves, dismisses, submits or refunds.

## What changed

1. **Channel3 verification.** `Cart.productId` (agent-signed) -> `GET /v1/products/{id}` -> a pure
   `assessProduct()` -> `PRODUCT_CATEGORY_NOT_ALLOWED` blocking finding, stored snapshot, evidence-note
   section, autonomous-mode refusal. Closes the documented "category is declared by the agent" gap.
2. **Elastic precedents.** Disputes indexed as cases (`semantic_text` + `text`); a traced
   `search_precedents` step with hybrid RRF retrieval and graceful fallback; shown on the approval screen.
3. **Zapier evidence loop.** `evidence_requested` event, `POST /api/disputes/:id/evidence` guarded by its
   own secret, strict validation, proposal re-run. Fixes `hasDeliveryProof` being permanently false.
4. **AG Grid.** Real grid on `/admin`. Also fixed: the page's `h()` helper never set `aria-*` attributes,
   and the 10-second poll never redrew a dispute unless its workflow state changed, so evidence added by a
   Zap would not have appeared.
5. **AG Studio app** (`web/`): theme, data sources, custom Mandate gauge widget, agent scaffold, model proxy.
6. **PayPal MCP server.** The optional Studio analyst can read PayPal sandbox disputes and catalog records through PayPal's official MCP server. The server injects only an allow-listed set of read tools and requires approval for every MCP call; it cannot approve, submit, refund, or otherwise move money.
7. **Channel3 alternatives.** A checkout refused for being outside the mandate (wrong category or over budget)
   now searches Channel3 for in-mandate products the buyer agent could try instead, using the same search
   surface `buy-request` already uses. Never widens or changes the refusal; a search failure or missing
   Channel3 configuration just means no alternatives are returned.

## Verification status (be straight about this in the submission)

| Piece | How far it was checked |
|---|---|
| Channel3 assessment, Elastic client, Zapier events, evidence loop, analytics datasets | Unit-tested against a real in-memory SQLite database (new tests pass) |
| Existing suites (agent, draft, disputes, service, mandate, vault, channel3) | Re-run after the refactor, all pass |
| `/admin` page | Rendered in headless Chromium against a **stubbed** `agGrid` and fixture API; the real AG Grid CDN build was not loadable offline |
| Custom Mandate gauge | Bundled with React and rendered in Chromium against fixture data |
| Express routes in `app.ts`, `app.test.ts`, `checkout.test.ts`, webhook tests | **213 tests pass**; live PayPal/webhook and deployed-environment validation remains |
| `web/` AG Studio app and agent | `npm run build:web` succeeds against the installed AG packages; browser runtime, adapter, and deployed validation remain |
| Elastic and Channel3 against their live services | Channel3, Elastic, and Zapier have each had one live run; broader failure/mapping coverage remains |
| Render deployment, live webhook | **Done.** Live at `warrant-9baj.onrender.com`; a real sandbox dispute (`PP-R-VHE-10193234`) reached it and produced a correct `contest` proposal with no manual import (see K in docs/03) |
| APIMatic generation | Not done |

## Do next, in order

1. `npm install && npm test && npm run typecheck`. Keep the passing baseline recorded.
2. `npm run build:web`, open `/studio/?token=...`, and validate browser runtime behavior (see its README).
3. Copy AG's `openaiAdapter` into `web/src/openaiAdapter.js`; set `STUDIO_LLM_API_KEY`.
4. Build the demo layout in Studio and export its state so the page opens pre-built.
5. ~~Deploy to Render; confirm the live webhook~~ **Done** — live at `warrant-9baj.onrender.com`; a real sandbox dispute reached `/webhooks/paypal` and produced a correct proposal with no manual import.
6. ~~Make the Zap: Catch Hook~~ **Done** — a fresh Catch Hook received a real `proposal_updated` event from the live deployment. Still to do: the carrier lookup -> Webhooks POST back to `callbackUrl` half, which needs an `escalate_to_human` dispute (a non-UNAUTHORISED reason, no delivery proof) to actually trigger.
7. Run APIMatic on `openapi.yaml` and use the generated client in the buyer agent.
8. Enable `PAYPAL_MCP_ENABLED=true` in a sandbox environment and verify the Studio analyst can retrieve a dispute without changing it.
9. Record the demo around one story: an agent buys a "running shoe" that Channel3 knows is a phone ->
   Warrant refuses it live (autonomous) or proposes accepting the claim -> the Studio dashboard shows that
   agent's dispute rate climbing.

## Not done, possible later

- **Bryntum Scheduler/Calendar** for dispute response deadlines (PayPal gives sellers a due date). A good
  fit for the $1k prizes but a second licensed library.
- **Postman**: the three new routes are now included; run them against a configured local or deployed server.
