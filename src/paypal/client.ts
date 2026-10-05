import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";

/** Sandbox is hard-pinned on purpose. There is no switch to production. */
export const PAYPAL_BASE = "https://api-m.sandbox.paypal.com";
export const PAYPAL_LOGIN_BASE = "https://www.sandbox.paypal.com";

let cached: { token: string; expiresAt: number } | null = null;

export async function getAccessToken(cfg: Pick<Config, "PAYPAL_CLIENT_ID" | "PAYPAL_CLIENT_SECRET">): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const basic = Buffer.from(`${cfg.PAYPAL_CLIENT_ID}:${cfg.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cached.token;
}

export async function exchangePayPalLoginCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<{ access_token: string; expires_in: number }> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  if (!res.ok) throw new PayPalHttpError(`PayPal login token exchange failed: ${res.status} ${await res.text()}`, res.status);
  return await res.json() as { access_token: string; expires_in: number };
}

export async function getPayPalProfile(accessToken: string): Promise<{ user_id?: string; sub?: string; email?: string; name?: string }> {
  const res = await fetch(`${PAYPAL_BASE}/v1/identity/openidconnect/userinfo/?schema=openid`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new PayPalHttpError(`PayPal profile lookup failed: ${res.status} ${await res.text()}`, res.status);
  return await res.json() as { user_id?: string; sub?: string; email?: string; name?: string };
}

/** A PayPal HTTP error response. A 4xx means PayPal refused the request; a 5xx means we cannot tell what happened. */
export class PayPalHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "PayPalHttpError"; }
}

export async function ppFetch<T = unknown>(
  cfg: Pick<Config, "PAYPAL_CLIENT_ID" | "PAYPAL_CLIENT_SECRET">,
  path: string,
  init: { method?: string; body?: unknown; requestId?: string; prefer?: string } = {},
): Promise<T> {
  const token = await getAccessToken(cfg);
  const method = init.method ?? (init.body ? "POST" : "GET");
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.prefer) headers.Prefer = init.prefer;
  // Idempotency key on every write, so a retry can never double-charge.
  if (method !== "GET") headers["PayPal-Request-Id"] = init.requestId ?? randomUUID();

  const res = await fetch(`${PAYPAL_BASE}${path}`, {
    method, headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new PayPalHttpError(`PayPal ${method} ${path} -> ${res.status}: ${text}`, res.status);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Minor units to PayPal's decimal string. Assumes a 2-decimal currency (USD, SGD, EUR...). */
export function toDecimal(cents: number): string {
  return (cents / 100).toFixed(2);
}

export interface CreatedOrder {
  id: string;
  status: string;
  links: { href: string; rel: string; method: string }[];
}

export function createOrder(
  cfg: Pick<Config, "PAYPAL_CLIENT_ID" | "PAYPAL_CLIENT_SECRET">,
  p: {
    amountCents: number; currency: string; mandateId: string; description?: string;
    returnUrl: string; cancelUrl: string;
  },
) {
  return ppFetch<CreatedOrder>(cfg, "/v2/checkout/orders", {
    body: {
      intent: "CAPTURE",
      purchase_units: [{
        amount: { currency_code: p.currency, value: toDecimal(p.amountCents) },
        description: p.description,
        custom_id: p.mandateId,                   // ties the PayPal order to the mandate
      }],
      // Without return_url the buyer's "Continue" button has nowhere to go.
      payment_source: {
        paypal: {
          experience_context: {
            return_url: p.returnUrl,
            cancel_url: p.cancelUrl,
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
          },
        },
      },
    },
  });
}

export interface CapturedOrder {
  id: string;
  status: string;
  purchase_units?: { payments?: { captures?: { id: string; status: string; amount: { value: string; currency_code: string } }[] } }[];
}

/** Call after the buyer approves. The capture ID is the transaction a dispute would be raised against. */
export function captureOrder(
  cfg: Pick<Config, "PAYPAL_CLIENT_ID" | "PAYPAL_CLIENT_SECRET">,
  orderId: string,
) {
  return ppFetch<CapturedOrder>(cfg, `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: "POST", body: {}, requestId: `capture-${orderId}`,
  });
}

// ---------------------------------------------------------------------------------------------
// Vaulted ("pay without the click") payments. SPIKE: request shapes follow PayPal's docs but have
// NOT been run against the sandbox. Run `npm run smoke:vault` to find out whether your sandbox
// business account is enabled for vaulting. See docs/04-autonomous-purchase-spike.md.
// ---------------------------------------------------------------------------------------------

