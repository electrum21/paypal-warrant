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

## Render

`render.yaml` defines a Node web service with a persistent disk for SQLite and now runs
`npm run build:web` at build time. A public URL is also what lets PayPal's webhook reach
`/webhooks/paypal`, which has so far only been exercised locally. Set the PayPal credentials,
`APP_URL`, `ADMIN_TOKEN` and webhook ID in the dashboard.

## Postman

`postman_collection.json` and `openapi.yaml` describe the HTTP API. The new routes
(`/api/disputes/{id}/evidence`, `/api/precedents`, `/api/analytics/datasets`) are in
`openapi.yaml`.
