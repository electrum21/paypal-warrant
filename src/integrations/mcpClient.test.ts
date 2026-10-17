import { afterEach, describe, expect, it, vi } from "vitest";

const listTools = vi.fn();
const callTool = vi.fn();
const connect = vi.fn();
const close = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({ connect, listTools, callTool, close })),
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn().mockImplementation((url: URL, opts: unknown) => ({ url, opts })),
}));
vi.mock("../paypal/client.js", () => ({ getAccessToken: vi.fn(async () => "sandbox-token") }));

import { callPaypalMcpTool, listPaypalMcpTools } from "./mcpClient.js";

const cfg = { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", PAYPAL_MCP_URL: "https://mcp.sandbox.paypal.com/sse" };

afterEach(() => { listTools.mockReset(); callTool.mockReset(); connect.mockReset(); close.mockReset(); });

describe("listPaypalMcpTools", () => {
  it("keeps only the allow-listed tools and always closes the connection", async () => {
    listTools.mockResolvedValue({ tools: [
      { name: "list_disputes", description: "Lists disputes", inputSchema: { type: "object" } },
      { name: "refund_dispute", description: "Not allow-listed", inputSchema: { type: "object" } },
    ] });

    const tools = await listPaypalMcpTools(cfg);

    expect(tools).toEqual([{ name: "list_disputes", description: "Lists disputes", inputSchema: { type: "object" } }]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the connection even when listTools throws", async () => {
    listTools.mockRejectedValue(new Error("unreachable"));
    await expect(listPaypalMcpTools(cfg)).rejects.toThrow("unreachable");
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("callPaypalMcpTool", () => {
  it("refuses a tool that is not allow-listed without connecting", async () => {
    await expect(callPaypalMcpTool(cfg, "refund_dispute", {})).rejects.toThrow(/not allow-listed/);
    expect(connect).not.toHaveBeenCalled();
  });

  it("joins text content from an allow-listed tool call", async () => {
    callTool.mockResolvedValue({ content: [{ type: "text", text: "line 1" }, { type: "text", text: "line 2" }] });
    const result = await callPaypalMcpTool(cfg, "get_dispute", { id: "PP-1" });
    expect(result).toBe("line 1\nline 2");
    expect(callTool).toHaveBeenCalledWith({ name: "get_dispute", arguments: { id: "PP-1" } });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