/** Like createOrder, but asks PayPal to save the buyer's PayPal account once they approve. */
export function createVaultingOrder(
  cfg: Pick<Config, "PAYPAL_CLIENT_ID" | "PAYPAL_CLIENT_SECRET">,
  p: { amountCents: number; currency: string; mandateId: string; description?: string; returnUrl: string; cancelUrl: string },
) {
  return ppFetch<CreatedOrder>(cfg, "/v2/checkout/orders", {
    body: {
      intent: "CAPTURE",
      purchase_units: [{
        amount: { currency_code: p.currency, value: toDecimal(p.amountCents) },
        description: p.description,
        custom_id: p.mandateId,
      }],
      payment_source: {
        paypal: {
          attributes: {
            vault: {
              store_in_vault: "ON_SUCCESS",
              usage_type: "MERCHANT",
              customer_type: "CONSUMER",
            },
          },
          experience_context: {
            return_url: p.returnUrl, cancel_url: p.cancelUrl, user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING",
          },
        },
      },
    },
  });
}

export interface VaultInfo { id?: string; status?: string; customer?: { id?: string } }

/** Pulls the vault block out of a capture (or order) response, wherever PayPal put it. */
export function vaultFromOrder(o: unknown): VaultInfo | undefined {
  const ps = (o as { payment_source?: Record<string, { attributes?: { vault?: VaultInfo } }> } | undefined)?.payment_source;
  return ps?.paypal?.attributes?.vault ?? Object.values(ps ?? {}).find(v => v?.attributes?.vault)?.attributes?.vault;
}

export function getOrder(cfg: Pick<Config, "PAYPAL_CLIENT_ID" | "PAYPAL_CLIENT_SECRET">, orderId: string) {
  return ppFetch<CapturedOrder & { payment_source?: unknown }>(cfg, `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
}

export interface SetupToken {
  id: string;
  status?: string;
  links?: { href: string; rel: string; method?: string }[];
  payment_source?: unknown;
}

/**
 * Starts "save PayPal without a purchase" (Payment Method Tokens API). PayPal's documented request puts
 * `usage_type` directly under `payment_source.paypal` (MERCHANT: the merchant charges later on the user's
 * behalf) next to `experience_context`. The `attributes.vault` block belongs to the Orders API (see
 * `createVaultingOrder`), not to this endpoint. A successful reply has status PAYER_ACTION_REQUIRED and an
 * approve link for the buyer.
 */
export function createPayPalSetupToken(
  cfg: Pick<Config, "PAYPAL_CLIENT_ID" | "PAYPAL_CLIENT_SECRET">,
  p: { returnUrl: string; cancelUrl: string },
) {
  return ppFetch<SetupToken>(cfg, "/v3/vault/setup-tokens", {
    prefer: "return=representation",
    body: {
      payment_source: {
        paypal: {
          usage_type: "MERCHANT",
          experience_context: {
            return_url: p.returnUrl,
            cancel_url: p.cancelUrl,
          },
        },
      },
    },
  });
}

export function exchangePayPalSetupToken(
  cfg: Pick<Config, "PAYPAL_CLIENT_ID" | "PAYPAL_CLIENT_SECRET">,
  setupTokenId: string,
) {
  return ppFetch<{ id: string; customer?: { id?: string } }>(cfg, "/v3/vault/payment-tokens", {
    body: { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } },
  });
}

/**
 * Charges a saved payment token with no buyer approval step. The request id is derived from `chargeKey`
 * (use the signed cart id), so a retry cannot charge twice. Captures separately if PayPal did not
 * complete the order on creation.
 */
export async function chargeVaultedToken(
  cfg: Pick<Config, "PAYPAL_CLIENT_ID" | "PAYPAL_CLIENT_SECRET">,
  p: { tokenId: string; amountCents: number; currency: string; mandateId: string; chargeKey: string; description?: string },
): Promise<CapturedOrder & { createdStatus: string }> {
  const created = await ppFetch<CreatedOrder & CapturedOrder>(cfg, "/v2/checkout/orders", {
    requestId: `charge-${p.chargeKey}`,
    body: {
      intent: "CAPTURE",
      payment_source: { token: { id: p.tokenId, type: "PAYMENT_METHOD_TOKEN" } },
      purchase_units: [{
        amount: { currency_code: p.currency, value: toDecimal(p.amountCents) },
        description: p.description,
        custom_id: p.mandateId,
      }],
    },
  });
  if (created.status === "COMPLETED") return { ...created, createdStatus: created.status };
  const captured = await ppFetch<CapturedOrder>(cfg, `/v2/checkout/orders/${encodeURIComponent(created.id)}/capture`, {
    method: "POST", body: {}, requestId: `charge-capture-${p.chargeKey}`,
  });
  return { ...captured, createdStatus: created.status };
}