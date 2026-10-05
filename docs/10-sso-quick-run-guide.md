# PayPal Sandbox SSO quick run guide

This guide tests the Warrant PayPal Sandbox sign-in flow through an HTTPS
ngrok URL. It covers identity sign-in and the separate payment-method
connection step.

## 1. Prerequisites

- Node.js 24 (Node 22.13+ also works with the built-in SQLite support)
- A PayPal Developer account
- A PayPal Sandbox **Business** account and app
- A PayPal Sandbox **Personal** buyer account
- ngrok 3.20 or newer

Verify the local tools:

```powershell
node --version
ngrok version
```

## 2. Configure the PayPal Sandbox app

In the PayPal Developer Dashboard:

1. Open **Apps & Credentials** and select **Sandbox**.
2. Open the app used by Warrant.
3. Enable **Log in with PayPal**.
4. Request only the identity fields needed by this demo:
   - Full Name
   - Email
   - PayPal account ID (payer ID)
5. Enable **Save payment methods**: open **App Feature Options**, check
   **Accept payments**, expand **Advanced options** and select **Vault**.
   Without this toggle PayPal can create the setup token but never open a
   payer session, so `/api/me/payment/start` answers
   `502 ... PayPal did not return a payment approval link` (providerStatus
   `CREATED`, links: `self` only). The same symptom appeared when the setup-token
   request used the Orders API's `attributes.vault` block instead of
   `usage_type` directly under `payment_source.paypal`. That request shape is
   now fixed and the corrected connection flow has been verified against the
   sandbox. If you still get `CREATED` after a retry, check this toggle and
   the Business account step below.
6. In the sandbox **Business** account: **Account Settings** >
   **Payment Preferences** > **Save PayPal and Venmo payment methods** >
   **Get Started**, until the status reads **Success**.
7. Provide public HTTPS Privacy Policy and User Agreement URLs if PayPal
   requires them.

The callback URL cannot be filled in until ngrok has supplied the current
public hostname. Add it in the app's return/callback URL field once you have
it (section 5 starts ngrok).

## 3. Configure `.env`

Copy `.env.example` to `.env` if needed, then set the PayPal REST credentials:

```env
PAYPAL_CLIENT_ID=your_sandbox_business_app_client_id
PAYPAL_CLIENT_SECRET=your_sandbox_business_app_client_secret

PAYPAL_LOGIN_CLIENT_ID=your_sandbox_login_app_client_id
PAYPAL_LOGIN_CLIENT_SECRET=your_sandbox_login_app_client_secret
PAYPAL_LOGIN_SCOPES=openid profile email

APP_URL=https://replace-after-starting-ngrok
PORT=8787
AUTH_SESSION_HOURS=24
```

If the same PayPal app handles REST APIs and Login with PayPal, the login
credentials can be the same values as the REST credentials.

Keep `.env` local. Never commit or paste client secrets, API keys, admin tokens,
vault tokens, or webhook URLs.

## 4. Start the Warrant server

Open PowerShell window 1:

```powershell
cd "C:\Users\tjmja\Documents\Projects\paypal-ai-hackathon\warrant"
npm install
npm run typecheck
npm run dev
```

Leave this terminal running. The server listens on port `8787` by default.

## 5. Start ngrok and update the callback

Open PowerShell window 2:

```powershell
ngrok http 8787
```

Copy the HTTPS forwarding URL, for example:

```text
https://example-name.ngrok-free.dev
```

Update `.env`:

```env
APP_URL=https://example-name.ngrok-free.dev
```

In the PayPal app's **Log In with PayPal** settings, add this exact Return URL:

```text
https://example-name.ngrok-free.dev/auth/paypal/callback
```

The URL must match `APP_URL` plus `/auth/paypal/callback` exactly:

- Use `https`
- Use the current ngrok hostname
- Keep the `/auth/paypal/callback` path
- Do not add a trailing slash

Save the Login with PayPal settings and the overall app settings. Then restart
the Warrant server so it loads the changed `APP_URL`:

```text
Ctrl+C
npm run dev
```

Keep ngrok running in the other terminal.

## 6. Test PayPal sign-in

