# Technical details behind the user experience

This document describes the implementation details that should remain behind the
user-facing Agent Controls experience. It is intended for contributors, judges,
and future maintainers rather than ordinary users.

## Product boundary

The visible product promise is:

```text
User sets a permission
  -> buyer agent finds a product
  -> Warrant verifies the purchase
  -> PayPal processes the payment
  -> user sees a receipt
```

The UI should not require users to understand cryptographic keys, mandate hashes,
agent signatures, vault token IDs, cart IDs, or administrative credentials.

## Identity and key custody

Warrant currently uses Ed25519 key pairs for the demo trust boundary:

- The user key signs the spending permission and user controls.
- The buyer-agent key signs the concrete cart.
- The server stores public keys and verifies signatures.
- Private keys remain in the browser or local demo identity files.

The user key proves that the user authorized the permission. The agent key proves
which agent selected the exact purchase. The agent cannot widen a permission
because it cannot produce a valid user signature for modified limits.

The browser bootstrap routes are:

- `POST /api/me/public-key` registers the browser user's public key.
- `POST /api/me/agent-key` registers the browser demo agent's public key.

The admin-protected registration routes remain available for backend and CLI
operations. Production should replace demo self-registration with an authenticated
account, passkey, wallet binding, or another trusted identity issuer.

Replacing a registered key must be explicit. A different key is rejected unless
the request includes an intentional replacement flag, because replacing a key
invalidates permissions signed by the previous key.

## Signed shopping permission

The user-facing permission form becomes a signed mandate containing:

- Plain-language shopping intent
- Currency
- Maximum amount per purchase
- Optional cumulative spending cap
- Maximum number of purchases
- Allowed product categories
- Allowed merchant IDs
- Start and expiration times
- A unique mandate ID and nonce

The browser signs the canonical mandate and produces a mandate hash. The signed
mandate is the durable proof of what the user authorized.

The UI should show a plain-language permission summary such as:

```text
Buy trail running shoes
Spend up to $120 per purchase
Make 1 purchase
Use this permission for 24 hours
```

The signed JSON and mandate ID can remain under an expandable technical-details
section or receipt details view.

## Agent-signed cart

After product discovery, the buyer agent creates a cart containing:

- A unique cart ID
- The mandate ID and mandate hash
- Agent ID
- Merchant ID
- Amount and currency
- Product category
- Creation timestamp

The agent signs this exact cart with its own private key. Warrant verifies:

1. The mandate signature matches the registered user key.
2. The cart signature matches the registered agent key.
3. The cart is bound to the mandate.
4. The cart matches the purchase submitted for checkout.

This separates user authorization from agent action:

```text
User signs what is allowed
Agent signs what it chose
Warrant checks both
```

## Product discovery

The buyer agent can search Channel3 through:

```text
POST /api/catalog/search
```

If Channel3 is unavailable, the demo visibly falls back to the local catalog.
Product selection must still satisfy the signed amount, category, currency, and
merchant constraints before a cart is created.

Production should verify product identity and category server-side from a trusted
merchant catalog rather than trusting category data supplied by the agent.

## Autonomous payment

Autonomous mode is represented by:

```json
{ "mode": "autonomous" }
```

Before charging, Warrant checks:

- The user and agent signatures
- Mandate limits and expiration
- Merchant and category restrictions
- Pause and revocation state
- Replay protection
- Cumulative budget availability
- A linked, active PayPal vaulted payment authorization

The PayPal vaulted payment method is authorized once by the user through PayPal.
Warrant stores the provider token reference, not the user's PayPal password or
full card details. The token must be created in the same PayPal environment and
application credentials used for the autonomous charge.

The low-level smoke commands are developer diagnostics only:

```text
npm run smoke:vault -- start
npm run smoke:vault -- capture <ORDER_ID>
npm run smoke:vault -- charge <TOKEN_ID>
```

A production UI should replace these commands with a PayPal redirect flow and
should never expose order IDs or vault token IDs as user tasks.

## Budget reservation and replay protection

Autonomous checkout reserves budget before calling PayPal. Mandate usage states
are:

- `RESERVED`: a charge is in progress or its outcome is not yet known.
- `CAPTURED`: PayPal confirmed the payment.
- `RELEASED`: PayPal definitively refused the charge.
- `UNKNOWN`: the result could be ambiguous and requires reconciliation.

