import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getAccessToken } from "../paypal/client.js";
import type { Config } from "../config.js";

/** Sandbox read tools the Studio analyst may call. Kept in one place; both LLM providers reuse it. */
export const PAYPAL_MCP_ALLOWED_TOOLS = ["list_disputes", "get_dispute", "list_product", "show_product_details"] as const;

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type Cfg = Pick<Config, "PAYPAL_CLIENT_ID" | "PAYPAL_CLIENT_SECRET" | "PAYPAL_MCP_URL">;

async function connect(cfg: Cfg): Promise<Client> {
  const accessToken = await getAccessToken(cfg);
  const authHeader = `Bearer ${accessToken}`;
  const transport = new SSEClientTransport(new URL(cfg.PAYPAL_MCP_URL), {
    requestInit: { headers: { Authorization: authHeader } },
    eventSourceInit: {
      fetch: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), Authorization: authHeader } }),
    },
  });
  const client = new Client({ name: "warrant-studio-analyst", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** The allow-listed PayPal sandbox MCP tools. Returns [] if the server can't be reached - callers treat that as "no MCP context", not a hard failure. */
export async function listPaypalMcpTools(cfg: Cfg): Promise<McpToolInfo[]> {
  const client = await connect(cfg);
  try {
    const { tools } = await client.listTools();
    const allowed = new Set<string>(PAYPAL_MCP_ALLOWED_TOOLS);
    return tools.filter(t => allowed.has(t.name)).map(t => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema }));
  } finally {
    await client.close();
  }
}

/** Calls one allow-listed PayPal sandbox MCP tool and returns its text content. Read-only tools only. */
export async function callPaypalMcpTool(cfg: Cfg, name: string, args: Record<string, unknown>): Promise<string> {
  if (!(PAYPAL_MCP_ALLOWED_TOOLS as readonly string[]).includes(name)) throw new Error(`Tool "${name}" is not allow-listed.`);
  const client = await connect(cfg);
  try {
    const result = await client.callTool({ name, arguments: args });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content.filter((c): c is { type: "text"; text: string } => c.type === "text").map(c => c.text).join("\n");
    return text || JSON.stringify(result);
  } finally {
    await client.close();
  }
}
