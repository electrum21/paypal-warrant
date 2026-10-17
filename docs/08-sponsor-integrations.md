# Sponsor integrations

Every sponsor service is optional, so the offline demo and tests need no credentials. Each one
below is described by **what it changes in a dispute outcome or a merchant's day**, not just
that it is connected. The user page's **Agent capabilities** panel shows which are live.

## Channel3: search, then verify what was bought

Set `CHANNEL3_URL` and `CHANNEL3_API_KEY`.

- **Search.** `POST /api/catalog/search` finds products for the buyer agent (unchanged).
- **Verification (new).** The agent-signed cart can carry a `productId` (the Channel3 id). At
  checkout, and again at dispute time if no snapshot exists, Warrant calls
  `GET /v1/products/{id}` and compares Channel3's categories with the mandate's
  `allowedCategories` and with the category the agent declared. The result is stored in
  `product_checks` and shown on the approval screen.
- **Effect on decisions.** Only one outcome changes a decision: Channel3 says the product is in a
  category the mandate does not allow. That becomes the blocking finding
  `PRODUCT_CATEGORY_NOT_ALLOWED`, so the proposal is to accept the claim. An allowed category
  that differs from what the agent declared is a warning only. Anything Warrant cannot map, a
  404, or a Channel3 outage is "unknown" and changes nothing.
- **Evidence.** The note sent to PayPal gains a product section: title, brand, and the range of
  retailer prices Channel3 listed (current listings, not a price history).
- **Autonomous mode.** Because it moves money with no click, an autonomous purchase whose signed
  product is out of category is refused (HTTP 422) before any charge.

Limits: the mapping from Channel3's category paths to Warrant's vocabulary
(`footwear`, `electronics`, `apparel`, `home`) is a small keyword table in
`src/integrations/channel3.ts`. Extend it for new categories.

## Elastic: precedents for the merchant agent

Set `ELASTIC_URL`, `ELASTIC_API_KEY`; optional `ELASTIC_INDEX`, `ELASTIC_CASE_INDEX`.

- **Agent trace (unchanged).** Tool events are indexed; `GET /api/agent-events/search?q=` searches them.
- **Dispute cases (new).** Each dispute is indexed as a case after it is proposed, evidence arrives,
  or the merchant decides. The case text sits in a `semantic_text` field plus a plain `text` field.
- **Precedent retrieval (new).** While building a proposal, the merchant agent runs a traced
  `search_precedents` step: hybrid search (semantic + BM25 fused with RRF) for similar past cases,
  falling back to keyword search if the cluster refuses hybrid, and to no precedents if Elastic is
  down. The approval screen shows "3 similar past cases ... you submitted 2 and dismissed 1".
- **Advisory only.** Precedents never change the proposed action. `GET /api/precedents?q=` exposes
  the same search to the Studio agent.

## Zapier: the evidence loop

Set `ZAPIER_WEBHOOK_URL` and `EVIDENCE_WEBHOOK_SECRET`.

Warrant sends one of three events to a Catch Hook:

| Event | When | What the Zap does |
|---|---|---|
| `proposal_ready` | A proposal exists | Route it to the merchant (Slack, email, a ticket) |
| `evidence_requested` | The proposal is blocked on evidence only the merchant's systems have (today: delivery proof) | Look up the carrier or order system, then `POST` the result to `evidenceRequest.callbackUrl` |
| `proposal_updated` | The proposal changed after evidence arrived | Tell the merchant |

The callback is `POST /api/disputes/:id/evidence` with header `x-warrant-evidence-secret` and body
`{ "carrier", "trackingNumber", "deliveredAt" }`. Fields are strictly validated (this ends up in a
note sent to PayPal) and the proposal is re-run. An "item not received" dispute that used to
escalate to a human can now become a contest once delivery proof arrives. The secret lets a Zap
add evidence without holding the admin token, which can approve responses. **A Zap can never
approve, dismiss or submit anything.** The merchant can also add delivery proof by hand on the
approval screen.

## AG Grid and AG Studio

- **Approval screen (`/admin`).** The dispute queue is a real AG Grid (Community, major 33, from a
  CDN) with sorting, filtering, a quick filter and row selection. The detail pane remains the only
  place a response can be approved.
- **Studio dashboard (`/studio`).** `npm run build:web` builds a Vite + React app around
  `ag-studio-react`. Data sources: `disputes`, `agents`, `orders`, `agentSteps`, served by
  `GET /api/analytics/datasets`. It includes a PayPal theme, a custom **Mandate gauge** widget, and an
  optional "Warrant analyst" agent. See `web/README.md`.
