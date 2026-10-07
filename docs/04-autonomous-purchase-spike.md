# Autonomous purchase: PayPal Vault implementation

**Question:** can the buyer agent pay without the human "Pay Now" click?
**Result (run on the project's PayPal sandbox):** feasible. `start` created a vaulting order, `capture` returned `vault.status = VAULTED` with a token, and `charge` captured $15.00 with no approval step (the order came back `COMPLETED` on creation).

**Built on top of it:** `/api/checkout` now has `mode: "autonomous"` (see the end of this file). The PayPal Vault connection flow is also working: the user approves a setup token in the sandbox and Warrant exchanges it for a payment-method token. The full browser-driven autonomous checkout has now been verified against the PayPal sandbox.

## What PayPal's docs describe

1. The buyer approves once. The first order is created with `payment_source.paypal.attributes.vault` (`store_in_vault: ON_SUCCESS`, `usage_type: MERCHANT`, `customer_type: CONSUMER`).
2. After that order is captured, PayPal returns a vault token at `payment_source.paypal.attributes.vault.id`.
   - If `vault.status` is `VAULTED`, the token is in the response.
   - If it is `APPROVED`, the token arrives later in a `VAULT.PAYMENT-TOKEN.CREATED` webhook. Warrant's webhook receiver has never been run, so this case would block the demo until webhooks work.
3. Later, a new order is created with `payment_source.token = { id, type: "PAYMENT_METHOD_TOKEN" }`. No approval link and no buyer present.

## Sandbox requirements

- **Vault must be enabled** on the sandbox app (Developer Dashboard, app settings) and the sandbox business account.
- **Saving a PayPal wallet needs approval** (Billing Agreements / reference transactions). If it is missing, PayPal returns `NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE` (HTTP 422).
- **Going live needs PayPal vetting.** Sandbox is the only target here, but this is a limit on any production claim.

## Run it

```
npm run smoke:vault -- start                 # creates an order that asks to vault the buyer's account
# open the link in a private window, approve as the sandbox PERSONAL account
npm run smoke:vault -- capture <ORDER_ID>    # prints the vault block (VAULTED or APPROVED)
npm run smoke:vault -- charge <TOKEN_ID>     # charges $15.00 with no approval step
```

Reading the result:

| Result | Meaning | Next |
|---|---|---|
| `start` fails with `NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE` | Account or app not enabled | Enable Vault in app settings; if it persists, ask PayPal to enable reference transactions for the sandbox account |
| `capture` shows `VAULTED` with an id | Token available | Run `charge` |
| `capture` shows `APPROVED` | Token only via webhook | Needs the Render deploy and webhook verification first |
| `charge` succeeds | **Feasible** | Build the autonomous flow below |

## How it fits Warrant (built)

Only the payment step changes. Mandate and cart checks stay as they are.

- `payment_tokens` table (one saved PayPal account per user) and `POST /api/users/payment-token` (admin) to link a vault token to a registered user. In the demo: `npm run demo -- link-payment <VAULT_TOKEN_ID>`.
- `POST /api/checkout` takes `mode: "approve"` (default, unchanged: returns a PayPal link) or `mode: "autonomous"`.
- In autonomous mode, after the signatures and the cart-replay check pass:
  - **Out-of-mandate purchases are always refused (422), whatever `ENFORCE_MANDATE` says.** With no human in the loop, nothing outside the mandate is charged. Recording and later defending an out-of-mandate sale still works in `approve` mode, where a person clicks.
  - No linked payment method gives 409 and no charge.
  - The charge uses the signed cart id as the PayPal request id, so a retry cannot charge twice. A refused or failed charge gives 502 and records no order, so the same cart can be retried.
  - On success the order is recorded with its capture id straight away (no return page needed), so disputes can match it.
- Demo: `npm run demo -- buy-auto <within|over|category>`. `over` and `category` should be refused with the findings shown; `within` should pay.

**Still open before calling this safe:** the vault token lets the merchant charge any amount, so the mandate check is the only guard. One mandate can still back several purchases (no cumulative limit), and the token is stored unencrypted in SQLite. Both are in the trust-model list in `docs/01-project-overview.md`.

## What was added

- `src/paypal/client.ts`: `createVaultingOrder`, `vaultFromOrder`, `getOrder`, `chargeVaultedToken`
- `src/scripts/smoke-vault.ts` and the `smoke:vault` npm script
- `src/paypal/vault.test.ts`: request shapes, stable request IDs, separate capture, PayPal refusals surfaced
- `src/server/checkout.test.ts`: autonomous-mode tests (charge, no token, out-of-mandate, bad signatures, replay, PayPal failure, linking)


## Spending limits, single use and reservation (autonomous mode)

Status: implemented and unit-checked locally. The underlying Vault charge has also been run against the PayPal sandbox; the full `/api/checkout` reservation flow still uses mocked PayPal tests.

- The user-signed mandate may carry `maxTotalAmountCents` (cumulative cap) and `maxPurchases`. Both are inside the signed
  content, so the agent cannot widen them without breaking the signature.
- Autonomous mandates are **single-use unless `maxPurchases` is set**. Approval-based checkout is unchanged.
- Before PayPal is called, `/api/checkout` writes a `mandate_uses` row (`RESERVED`) in an IMMEDIATE SQLite transaction that
  also checks the limits. Counted usage = `RESERVED` + `CAPTURED` + `UNKNOWN`.

| Outcome of the PayPal call | Row becomes | Budget | HTTP |
|---|---|---|---|
| Payment `COMPLETED` with a capture id | `CAPTURED` | consumed once | 201 |
| PayPal 4xx refusal, or capture `DECLINED`/`FAILED` | `RELEASED` | returned | 502, `outcome: "REFUSED"` |
| Network error, timeout, 5xx, 408/429, or non-completed status | `UNKNOWN` | **held** | 502, `outcome: "UNKNOWN"` |
| Process dies mid-charge | stays `RESERVED` | held | n/a |

Retrying the same signed cart re-uses the PayPal idempotency key (`charge-<cartId>`), so `RESERVED`/`UNKNOWN` carts resolve
without a second charge. A different cart cannot spend held budget. Unresolved rows: `GET /api/mandate-uses?status=UNKNOWN`
(admin token).

Known limits:
- Duplicate in-flight requests for one cart are rejected in-process; across processes only PayPal's idempotency key protects you.
- If the order-create call succeeds and the separate capture call is refused, the row is `RELEASED` but a PayPal order exists.
- There is no endpoint yet to manually resolve an `UNKNOWN` row; it is listed, and retrying the cart is the only resolution path.


## Revocation, pause and payment-authorization checks (autonomous mode)

Status: implemented and unit-checked locally. The HTTP control routes are covered by the server tests; the sandbox verification here applies to the payment connection and Vault charge, not to every possible control timing edge case.

Routes (all `POST`):

| Route | Who may call it |
|---|---|
| `/api/mandates/:id/revoke` | the user (signed), or the merchant admin for a mandate Warrant already stores |
| `/api/users/:id/pause-agent` | the user (signed), or the merchant admin |
| `/api/users/:id/resume-agent` | **the user only** (signed). The admin token gets a 403 |
| `/api/users/:id/revoke-payment` | the user (signed), or the merchant admin |

The user authorizes with `{ "signedControl": { "request": { action, userId, subjectId, reason?, issuedAt, nonce }, "signature" } }`,
signed with the same user key that signs mandates (`signControl` in `src/mandate/control.ts`). A request is rejected if the
signature does not match the registered user key, the action/subject does not match the route, `issuedAt` is more than
5 minutes from the server clock, or the nonce was already used (409).

Before every autonomous charge Warrant now checks, and refuses with a 422 and a finding carrying the reason:
`MANDATE_REVOKED`, `AGENT_PAUSED`, `PAYMENT_AUTHORIZATION_REVOKED`, `PAYMENT_AUTHORIZATION_EXPIRED`.
These run before budget is reserved, so a refusal consumes nothing. `payment-token` linking accepts an optional
`expiresAt` (ISO 8601); re-linking makes the authorization active again.

Design notes:
- Everything the user does is appended to `control_events` (who, what, server time, via signature or admin). Checkout,
  dispute processing and the evidence pack all read this one log.
- A user may revoke a mandate Warrant has never seen. Only a revocation by the mandate's own user counts, so one user
  cannot pre-revoke another's mandate id.
- Disputes judge pause and revocation **as of the purchase time**. A stop issued after the purchase is listed in the
  evidence but is not held against it.
- Pause stops autonomous charging only; approval-based checkout records `AGENT_PAUSED` as a finding like any other.

Known limits:
- Revocation or pause cannot recall a charge already sent to PayPal. It applies to every charge not yet sent; the
  check and the PayPal call are in the same synchronous step, so none can slip between them in one process.
- A signed request is replay-protected by nonce and a 5-minute window; there is no per-user rate limit on these routes.
- The admin token can stop but not resume, but it can still stop any user's agent. That is a deliberate merchant-safety
  capability and also a denial-of-service lever if the token leaks.
- `openapi.yaml` and the Postman collection include these routes; generated-client validation remains.


## User page prototype (`/me`)

A single page, served by the Warrant server, where a person signs in their own browser instead of using the demo scripts:
create a key, register it, sign a spending rule (per-purchase cap, optional total cap and purchase count, category,
validity), and pause / resume / cancel a rule / cancel the saved payment. Only signatures leave the browser.

What was checked: the page's real signing code produces spending rules and stop requests that the server's own
verification accepts (`src/server/userPage.test.ts`), and the page's buttons were clicked through in headless Chromium
with the API faked (each button sends the right signed request to the right route). **Not checked:** the page against a
live server, other browsers, or phones.

Limits:
- **Prototype key storage.** The private key sits in the browser's local storage (as a JWK). Anyone with access to the
  browser, or any script injected into this origin, can sign as the user. A real product needs a device keystore or passkey.
- Signing needs a secure page (https or localhost). Over plain http the page shows a message and cannot sign.
- Needs a browser with Ed25519 in Web Crypto (recent Chrome, Firefox, Safari).
- The user controls page now self-registers the public key through `/api/me/public-key`, so an end user never
  receives or enters the merchant admin token. This is a demo bootstrap; production should bind the key to an
  authenticated account or passkey. The admin-protected `/api/users` route remains for backend operations.
- The page cannot show purchases or remaining budget: there is no user-facing read route yet.
- The agent still receives the signed rule by copy and paste.
