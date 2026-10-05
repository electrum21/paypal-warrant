import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chargeVaultedToken, createPayPalSetupToken, createVaultingOrder, vaultFromOrder } from "./client.js";

const cfg = { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" };
let calls: { url: string; method: string; headers: Record<string, string>; body: any }[];
let replies: (o: { url: string }) => unknown;

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    if (String(url).includes("/oauth2/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
    calls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(replies({ url: String(url) })));
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("vaulted payments (request shapes; the connection and a no-click charge were verified on the sandbox 5 Oct 2026)", () => {
  it("asks PayPal to save the account when creating the first order", async () => {
    replies = () => ({ id: "O1", status: "PAYER_ACTION_REQUIRED", links: [] });
    await createVaultingOrder(cfg, { amountCents: 1000, currency: "USD", mandateId: "m1", returnUrl: "r", cancelUrl: "c" });
    expect(calls[0].body.payment_source.paypal.attributes.vault).toEqual({ store_in_vault: "ON_SUCCESS", usage_type: "MERCHANT", customer_type: "CONSUMER" });
    expect(calls[0].body.intent).toBe("CAPTURE");
  });

  it("charges a token with no approval redirect, and sends a stable request id", async () => {
    replies = () => ({ id: "O2", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "C2" }] } }] });
    const r = await chargeVaultedToken(cfg, { tokenId: "TOK", amountCents: 2599, currency: "USD", mandateId: "m1", chargeKey: "cart-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.payment_source).toEqual({ token: { id: "TOK", type: "PAYMENT_METHOD_TOKEN" } });
    expect(calls[0].body.purchase_units[0].amount).toEqual({ currency_code: "USD", value: "25.99" });
    expect(calls[0].headers["PayPal-Request-Id"]).toBe("charge-cart-1");
    expect(r.createdStatus).toBe("COMPLETED");
  });

  it("asks for a merchant-usage PayPal setup token in the Payment Method Tokens API shape", async () => {
    replies = () => ({ id: "S1", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "approve", href: "https://paypal.test/approve" }] });
    await createPayPalSetupToken(cfg, { returnUrl: "https://app.test/return", cancelUrl: "https://app.test/cancel" });
    expect(calls[0].url).toContain("/v3/vault/setup-tokens");
    expect(calls[0].body.payment_source.paypal).toEqual({
      usage_type: "MERCHANT",
      experience_context: { return_url: "https://app.test/return", cancel_url: "https://app.test/cancel" },
    });
    // The Orders API's `attributes.vault` block is not part of this endpoint.
    expect(calls[0].body.payment_source.paypal.attributes).toBeUndefined();
    expect(calls[0].headers.Prefer).toBe("return=representation");
  });

  it("captures separately when the order is not completed on creation", async () => {
    replies = ({ url }) => url.endsWith("/capture") ? { id: "O3", status: "COMPLETED" } : { id: "O3", status: "APPROVED" };
    const r = await chargeVaultedToken(cfg, { tokenId: "TOK", amountCents: 500, currency: "USD", mandateId: "m1", chargeKey: "cart-2" });
    expect(calls.map(c => c.url.split("/orders")[1])).toEqual(["", "/O3/capture"]);
    expect(calls[1].headers["PayPal-Request-Id"]).toBe("charge-capture-cart-2");
    expect(r).toMatchObject({ status: "COMPLETED", createdStatus: "APPROVED" });
  });

  it("surfaces PayPal's refusal, such as an account not enabled for vaulting", async () => {
    vi.stubGlobal("fetch", async (url: string) => String(url).includes("/oauth2/token")
      ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }))
      : new Response(JSON.stringify({ details: [{ issue: "NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE" }] }), { status: 422 }));
    await expect(createVaultingOrder(cfg, { amountCents: 1000, currency: "USD", mandateId: "m1", returnUrl: "r", cancelUrl: "c" }))
      .rejects.toThrow("NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE");
  });

  it("finds the vault block in a capture response", () => {
    expect(vaultFromOrder({ payment_source: { paypal: { attributes: { vault: { id: "TOK", status: "VAULTED" } } } } })).toEqual({ id: "TOK", status: "VAULTED" });
    expect(vaultFromOrder({ payment_source: { paypal: {} } })).toBeUndefined();
    expect(vaultFromOrder(undefined)).toBeUndefined();
  });
});