- The Studio agent has read-only Warrant tools. There is deliberately no tool that approves,
  dismisses, submits or refunds.

### PayPal MCP, and running the agent without an OpenAI key

`POST /studio-api/llm` is the one place a provider key is used, and `STUDIO_LLM_PROVIDER` picks how:

- **`openai` (default).** Proxies straight to an OpenAI Responses-compatible endpoint
  (`STUDIO_LLM_URL`/`STUDIO_LLM_API_KEY`). When `PAYPAL_MCP_ENABLED=true`, the proxy also hands the
  request a native `type: "mcp"` tool pointing at PayPal's sandbox MCP server - OpenAI's Responses API
  connects to it, lists tools, and runs calls itself; Warrant only allow-lists which tools
  (`list_disputes`, `get_dispute`, `list_product`, `show_product_details`) and forwards a PayPal
  access token.
- **`gemini`.** Runs a bridge in-process (`src/integrations/geminiAgentBridge.ts`) against
  `GEMINI_API_KEY`/`GEMINI_MODEL` instead - no OpenAI account needed. Gemini's API has no native MCP
  connector, so when `PAYPAL_MCP_ENABLED=true` the bridge speaks MCP itself
  (`src/integrations/mcpClient.ts`, the official `@modelcontextprotocol/sdk`, same allow-list): it lists
  the sandbox server's tools, hands them to Gemini as function declarations alongside AG Studio's own
  tools, and - only for an MCP tool call - runs it and feeds the result back, looping invisibly to the
  Studio harness. A call to one of AG's own tools (dashboard widgets, `get_dispute_case`, ...) is left
  for the harness to execute, exactly as the OpenAI adapter leaves it.
- The browser side mirrors this: `web/src/agent.js` prefers `openaiAdapter.js` (AG's own example, copied
  in by hand) when it has been installed, and otherwise falls back to the built-in `web/src/geminiAdapter.js`.
- **Verified live (2026-10-17), backend and browser both.** `npm run smoke:gemini-studio-agent` exercised
  the real Gemini API against the real PayPal sandbox MCP server: a plain answer, a call to a declared
  non-MCP tool left unresolved for the harness, a `list_disputes` MCP call resolved by the bridge and
  round-tripped into an answer naming real sandbox dispute ids, and a discriminated-union tool schema
  (`anyOf` of two shapes). The user then drove the real browser chat UI at `/studio` and asked it to
  "chart disputes by recommended action": it read the schema, ran `executeQuery` (self-correcting once
  after guessing an invalid aggregation function), added a grouped bar widget, and summarised the result
  correctly (2 contest, 1 accept_claim, 1 offer_partial_refund) - the full path (`geminiAdapter.js` through
  AG Studio's real `createAiHarness`, into the Gemini bridge, through its own tool-call loop) confirmed
  working end to end, not just the backend piece.
- **Two bugs found and fixed only by that live browser run** (neither the unit tests nor the single-turn
  smoke script caught them, since both are specific to AG Studio's real multi-turn harness):
  1. `executeTurn` must return `{stream, complete}` **synchronously** per `AgLlmAdapter` - an `async
     executeTurn` instead returns a Promise, so the harness's `handler.stream` was `undefined`.
  2. Gemini 3 requires a `thoughtSignature` replayed back on every `functionCall` part, but AG Studio's own
     tool-call wire format has no field to carry one through the browser round trip, so a client tool call
     reconstructed from history lost it. Google documents a dummy signature for exactly this case (a call
     being reconstructed, not one just received live) - MCP tool calls never hit this, since those are
     resolved inside one `executeTurn` using Gemini's own raw parts, signature intact.
  Also fixed: `sanitizeSchema()` originally dropped `anyOf`/`oneOf`/`$ref`/`$defs`, collapsing a
  discriminated-union parameter (like `executeQuery`'s own) to a bare object - Gemini then guessed a shape
  that didn't match, and Studio's own validation rejected it ("Value did not match any of the discriminated
  types"). Now preserved, with cycle/depth protection for the self-referential filter-group shape.

## Render

`render.yaml` defines a Node web service with a persistent disk for SQLite and now runs
`npm run build:web` at build time. A public URL is also what lets PayPal's webhook reach
`/webhooks/paypal`, which has so far only been exercised locally. Set the PayPal credentials,
`APP_URL`, `ADMIN_TOKEN` and webhook ID in the dashboard.

## Postman

`postman_collection.json` and `openapi.yaml` describe the HTTP API. The new routes
(`/api/disputes/{id}/evidence`, `/api/precedents`, `/api/analytics/datasets`) are in
`openapi.yaml`.
