import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { openDb } from "../db/index.js";
import { createApp } from "./app.js";

const verifyWebhook = vi.hoisted(() => vi.fn());
vi.mock("../paypal/webhooks.js", () => ({ verifyWebhook }));

const cfg = {
  PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", PAYPAL_WEBHOOK_ID: "webhook-1",
  DATABASE_PATH: ":memory:", PORT: 0, APP_URL: "http://localhost", ADMIN_TOKEN: "admin",
  ANTHROPIC_MODEL: "m", GEMINI_MODEL: "g", ENFORCE_MANDATE: false,
  MERCHANT_ID: "warrant-demo-merchant", ELASTIC_INDEX: "warrant-agent-events",
} as Config;

let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base: string;

beforeEach(async () => {
  verifyWebhook.mockReset();
  server = createApp(cfg, openDb(), {
    disputes: { get: vi.fn(async () => ({}) as any), provideEvidence: vi.fn(async () => {}), makeOffer: vi.fn(async () => {}), acceptClaim: vi.fn(async () => {}) },
  }).listen(0);
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

const send = (event: unknown) => fetch(`${base}/webhooks/paypal`, {
  method: "POST",
  headers: { "content-type": "application/json", "paypal-transmission-id": "tx-1" },
  body: JSON.stringify(event),
});

describe("PayPal webhook receiver", () => {
  it("rejects malformed JSON and events without a stable PayPal id", async () => {
    expect((await fetch(`${base}/webhooks/paypal`, { method: "POST", body: "not-json" })).status).toBe(400);
    expect((await send({ event_type: "CUSTOMER.DISPUTE.CREATED" })).status).toBe(400);
    expect(verifyWebhook).not.toHaveBeenCalled();
  });

  it("stores an unverified event but never processes it", async () => {
    verifyWebhook.mockResolvedValue(false);
    const response = await send({ id: "event-1", event_type: "CUSTOMER.DISPUTE.CREATED", resource: { dispute_id: "PP-R-1" } });
    expect(response.status).toBe(200);
    expect(verifyWebhook).toHaveBeenCalledOnce();
  });

  it("deduplicates a verified event before dispatching work", async () => {
    verifyWebhook.mockResolvedValue(true);
    const event = { id: "event-2", event_type: "CUSTOMER.DISPUTE.UPDATED", resource: { dispute_id: "PP-R-2" } };
    expect((await send(event)).status).toBe(200);
    expect((await send(event)).status).toBe(200);
    expect(verifyWebhook).toHaveBeenCalledTimes(2);
  });
});
