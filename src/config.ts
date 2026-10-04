import "dotenv/config";
import { z } from "zod";

const Env = z.object({
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  DATABASE_PATH: z.string().default("./warrant.db"),
  PORT: z.coerce.number().default(8787),
  // Where PayPal sends the buyer back after approval. Must be reachable from the buyer's browser.
  APP_URL: z.string().default("http://localhost:8787"),
  // Treat an empty value in .env (KEY=) as unset.
  ADMIN_TOKEN: z.string().min(1).optional().or(z.literal("").transform(() => undefined)),
  ANTHROPIC_API_KEY: z.string().min(1).optional().or(z.literal("").transform(() => undefined)),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),
  GEMINI_API_KEY: z.string().min(1).optional().or(z.literal("").transform(() => undefined)),
  GEMINI_MODEL: z.string().default("gemini-3.1-flash-lite"),
  // When "true", /api/checkout refuses purchases that break the mandate (HTTP 422) instead of recording them.
  ENFORCE_MANDATE: z.string().optional().transform(v => v === "true"),
  MERCHANT_ID: z.string().default("warrant-demo-merchant"),
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