Open the public URL, not the localhost URL:

```text
https://example-name.ngrok-free.dev/user
```

Click **Continue with PayPal** and sign in with the Sandbox Personal buyer
account.

Expected result:

1. PayPal redirects to Warrant.
2. Warrant creates an HttpOnly session cookie.
3. The page shows that the user is signed in.
4. The browser signing key is created and connected automatically.

The user identity should look friendly in the page. Internal PayPal subject
identifiers are kept for server-side account association.

## 7. Test payment-method connection

Click **Connect PayPal payment method** and approve the PayPal Sandbox flow.

Expected result:

```text
PayPal payment method connected.
```

The vault/payment-method token is stored server-side and must not be displayed
to the user.

If PayPal returns:

```text
403 NOT_AUTHORIZED
Authorization failed due to insufficient permissions
```

identity sign-in is still working, but the REST app or Sandbox business account
does not have permission for `POST /v3/vault/setup-tokens`. Check **Save
payment methods**, Vault/Payment Method Tokens, and Reference Transactions/Future
Payments availability. Some Sandbox accounts require PayPal to enable these
capabilities.

This flow has been verified successfully in the Sandbox. If instead the page shows:

```text
502 PayPal did not return a payment approval link. providerStatus: CREATED
```

the token was created but PayPal opened no payer session (`links` contains only
`self`, and the expected status is `PAYER_ACTION_REQUIRED`), the Vault toggle
from section 2 step 5 (or the business account's **Save PayPal and Venmo
payment methods** setting) is not in effect yet — see section 9.

## 8. Test a bounded autonomous purchase

The Vault connection and complete browser-driven autonomous checkout have been
verified against the Sandbox. The server route and underlying Vault charge are
also covered by tests and smoke runs.

Use the default values first:

```text
Description: Buy one pair of trail running shoes
Maximum per purchase: 120
Number of purchases: 1
Permission lasts: 24 hours
```

Then click:

1. **Review permission**
2. **Authorize and start shopping**

Review the Activity and Purchases sections. The Activity log identifies whether
product discovery used Channel3 or the local catalog fallback.

## 9. Troubleshooting

### PayPal says `invalid client_id or redirect_uri`

Check that:

- `PAYPAL_LOGIN_CLIENT_ID` belongs to the PayPal app being configured.
- The Return URL exactly matches `APP_URL/auth/paypal/callback`.
- `.env` was changed before restarting `npm run dev`.
- You opened the ngrok URL rather than `localhost`.

### The callback URL stopped working

Free ngrok hostnames can change. Update both `.env` and PayPal's Return URL,
then restart Warrant.

### Sign-in works but payment connection returns 403

This is a PayPal capability/permission issue, not a Warrant SSO issue. Confirm
that the REST credentials in `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are
from the Sandbox Business app and that Vault/payment-method permissions are
enabled.

### Payment connection returns 502 "PayPal did not return a payment approval link"

PayPal accepted the setup token (`status: CREATED`) but never issued a payer
session, so there is no approval URL to hand the browser. The response body
carries `setupTokenId`, `providerLinks` and a `fix` list. In order:

1. Developer Dashboard > **Apps & Credentials** > the app > **Sandbox App
   Settings** > **App Feature Options**: check **Accept payments**, expand
   **Advanced options** and select **Vault**, then save.
2. Sandbox **Business** account > **Account Settings** > **Payment
   Preferences** > **Save PayPal and Venmo payment methods** > **Get Started**
   until the status is **Success**.
3. Retry; the response status should now be `PAYER_ACTION_REQUIRED` with a
   `payer-action` link.

Hand-building `https://www.sandbox.paypal.com/checkoutnow?token=<setupTokenId>`
is not a workaround: without the payer session PayPal shows "Things don't appear
to be working at the moment", and the exchange would fail with
`MISSING_BILLING_APPROVAL_TOKEN`.

### The browser shows stale page content

`userPage.html` is loaded when the server starts. Restart `npm run dev` after
HTML or environment changes.

## 10. Stop the demo

In both terminals, press:

```text
Ctrl+C
```

If credentials were shared outside the local `.env`, rotate them in the
relevant provider dashboards before continuing.
