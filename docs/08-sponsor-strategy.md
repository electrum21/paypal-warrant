# Sponsor strategy (internal working notes)

Written 6 Oct 2026 from the hackathon's public sponsor pages; kept up to date as work lands. This is a
planning document for us, not outward-facing copy — see `docs/05-sponsor-integrations.md` for the
reader-facing version of what each integration actually does. Prizes and criteria may change; recheck
the Devpost "Prizes" page and each sponsor's details page before submitting.

## What each sponsor track is actually judged on, and where Warrant stands

| Sponsor | What the page says it rewards | Where Warrant stood | Where it stands now |
|---|---|---|---|
| **AG Grid** | **AG Studio**: custom widgets, theming, layout, the Studio Agent Framework. "Not just AG Grid on its own" | Library loaded but **never instantiated**; the docs said it was in use | Real grid on `/admin`; a Studio dashboard with theme, custom widget and agent scaffold |
| **Channel3** | "Search, product enrichment, or recommendations" | Search only; results relabeled with the category the *buyer asked for* | Search, enrichment (verifies what was bought against Channel3's own data), and recommendations (in-mandate alternatives after a refusal) |
| Render | A deployed, working project | `render.yaml` written, never deployed | **Deployed and live** at `warrant-9baj.onrender.com`; `/health` confirms `webhookVerification: true` with the PayPal webhook registered against it |
| Bryntum | Gantt / Scheduler / Calendar | Not used | Not used (idea below) |
| Elastic, Zapier | A multi-step agent using retrieval (Elastic); automation/MCP (Zapier) | Log search; one-way webhook | Retrieval the agent uses; **the full two-way Zapier loop confirmed live** (proposal → Catch Hook, and evidence_requested → Zap posts delivery evidence back → proposal flips from escalate_to_human to contest) against the Render deployment |
| PayPal MCP | A multi-step agent using MCP | Not used | The Studio analyst reads PayPal sandbox disputes/catalog through PayPal's MCP server, on **either** OpenAI (native connector) or **Gemini** (own bridge, no OpenAI account needed) - **confirmed live against the real sandbox MCP server** |

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
7. **Gemini bridge for the Studio agent.** `STUDIO_LLM_PROVIDER=gemini` runs the Studio agent on Gemini
   instead of OpenAI - useful since an OpenAI API key needs its own account, which wasn't available this
   round. Since Gemini has no native MCP connector, `src/integrations/geminiAgentBridge.ts` and
   `src/integrations/mcpClient.ts` speak PayPal's MCP protocol directly (the official
   `@modelcontextprotocol/sdk`) and bridge tool calls into Gemini's own function-calling, with the same
   read-only allow-list either provider uses. The browser side picks it automatically whenever AG's own
   OpenAI adapter hasn't been installed.
7. **Channel3 alternatives.** A checkout refused for being outside the mandate (wrong category or over budget)
   now searches Channel3 for in-mandate products the buyer agent could try instead, using the same search
   surface `buy-request` already uses. Never widens or changes the refusal; a search failure or missing
   Channel3 configuration just means no alternatives are returned.

## Verification status (be straight about this in the submission)

| Piece | How far it was checked |
|---|---|
| Channel3 assessment, Elastic client, Zapier events, evidence loop, analytics datasets | Unit-tested against a real in-memory SQLite database (new tests pass) |
| Existing suites (agent, draft, disputes, service, mandate, vault, channel3) | Re-run after the refactor, all pass |
| `/admin` page | Rendered in headless Chromium against a **stubbed** `agGrid` and fixture API during development; **since confirmed against the real AG Grid CDN build**, including live filtering and sorting, in the demo recording |
| Custom Mandate gauge | Bundled with React and rendered in Chromium against fixture data |
| Express routes in `app.ts`, `app.test.ts`, `checkout.test.ts`, webhook tests | **215 tests pass**; live PayPal, webhook, and deployed-environment validation all confirmed (see docs/03 K) |
| `web/` AG Studio app and agent | `npm run build:web` succeeds against the installed AG packages. **The real browser chat UI is confirmed working**, not just the backend bridge: asked to chart disputes by recommended action in `/studio`, it read the schema, ran a query (self-correcting once), added a grouped bar widget, and summarised the result correctly. Three bugs were found and fixed only by that live run — see docs/05 §"PayPal MCP, and running the agent without an OpenAI key". The OpenAI-backed path remains deferred (needs an OpenAI key) |
| Gemini Studio agent + PayPal MCP bridge | **Confirmed live** (`npm run smoke:gemini-studio-agent`): real Gemini API, three ways — a plain answer, a declared non-MCP tool call left for the harness, and a `list_disputes` MCP call resolved by the bridge against the real PayPal sandbox MCP server, round-tripped into a natural-language answer naming real sandbox dispute ids |
| Channel3 against its live service | Run multiple times against the live Render deployment with varied inputs; see docs/03 K |
| Zapier against its live service | **Full two-way loop confirmed**: proposal notifications and the evidence-request callback, both against the live Render deployment; see docs/03 K |
| Elastic against its live service | Run multiple times against the live deployment. Finding: `/api/agent-events/search` only reliably matches exact IDs/tool names, not natural language; `/api/precedents`'s relevance ranking is unverified with only one case indexed |
| Render deployment, live webhook | **Done.** Live at `warrant-9baj.onrender.com`; a real sandbox dispute (`PP-R-VHE-10193234`) reached it and produced a correct `contest` proposal with no manual import (see K in docs/03) |
