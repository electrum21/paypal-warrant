# Warrant

**Dispute defense for merchants selling to AI shopping agents.**

![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6?logo=typescript&logoColor=white)
![Tests](https://img.shields.io/badge/tests-233%2B%20passing-brightgreen)
![PayPal Sandbox](https://img.shields.io/badge/PayPal-Sandbox-003087?logo=paypal&logoColor=white)
![Deployed on Render](https://img.shields.io/badge/deployed-Render-46E3B7?logo=render&logoColor=white)

![Channel3](https://img.shields.io/badge/Channel3-integrated-6f42c1)
![Elastic](https://img.shields.io/badge/Elastic-integrated-005571?logo=elastic&logoColor=white)
![Zapier](https://img.shields.io/badge/Zapier-integrated-FF4A00?logo=zapier&logoColor=white)
![AG Grid / AG Studio](https://img.shields.io/badge/AG%20Grid-Studio-E60012)
![PayPal MCP](https://img.shields.io/badge/PayPal-MCP%20server-003087?logo=paypal&logoColor=white)

AI agents are starting to buy things on people's behalf. When a buyer later tells PayPal "I never
authorized this," the merchant is left holding a payment record and nothing else — no proof of what
the user actually told their agent to do. Warrant fixes that: a buyer's agent presents a **signed
mandate** (the user's spending limits, cryptographically signed) when it buys. If the purchase is
disputed, Warrant checks it against that mandate with plain code, assembles the evidence, and
proposes a response through the **PayPal Disputes API** (sandbox). A human merchant approves before
anything is ever submitted.

The one design rule, enforced in code, not just policy: **the LLM writes words; code decides; the
merchant approves; only then does anything reach PayPal.**

## Live demo

**Start here: https://warrant-9baj.onrender.com** — a single landing page linking every other page below,
with the token already filled in. PayPal sandbox only; no real money ever moves.

| Page | What you'll see |
|---|---|
| [Buyer — `/user`](https://warrant-9baj.onrender.com/user) | Sign in with PayPal, set a spending permission, and watch the agent shop autonomously. No token needed |
| [Merchant approval — `/admin?token=...`](https://warrant-9baj.onrender.com/admin?token=7oi5q9Mi-3wkUg-iCUrDFm_3) | A real dispute queue (AG Grid), the deterministic finding, the AI-drafted note, one click to approve or dismiss |
| [Studio dashboard — `/studio?token=...`](https://warrant-9baj.onrender.com/studio?token=7oi5q9Mi-3wkUg-iCUrDFm_3) | An AG Studio analytics dashboard, pre-built with five charts, plus a Gemini-backed chat agent that can query the live data and build new ones on request |
| [`/health`](https://warrant-9baj.onrender.com/health) | Feature flags — confirms what's actually turned on in this deployment |

The `?token=...` on the merchant and Studio links is `JUDGE_TOKEN`, a disposable credential separate
from the maintainer's own `ADMIN_TOKEN`, set specifically for judging and rotated/removed afterward.
Prefer to run your own copy instead? See `docs/03-testing-and-usage.md`.

**Demo video:** https://youtu.be/FAMkX6030SE


https://github.com/user-attachments/assets/4edf31d9-f7df-4e50-a40c-a0344bb7f7b8



## What's real here

- **233+ automated tests**, plus live runs against the real PayPal sandbox: order creation and capture,
  dispute creation and import, the contest and accept-claim response paths, a live webhook that turns
  a real sandbox dispute into a correct proposal with **zero manual steps**, and a complete
  browser-driven autonomous (no-click) checkout through PayPal Vault.
- **Three optional sponsor integrations run live, not just wired up:** Channel3 (product search *and*
  verification of what was actually bought), Elastic (semantic precedent search over past disputes),
  and Zapier (a two-way loop: Warrant asks for delivery evidence, a Zap fetches it and posts it back,
  the proposal re-runs and flips).
- **An AI agent with PayPal's own MCP server**, bridged to work on Gemini with no OpenAI account
  needed (`src/integrations/geminiAgentBridge.ts`) — confirmed live against the real sandbox MCP
  server and against the real browser chat UI, including building its own dashboard charts.
- **Deployed, not just "deployable.**" Render, with a persistent disk, a registered PayPal webhook, and
  a real sandbox dispute that has already round-tripped through it end to end.

Full verification log, with dates and exact observed PayPal responses: `docs/03-testing-and-usage.md`
part K.

## Why the AI is trustworthy with money

An LLM (Gemini or Anthropic) writes two things: a short explanation for the merchant and a factual
note for PayPal's reviewer. It never decides the outcome, never calls PayPal, and never sees
buyer-written dispute text without it being marked as untrusted quoted data. Its output must be JSON,
under a length limit, and **every number in it must already exist in the verified facts** — an
invented amount is rejected outright. Any failure (no key, bad JSON, a rule violation) falls back to a
plain template, and the merchant always sees which one they're looking at. The identifiers that matter
to PayPal's reviewer (mandate ID, hash, signature result, the buyer's own words) are written by code,
never by the model, and sit at the top of every note.

## Three examples it handles today

| What happened | Warrant proposes | Why |
|---|---|---|
| Agent bought $115 shoes; mandate limit was $120. Buyer disputes. | **Contest.** | The buyer's own signed instructions allowed it. |
| Agent bought $135 shoes; limit was $120. Buyer disputes. | **Offer to refund the $15 over.** | PayPal's sandbox doesn't offer a partial refund at this stage, so Warrant tells the merchant that instead of sending something PayPal would reject. |
| Agent bought a $115 gadget; the mandate only covered footwear. Buyer disputes. | **Accept the claim.** | The purchase went beyond what the buyer allowed — contesting it would be weak. |

## Run it yourself

```
npm install
cp .env.example .env     # add PayPal SANDBOX credentials
npm test                 # no credentials needed, 233+ tests
npm run db:init
npm run smoke:auth       # confirms your keys work
npm run smoke:order      # creates a sandbox order and prints an approval link
npm run dev              # server on :8787 (webhooks, checkout, /admin, /studio)
```

Set `ADMIN_TOKEN` in `.env`, then open `http://localhost:8787/admin?token=<ADMIN_TOKEN>`.
Set `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` for real LLM explanations (optional; a template is used
without one). Without a public webhook URL you can still test everything: import a sandbox dispute by
its ID on the admin page. Want to try the `/user` sign-in flow locally too? See
`docs/07-sso-quick-run-guide.md` (needs a public tunnel, e.g. ngrok, for PayPal's OAuth callback).

```
npm run demo:offline                                  # whole story, fake PayPal, no credentials
npm run demo -- register                               # live: register the demo user's and agent's keys
npm run demo -- buy-auto over                           # live: pay with no click; out-of-mandate buys are refused
npm run demo -- buy-request-auto "Buy trail running shoes under $120"   # natural language -> real sandbox order
npm run demo -- import <PAYPAL_DISPUTE_ID>              # turn a sandbox dispute into a proposal
```

Point any of these at the live Render deployment instead of your own machine by setting `WARRANT_URL`
and `ADMIN_TOKEN` as environment variables first. Full step-by-step guide, every variable explained,
and a troubleshooting table: `docs/03-testing-and-usage.md`.

## How it works

1. Buyer agent `POST /api/checkout` with a **user-signed mandate** and an **agent-signed cart** (the
   exact purchase). Warrant verifies both signatures, checks the cart matches the mandate, accepts
   each cart once, and creates the PayPal order.
2. The buyer approves (or, in autonomous mode, a previously-connected PayPal Vault payment method is
   charged with no click).
3. A dispute is raised on that payment. A verified `CUSTOMER.DISPUTE.CREATED` webhook or a manual
   import runs the pipeline: look up the order, verify the mandate, decide a response, build an
   evidence pack, have an LLM explain it.
4. The merchant reviews the proposal on `/admin`, can edit the note, and approves or dismisses.
5. On approve: evidence, an offer, or an accept-claim is sent to PayPal with a stable idempotency key.
   Failures are recorded and retryable.

## Sponsor integrations

Every one of these is optional — the offline demo and full test suite need none of them.

- **Channel3** — real product search for the buyer agent, *and* verification: Warrant checks what was
  actually bought against Channel3's own product data, and a confirmed category mismatch becomes a
  blocking finding. A refused checkout gets in-mandate alternatives from the same search.
- **Elastic** — the merchant agent's investigation trace is indexed and searchable; disputes are
  indexed as cases and a hybrid (semantic + keyword) search surfaces similar past outcomes on the
  approval screen, advisory only.
- **Zapier** — a proposal notification, and a full evidence-request loop: Warrant asks for delivery
  proof it doesn't have, a Zap fetches it from the carrier and posts it back, and the proposal re-runs.
- **AG Grid / AG Studio** — a real sortable, filterable dispute queue on `/admin`, and a full analytics
  dashboard at `/studio` (custom Mandate-gauge widget, PayPal theme, a pre-built chart layout, and an
  optional chat agent with read-only dashboard and PayPal-MCP tools).
- **PayPal's official MCP server** — gives the Studio agent read-only sandbox dispute/catalog context,
  on OpenAI's native connector or, with no OpenAI account at all, a from-scratch Gemini bridge
  (`src/integrations/geminiAgentBridge.ts`) speaking MCP directly.
- **Render** — the live deployment above, with a persistent disk for SQLite.
- **Postman / OpenAPI** — `postman_collection.json` and `openapi.yaml` describe the full HTTP API.

Full detail on what each one changes about a dispute outcome, with exact verification notes:
`docs/05-sponsor-integrations.md`.

## Layout

- `src/mandate/` — sign, verify and check mandates and carts (ed25519, canonical JSON)
- `src/disputes/` — deterministic decision, evidence pack, and the propose/approve/reject service
- `src/ai/` — LLM drafting with validation and template fallback
- `src/paypal/` — sandbox-pinned REST client, Disputes API client, webhook verification
- `src/server/` — Express app: webhook, checkout, admin API, admin page
- `src/db/` — SQLite schema
- `src/integrations/` — Channel3, Elastic, Zapier, PayPal MCP, and the Gemini agent bridge
- `src/agent/`, `src/scripts/demo*.ts` — the scripted buyer agent and live/offline demo CLIs
- `web/` — the AG Studio dashboard (Vite + React)

## Honest scope

- The buyer agent and merchant agent are both built by us; PayPal's real dispute process is not
  simulated beyond the sandbox.
- The mandate format is **AP2-inspired, not AP2-compliant**.
- Decisions are proposals. The LLM explains and drafts notes; it never decides whether money moves.
- Mandate descriptions are third-party text, always shown to the LLM as quoted data and rendered as
  plain text only.
- This is not legal advice, and a signed mandate is evidence, not a guarantee of any dispute outcome.
- Full list of known gaps and what's deliberately not defended yet (category is agent-declared unless
  Channel3 confirms it, demo key custody, and more): section 10 of `docs/01-project-overview.md`.

## Docs

- `docs/01-project-overview.md` — full technical reference: architecture, decision rules, trust model
- `docs/02-plain-english-summary.md` — the idea with no jargon
- `docs/03-testing-and-usage.md` — step-by-step setup, every env var, troubleshooting, and the full
  verification log
- `docs/05-sponsor-integrations.md` — what each sponsor integration does and how it was verified

MIT licensed.
