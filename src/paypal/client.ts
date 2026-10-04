import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";

/** Sandbox is hard-pinned on purpose. There is no switch to production. */
export const PAYPAL_BASE = "https://api-m.sandbox.paypal.com";

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

export async function ppFetch<T = unknown>(
  cfg: Pick<Config, "PAYPAL_CLIENT_ID" | "PAYPAL_CLIENT_SECRET">,
  path: string,
  init: { method?: string; body?: unknown; requestId?: string } = {},
): Promise<T> {
  const token = await getAccessToken(cfg);
  const method = init.method ?? (init.body ? "POST" : "GET");
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  // Idempotency key on every write, so a retry can never double-charge.
  if (method !== "GET") headers["PayPal-Request-Id"] = init.requestId ?? randomUUID();

  const res = await fetch(`${PAYPAL_BASE}${path}`, {
    method, headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PayPal ${method} ${path} -> ${res.status}: ${text}`);
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
