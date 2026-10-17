import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./mcpClient.js", () => ({
  listPaypalMcpTools: vi.fn(),
  callPaypalMcpTool: vi.fn(),
}));

import { callPaypalMcpTool, listPaypalMcpTools } from "./mcpClient.js";
import { runGeminiStudioTurn, type StudioLlmRequest } from "./geminiAgentBridge.js";

const cfg = { GEMINI_API_KEY: "key", GEMINI_MODEL: "gemini-3.1-flash-lite", PAYPAL_MCP_ENABLED: false, PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", PAYPAL_MCP_URL: "https://mcp.sandbox.paypal.com/sse" };

function stubGemini(responses: unknown[]) {
  let call = 0;
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => {
    const body = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { ok: true, status: 200, json: async () => body, text: async () => "" } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const userTurn = (text: string): StudioLlmRequest => ({
  instructions: "Be concise.",
  input: [{ kind: "input", type: "message", role: "user", content: [{ type: "text", text }] }],
});

afterEach(() => { vi.unstubAllGlobals(); vi.mocked(listPaypalMcpTools).mockReset(); vi.mocked(callPaypalMcpTool).mockReset(); });

describe("runGeminiStudioTurn", () => {
  it("fails cleanly without a Gemini key", async () => {
    const r = await runGeminiStudioTurn({ ...cfg, GEMINI_API_KEY: undefined }, userTurn("hi"));
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("no_key");
  });

  it("returns a plain text answer as a completed message", async () => {
    stubGemini([{ candidates: [{ content: { parts: [{ text: "Three disputes are open." }] } }] }]);
    const r = await runGeminiStudioTurn(cfg, userTurn("How many disputes are open?"));
    expect(r.status).toBe("completed");
    expect(r.output).toEqual([expect.objectContaining({ type: "message", role: "assistant", content: [{ type: "text", text: "Three disputes are open.", annotations: [] }] })]);
  });

  it("passes through a call to one of AG's own client tools without resolving it itself", async () => {
    stubGemini([{ candidates: [{ content: { parts: [{ functionCall: { name: "get_dispute_case", args: { disputeId: 2 } } }] } }] }]);
    const r = await runGeminiStudioTurn(cfg, { ...userTurn("Tell me about dispute 2"), tools: [{ name: "get_dispute_case", description: "Reads a dispute", parameters: { type: "object", properties: { disputeId: { type: "number" } } } }] });
    expect(r.status).toBe("completed");
    expect(r.output).toEqual([expect.objectContaining({ type: "function_call", name: "get_dispute_case", arguments: JSON.stringify({ disputeId: 2 }) })]);
    expect(listPaypalMcpTools).not.toHaveBeenCalled();
  });

  it("resolves a PayPal MCP tool call itself, then returns the model's final answer", async () => {
    vi.mocked(listPaypalMcpTools).mockResolvedValue([{ name: "get_dispute", description: "Reads a sandbox dispute", inputSchema: { type: "object", properties: { id: { type: "string" } } } }]);
    vi.mocked(callPaypalMcpTool).mockResolvedValue(JSON.stringify({ status: "UNDER_REVIEW" }));
    const fn = stubGemini([
      { candidates: [{ content: { parts: [{ functionCall: { name: "get_dispute", args: { id: "PP-1" } } }] } }] },
      { candidates: [{ content: { parts: [{ text: "That sandbox dispute is under review." }] } }] },
    ]);

    const r = await runGeminiStudioTurn({ ...cfg, PAYPAL_MCP_ENABLED: true }, userTurn("What's the status of PP-1?"));

    expect(callPaypalMcpTool).toHaveBeenCalledWith(expect.objectContaining({ PAYPAL_MCP_ENABLED: true }), "get_dispute", { id: "PP-1" });
    expect(r.status).toBe("completed");
    expect(r.output).toEqual([expect.objectContaining({ type: "message", content: [{ type: "text", text: "That sandbox dispute is under review.", annotations: [] }] })]);
    expect(fn).toHaveBeenCalledTimes(2);
    // The second call's contents must carry the function call and its response back to Gemini.
    const secondBody = JSON.parse(String(fn.mock.calls[1]![1]!.body));
    expect(secondBody.contents.at(-2)).toEqual({ role: "model", parts: [{ functionCall: { name: "get_dispute", args: { id: "PP-1" } } }] });
    expect(secondBody.contents.at(-1)).toEqual({ role: "function", parts: [{ functionResponse: { name: "get_dispute", response: { result: JSON.stringify({ status: "UNDER_REVIEW" }) } } }] });
  });

  it("stops after too many tool-call rounds instead of looping forever", async () => {
    vi.mocked(listPaypalMcpTools).mockResolvedValue([{ name: "get_dispute", description: "d", inputSchema: { type: "object" } }]);
    vi.mocked(callPaypalMcpTool).mockResolvedValue("ok");
    const fn = stubGemini([{ candidates: [{ content: { parts: [{ functionCall: { name: "get_dispute", args: {} } }] } }] }]);

    const r = await runGeminiStudioTurn({ ...cfg, PAYPAL_MCP_ENABLED: true }, userTurn("loop"));

    expect(r.status).toBe("completed");
    expect(r.output).toEqual([expect.objectContaining({ type: "message", content: [{ type: "text", text: "The analyst stopped after too many tool-call rounds.", annotations: [] }] })]);
    expect(fn.mock.calls.length).toBe(6);
  });

  it("reports an upstream Gemini failure instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "server error" }) as Response));
    const r = await runGeminiStudioTurn(cfg, userTurn("hi"));
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("upstream_error");
  });

  it("carries a prior function_call/function_call_output pair from the conversation into Gemini's contents", async () => {
    const fn = stubGemini([{ candidates: [{ content: { parts: [{ text: "Done." }] } }] }]);
    const request: StudioLlmRequest = {
      input: [
        { kind: "input", type: "message", role: "user", content: [{ type: "text", text: "Look up dispute 2" }] },
        { kind: "output", type: "function_call", callId: "call-1", name: "get_dispute_case", arguments: JSON.stringify({ disputeId: 2 }) },
        { kind: "input", type: "function_call_output", callId: "call-1", output: JSON.stringify({ workflowState: "escalated" }) },
      ],
    };
    await runGeminiStudioTurn(cfg, request);
    const body = JSON.parse(String(fn.mock.calls[0]![1]!.body));
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "Look up dispute 2" }] },
      { role: "model", parts: [{ functionCall: { name: "get_dispute_case", args: { disputeId: 2 } } }] },
      { role: "function", parts: [{ functionResponse: { name: "get_dispute_case", response: { result: { workflowState: "escalated" } } } }] },
    ]);
  });
});
