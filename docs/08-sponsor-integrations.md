# Sponsor integrations

Warrant keeps sponsor services optional so the offline demo and tests need no credentials.
The user page exposes an **Agent capabilities** panel so a demo audience can see what
each connected service contributes, while the merchant page provides the operational
surfaces where appropriate.

## Channel3

Set `CHANNEL3_URL` and `CHANNEL3_API_KEY` to enable structured product discovery through
`POST /api/catalog/search`. The buyer demo calls this endpoint for `buy-request`; when it
is unavailable it uses the local demo catalog. Products are filtered again against the
signed shopping intent before selection. The user activity log identifies whether a
product came from Channel3 or the local fallback.

## Elastic

Set `ELASTIC_URL`, `ELASTIC_API_KEY`, and optionally `ELASTIC_INDEX`. Merchant-agent tool
events are indexed after they are written to SQLite. `GET /api/agent-events/search?q=...`
provides an authenticated read-only search endpoint for the investigation UI or an agent.
This turns the agent trace into searchable evidence rather than console-only logs.

## AG Grid

The admin page loads AG Grid from its CDN and uses it for the dispute queue. The existing
detail view remains the approval surface; AG Grid is only an operational view and cannot
approve a PayPal action. The user page labels this as the merchant's searchable dispute
workbench, keeping the technical surface out of the buyer flow.

## Zapier

Set `ZAPIER_WEBHOOK_URL` to notify a Zapier Catch Hook when a proposal is ready. The
payload includes the Warrant dispute ID, proposed action, and reason. Use Zapier for
notifications or evidence requests, not for direct PayPal submission. This makes a
merchant-facing handoff happen automatically when the dispute agent finishes.

## Render

`render.yaml` defines a Node web service with a persistent disk for SQLite. Configure the
PayPal credentials, `APP_URL`, `ADMIN_TOKEN`, and webhook ID in the Render dashboard.

## Postman and APIMatic

Import `postman_collection.json` into Postman to exercise the health, catalog, dispute
import, and list endpoints. `openapi.yaml` is the canonical API description and can be
imported into APIMatic to generate documentation or a typed client.
