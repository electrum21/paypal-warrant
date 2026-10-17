import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../db/index.js";
import { createApp } from "./app.js";
import type { Config } from "../config.js";

function baseCfg(overrides: Partial<Config> = {}): Config {
  return {
    PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", DATABASE_PATH: ":memory:",
    PORT: 0, APP_URL: "http://localhost", ADMIN_TOKEN: "admin-token",
    ANTHROPIC_MODEL: "m", GEMINI_MODEL: "gemini-3.1-flash-lite", ENFORCE_MANDATE: false,
    MERCHANT_ID: "warrant-demo-merchant", ELASTIC_INDEX: "warrant-agent-events",
    ELASTIC_CASE_INDEX: "warrant-dispute-cases", PAYPAL_LOGIN_SCOPES: "openid",
    AUTH_SESSION_HOURS: 24, STUDIO_LLM_URL: "https://api.openai.com/v1/responses",
    STUDIO_LLM_PROVIDER: "openai", PAYPAL_MCP_ENABLED: false, PAYPAL_MCP_URL: "https://mcp.sandbox.paypal.com/sse",
    ...overrides,
  } as Config;
}

async function withServer(cfg: Config, run: (port: number) => Promise<void>) {
  const app = createApp(cfg, openDb());
  const server = app.listen(0);
  try {
    await run((server.address() as { port: number }).port);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("GET /health studio agent fields", () => {
  it("reports the openai provider and keys off STUDIO_LLM_API_KEY by default", async () => {
    await withServer(baseCfg({ STUDIO_LLM_API_KEY: "sk-1" }), async port => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await res.json();
      expect(body.integrations.studioLlmProvider).toBe("openai");
      expect(body.integrations.studioAgent).toBe(true);
    });
  });

  it("reports the gemini provider and keys off GEMINI_API_KEY when selected", async () => {
    await withServer(baseCfg({ STUDIO_LLM_PROVIDER: "gemini", GEMINI_API_KEY: "g-1", STUDIO_LLM_API_KEY: undefined }), async port => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await res.json();
      expect(body.integrations.studioLlmProvider).toBe("gemini");
      expect(body.integrations.studioAgent).toBe(true);
    });
  });
});

describe("POST /studio-api/llm with STUDIO_LLM_PROVIDER=gemini", () => {
  it("refuses without the admin token", async () => {
    await withServer(baseCfg({ STUDIO_LLM_PROVIDER: "gemini", GEMINI_API_KEY: "g-1" }), async port => {
      const res = await fetch(`http://127.0.0.1:${port}/studio-api/llm`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(401);
    });
  });

  it("returns 503 when GEMINI_API_KEY is unset", async () => {
    await withServer(baseCfg({ STUDIO_LLM_PROVIDER: "gemini" }), async port => {
      const res = await fetch(`http://127.0.0.1:${port}/studio-api/llm`, {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer admin-token" }, body: "{}",
      });
      expect(res.status).toBe(503);
    });
  });

  it("runs the Gemini bridge and returns its response for a configured key", async () => {
    const realFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("generativelanguage.googleapis.com")) {
        return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "Hello from the analyst." }] } }] }) } as Response;
      }
      return realFetch(url, init);
    }));
    await withServer(baseCfg({ STUDIO_LLM_PROVIDER: "gemini", GEMINI_API_KEY: "g-1" }), async port => {
      const req = { input: [{ kind: "input", type: "message", role: "user", content: [{ type: "text", text: "hi" }] }] };
      const res = await fetch(`http://127.0.0.1:${port}/studio-api/llm`, {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer admin-token" }, body: JSON.stringify(req),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("completed");
      expect(body.output).toEqual([expect.objectContaining({ type: "message", content: [{ type: "text", text: "Hello from the analyst.", annotations: [] }] })]);
    });
  });
});
