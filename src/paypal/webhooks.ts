import type { Config } from "../config.js";
import { ppFetch } from "./client.js";

/**
 * Verifies a webhook with PayPal's verify-webhook-signature endpoint.
 * UNTESTED against the live sandbox: confirm during week 1.
 */
export async function verifyWebhook(
  cfg: Config,
  headers: Record<string, string | string[] | undefined>,
  event: unknown,
): Promise<boolean> {
  if (!cfg.PAYPAL_WEBHOOK_ID) return false;
  const h = (k: string) => String(headers[k] ?? "");
  const r = await ppFetch<{ verification_status: string }>(cfg, "/v1/notifications/verify-webhook-signature", {
    body: {
      auth_algo: h("paypal-auth-algo"),
      cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"),
      webhook_id: cfg.PAYPAL_WEBHOOK_ID,
      webhook_event: event,
    },
  });
  return r.verification_status === "SUCCESS";
}