Each cart ID is used as the PayPal idempotency key and is accepted only once.
This prevents a retry or process restart from charging the same signed cart twice.

Definite PayPal refusals release the reservation. Network errors, timeouts, and
ambiguous provider responses keep the reservation held as `UNKNOWN` until it is
resolved.

## Multiple purchases

The permission's purchase count is a maximum number of uses. In the current
one-click flow, selecting five purchases causes five sequential checkout
requests, each with a new signed cart under the same mandate.

Sequential processing is intentional:

- It avoids concurrent duplicate charges.
- It makes progress visible.
- It stops at the first failure.
- It allows the user to see how many purchases completed.

The UI should report both requested and completed counts and show each receipt.

## User controls

User controls are signed with the user key and protected against replay using
fresh timestamps and nonces:

- Stop new purchases: pauses the user's agent.
- Allow new purchases: removes the pause.
- Remove saved payment access: revokes the linked payment authorization.
- Cancel one permission: revokes a specific mandate.

These controls apply before a new charge is sent to PayPal. They do not
retroactively reverse a payment that has already been submitted.

## Receipts and purchase history

The user page can request its own order history through a user-signed route:

```text
POST /api/users/:id/orders
```

The response should be presented as receipts, not database rows. Useful user
fields are:

- Amount and currency
- Product category or description
- Payment status
- Timestamp
- Merchant display name

Technical fields such as PayPal order ID, capture ID, mandate ID, and cart ID
belong in an expandable details view.

After autonomous checkout, the UI should refresh this history automatically and
show a concise result:

## PayPal sign-in and payment connection

The consumer page now supports a PayPal Sandbox identity flow:

1. `/auth/paypal/start` creates a short-lived OAuth state and redirects to
   PayPal's Sandbox authorization page.
2. `/auth/paypal/callback` exchanges the authorization code server-side,
   retrieves the OpenID Connect profile, and creates an HttpOnly Warrant
   session cookie.
3. The stable PayPal subject becomes the internal user ID
   (`paypal:<subject>`). The user's email and display name are display-only
   profile data.
4. The browser creates its signing key automatically after sign-in and binds
   the public key to that authenticated user.

Identity sign-in and payment authorization are deliberately separate. The
**Connect PayPal payment method** action creates a PayPal Vault setup token,
redirects the user to PayPal for approval, and exchanges the approved setup
token for a payment method token on the server. Only the provider token
reference is stored; it is never rendered in the browser.

The PayPal app must have the Login with PayPal/OpenID scopes enabled and the
callback URL configured as:

```text
{APP_URL}/auth/paypal/callback
```

For local Sandbox testing, set `APP_URL=http://localhost:8787`. A deployed
environment must use its public HTTPS URL. `PAYPAL_LOGIN_CLIENT_ID` and
`PAYPAL_LOGIN_CLIENT_SECRET` can be set when Login with PayPal uses a separate
PayPal app; otherwise the REST app credentials are used.

The Vault connection and complete browser-driven autonomous checkout have been
verified against the PayPal Sandbox:
setup-token approval opens the PayPal buyer flow, and the approved setup token
is exchanged server-side for a payment-method token. The autonomous checkout
created and captured an order without another buyer approval click.

```text
5 purchases completed
Total charged: $199.95
```

## Merchant dispute workflow

The merchant page is a separate operational surface. When a dispute is imported
or received through a verified webhook, the merchant agent:

1. Observes the dispute.
2. Retrieves the purchase and signed authorization.
3. Checks the mandate and user controls at purchase time.
4. Gathers available evidence.
5. Recommends a response.

The merchant still approves or dismisses the proposal. The agent must not submit
a dispute response autonomously.

## UX simplification boundary

The following should be visible to a normal user:

- What the agent may buy
- Maximum amount
- Number of purchases
- Expiration
- Whether PayPal payment access is connected
- Progress and receipts
- Stop and revoke controls

The following should be hidden by default:

- Ed25519 implementation details
- PEM keys
- Mandate and cart hashes
- Agent and merchant IDs
- Vault token IDs
- Admin tokens
- Raw signed JSON
- Database usage states
- PayPal idempotency keys

These details may remain available under an advanced diagnostics panel for
development and hackathon demonstrations.
