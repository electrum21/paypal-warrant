# Warrant Studio (AG Studio dashboard)

Merchant analytics for agent-purchase disputes, built on [AG Studio](https://www.ag-grid.com/studio/).
Served by the Warrant server at `/studio/?token=YOUR_ADMIN_TOKEN`.

## Run it

```bash
npm install                # installs ag-studio and ag-studio-react (pinned to the same version, as AG requires)
npm run build:web          # builds web/dist; the server serves it at /studio
npm run dev                # in one terminal: the Warrant server on :8787
npm run dev:web            # in another: hot-reloading Studio on :5173 (proxies /api to :8787)
```

Open `http://localhost:5173/studio/?token=$ADMIN_TOKEN`. Licence: Studio runs without one locally; for a hosted
demo request a trial key (see AG's "Installing a Licence Key" page) to remove the watermark.

## What is here

| Piece | File | Notes |
|---|---|---|
| Data sources | `src/warrant.js` | `disputes`, `agents`, `orders`, `agentSteps` from `GET /api/analytics/datasets` |
| Theme | `src/theme.js` | `studioTheme.withParams(...)`, PayPal blue; shared params, so UI, grids and charts match |
| Custom widget | `src/MandateGauge.jsx` | Purchase vs the signed mandate limit, decision, Channel3 verdict. Menu group "Warrant" |
| Agent | `src/agent.js` | "Warrant analyst": Studio's tools plus read-only `get_dispute_case` and `find_similar_cases` |
| Model proxy | server: `POST /studio-api/llm` | Keeps the provider key on the server |

## Turning the agent on

AG Studio bundles no LLM connection; you supply an adapter (`AgLlmAdapter`, in
`ag-studio`'s `api/ai/agLlmAdapter.d.ts`: one method, `executeTurn`, that takes a turn and returns a
streamed response - everything provider-specific lives in the adapter).

**Gemini, built in (default fallback):** set `GEMINI_API_KEY` and `STUDIO_LLM_PROVIDER=gemini` on the
server. `src/agent.js` falls back to `src/geminiAdapter.js` whenever `openaiAdapter.js` is still the stub
below, so no extra wiring is needed. The actual Gemini call - and, when `PAYPAL_MCP_ENABLED`, the PayPal MCP
tool-call loop, since Gemini has no native MCP connector the way OpenAI's Responses API does - runs
server-side in `src/integrations/geminiAgentBridge.ts`.

**OpenAI (takes priority if installed):** AG publishes an adapter for the OpenAI Responses API as part of
its "Direct LLM Runner" example.

1. Copy that example's `openaiAdapter` source over `src/openaiAdapter.js` (exporting `openaiAdapter`).
2. Make sure the call in `src/agent.js` (`openaiAdapter({ endpoint, key })`) matches that adapter's options.
3. Set `STUDIO_LLM_API_KEY` (and optionally `STUDIO_LLM_MODEL`) on the server; leave `STUDIO_LLM_PROVIDER`
   unset or `openai`.

Without either key configured, the dashboard still works fully; agent questions just come back with a
clear error instead of an answer.

## Building the demo layout

Studio starts blank in edit mode. AG's own guidance is to build a layout in the UI and export its state rather
than hand-write it. Suggested first page (about ten minutes):

1. **Value** widgets: open disputes, total `amount`, total `overLimitBy`.
2. **Donut**: `disputes` by `recommendedAction`.
3. **Bar**: `agents` by `disputeRatePct` (the risky agents surface first).
4. **Bar**: `disputes` count by `primaryFinding`.
5. **Mandate gauge** (Warrant group) next to a **grid** of `disputes`, with cross-filtering on.

Then export the state with the Studio API's state methods and load it as the initial state, so the page opens
pre-built. See AG's "State" page.

## Not yet verified

This was written against AG's published 3.0.0 docs without access to the packages, so it has **not been built or run**.
The pieces most worth checking first when you build: the `ai` prop's callback shape in `agent.js`, the
`api.defineAiTool` parameter builder (`s.object`, `s.number`, `s.string`), and the adapter options.
The custom widget's own logic is tested separately; it was bundled with a stub for `ag-studio` and rendered
in a browser against fixture data.
