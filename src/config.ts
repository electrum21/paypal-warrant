import "dotenv/config";
import { z } from "zod";

/** A blank value in .env (KEY=) means "not set". */
const blank = (v: unknown) => (v === "" ? undefined : v);

const Env = z.object({
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  DATABASE_PATH: z.string().default("./warrant.db"),
  PORT: z.coerce.number().default(8787),
  // Where PayPal sends the buyer back after approval. Must be reachable from the buyer's browser.
  APP_URL: z.string().default("http://localhost:8787"),
  PAYPAL_LOGIN_CLIENT_ID: z.preprocess(blank, z.string().min(1).optional()),
  PAYPAL_LOGIN_CLIENT_SECRET: z.preprocess(blank, z.string().min(1).optional()),
  PAYPAL_LOGIN_SCOPES: z.string().default("openid profile email"),
  AUTH_SESSION_HOURS: z.coerce.number().positive().default(24),
  // Treat an empty value in .env (KEY=) as unset.
  ADMIN_TOKEN: z.string().min(1).optional().or(z.literal("").transform(() => undefined)),
  // A second, disposable token with the same access as ADMIN_TOKEN, for handing out to hackathon judges
  // without exposing the real one. Unset it (or rotate it) once judging ends.
  JUDGE_TOKEN: z.string().min(1).optional().or(z.literal("").transform(() => undefined)),
  ANTHROPIC_API_KEY: z.string().min(1).optional().or(z.literal("").transform(() => undefined)),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),
  GEMINI_API_KEY: z.string().min(1).optional().or(z.literal("").transform(() => undefined)),
  GEMINI_MODEL: z.string().default("gemini-3.1-flash-lite"),
  // When "true", /api/checkout refuses purchases that break the mandate (HTTP 422) instead of recording them.
  ENFORCE_MANDATE: z.string().optional().transform(v => v === "true"),
  MERCHANT_ID: z.string().default("warrant-demo-merchant"),
  // How long a held autonomous purchase (over the mandate's requireApprovalAboveCents) waits for the user
  // to approve or decline before it expires and releases its held budget.
  CHECKOUT_HOLD_MINUTES: z.coerce.number().positive().default(30),
  CHANNEL3_URL: z.preprocess(blank, z.string().url().optional()),
  CHANNEL3_API_KEY: z.preprocess(blank, z.string().min(1).optional()),
  ELASTIC_URL: z.preprocess(blank, z.string().url().optional()),
  ELASTIC_API_KEY: z.preprocess(blank, z.string().min(1).optional()),
  ELASTIC_INDEX: z.string().default("warrant-agent-events"),
  /** Dispute cases for precedent retrieval (semantic + keyword). */
  ELASTIC_CASE_INDEX: z.string().default("warrant-dispute-cases"),
  /** Shared secret a Zapier Zap sends (x-warrant-evidence-secret) when it posts evidence back. Without it only the admin token works. */
  EVIDENCE_WEBHOOK_SECRET: z.preprocess(blank, z.string().min(16).optional()),
  /** AG Studio's agent calls an OpenAI Responses-compatible endpoint THROUGH Warrant, so the key never reaches the browser. */
  STUDIO_LLM_URL: z.string().url().default("https://api.openai.com/v1/responses"),
  STUDIO_LLM_API_KEY: z.preprocess(blank, z.string().min(1).optional()),
  STUDIO_LLM_MODEL: z.preprocess(blank, z.string().min(1).optional()),
  /** "openai" proxies straight to STUDIO_LLM_URL/API_KEY. "gemini" runs a bridge in-process against
   * GEMINI_API_KEY/GEMINI_MODEL instead - no OpenAI account needed - and, when PAYPAL_MCP_ENABLED, resolves
   * PayPal MCP tool calls itself, since Gemini has no native MCP connector the way OpenAI's Responses API does. */
  STUDIO_LLM_PROVIDER: z.enum(["openai", "gemini"]).default("openai"),
  /** Opt-in PayPal MCP context for the Studio analyst. Only sandbox read tools are allow-listed. */
  PAYPAL_MCP_ENABLED: z.string().optional().transform(v => v === "true"),
  PAYPAL_MCP_URL: z.string().url().default("https://mcp.sandbox.paypal.com/sse"),
  ZAPIER_WEBHOOK_URL: z.preprocess(blank, z.string().url().optional()),
});
export type Config = z.infer<typeof Env>;

/** Loaded lazily so unit tests never need PayPal credentials. */
export function loadConfig(): Config {
  const r = Env.safeParse(process.env);
  if (!r.success) {
    const missing = r.error.issues.map(i => i.path.join(".")).join(", ");
    throw new Error(`Missing or invalid environment variables: ${missing}. Copy .env.example to .env.`);
  }
  return r.data;
}
