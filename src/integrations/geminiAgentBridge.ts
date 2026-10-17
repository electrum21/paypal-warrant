import { callPaypalMcpTool, listPaypalMcpTools } from "./mcpClient.js";
import type { Config } from "../config.js";

type Cfg = Pick<Config, "GEMINI_API_KEY" | "GEMINI_MODEL" | "PAYPAL_MCP_ENABLED" | "PAYPAL_CLIENT_ID" | "PAYPAL_CLIENT_SECRET" | "PAYPAL_MCP_URL">;

/** The subset of AG Studio's wire shapes (api/ai/agAiMessage.d.ts, agLlmAdapter.d.ts) this bridge speaks. */
export interface ConvInputMessage { kind: "input"; type: "message"; role: "user" | "system"; content: { type: "text"; text: string }[] }
export interface ConvOutputMessage { kind: "output"; type: "message"; role: "assistant"; content: { type: "text"; text: string }[] }
export interface ConvToolCall { kind: "output"; type: "function_call"; callId: string; name: string; arguments: string }
export interface ConvToolResult { kind?: "input"; type: "function_call_output"; callId: string; output: string }
export type ConvItem = ConvInputMessage | ConvOutputMessage | ConvToolCall | ConvToolResult;

export interface StudioToolSchema { name: string; description: string; parameters: Record<string, unknown>; kind?: "client" | "server" | "provided" }
export interface StudioLlmRequest { input: ConvItem[]; instructions?: string; tools?: StudioToolSchema[] }

export interface StudioOutputMessage { id: string; kind: "output"; type: "message"; role: "assistant"; status: "completed"; content: { type: "text"; text: string; annotations: [] }[] }
export interface StudioToolCall { id: string; kind: "output"; type: "function_call"; callId: string; name: string; arguments: string; status: "completed" }
export type StudioOutputItem = StudioOutputMessage | StudioToolCall;
export interface StudioLlmResponse {
  id: string; createdAt: number; status: "completed" | "failed"; output: StudioOutputItem[];
  error?: { code: string; message: string };
}

type GeminiFunctionCallPart = { functionCall: { name: string; args?: Record<string, unknown> }; thoughtSignature?: string };
type GeminiPart = { text?: string } | GeminiFunctionCallPart | { functionResponse: { name: string; response: Record<string, unknown> } };
type GeminiContent = { role: "user" | "model" | "function"; parts: GeminiPart[] };
interface GeminiGenerateContentResponse { candidates?: { content?: { parts?: GeminiPart[] } }[] }

/**
 * Gemini 3+ attaches a `thoughtSignature` to a functionCall part and requires it back unchanged when that
 * call is replayed in later history, even at minimal thinking - but AG Studio's own tool-call wire format
 * (StudioToolCall) has no field to carry it through the browser round trip, so by the time a CLIENT tool
 * call (one AG's harness - not us - executed) comes back as history, the original signature is gone. Google
 * documents exactly this escape hatch for a function call you're reconstructing rather than one you just
 * received live: a dummy signature skips validation. MCP tool calls never hit this - they're resolved
 * inside one executeTurn using Gemini's own raw `parts`, signature intact, never round-tripped through AG.
 */
const DUMMY_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

let idSeq = 0;
function nextId(prefix: string): string { idSeq += 1; return `${prefix}_${Date.now()}_${idSeq}`; }

function isFunctionCallPart(p: GeminiPart): p is GeminiFunctionCallPart {
  return "functionCall" in p && Boolean((p as GeminiFunctionCallPart).functionCall);
}

/** AG's conversation items -> Gemini's `contents`. A tool call's name has to be recovered for its later
 * `function_call_output`, since AG only carries the callId on the result - Gemini's functionResponse needs it. */
function toGeminiContents(input: ConvItem[]): GeminiContent[] {
  const callNames = new Map<string, string>();
  const contents: GeminiContent[] = [];
  for (const item of input) {
    if (item.type === "message" && item.kind === "input") {
      const text = item.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      if (text) contents.push({ role: "user", parts: [{ text }] });
    } else if (item.type === "message" && item.kind === "output") {
      const text = item.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      if (text) contents.push({ role: "model", parts: [{ text }] });
    } else if (item.type === "function_call") {
      callNames.set(item.callId, item.name);
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(item.arguments || "{}"); } catch { /* keep empty */ }
      contents.push({ role: "model", parts: [{ functionCall: { name: item.name, args }, thoughtSignature: DUMMY_THOUGHT_SIGNATURE }] });
    } else if (item.type === "function_call_output") {
      const name = callNames.get(item.callId) ?? "unknown_function";
      let result: unknown;
      try { result = JSON.parse(item.output); } catch { result = item.output; }
      contents.push({ role: "function", parts: [{ functionResponse: { name, response: { result } } }] });
    }
  }
  return contents;
}

/** AG/MCP JSON Schemas are already OpenAPI-style (lowercase `type`), which is what Gemini expects too - this
 * just drops keys Gemini's schema validator doesn't know, recursively. */
function sanitizeSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof s.type === "string") out.type = s.type;
  if (typeof s.description === "string") out.description = s.description;
  if (Array.isArray(s.enum)) out.enum = s.enum;
  if (Array.isArray(s.required)) out.required = s.required;
  if (s.properties && typeof s.properties === "object") {
    out.properties = Object.fromEntries(Object.entries(s.properties as Record<string, unknown>).map(([k, v]) => [k, sanitizeSchema(v)]));
  }
  if (s.items) out.items = sanitizeSchema(s.items);
  if (!out.type) out.type = "object";
  return out;
}

async function callGemini(cfg: Cfg, body: Record<string, unknown>): Promise<GeminiGenerateContentResponse> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": cfg.GEMINI_API_KEY ?? "", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json() as Promise<GeminiGenerateContentResponse>;
}

function buildResponse(parts: GeminiPart[]): StudioLlmResponse {
  const output: StudioOutputItem[] = [];
  for (const part of parts) {
    if (isFunctionCallPart(part)) {
      output.push({ id: nextId("call"), kind: "output", type: "function_call", callId: nextId("call_id"), name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}), status: "completed" });
    } else if ("text" in part && part.text) {
      output.push({ id: nextId("msg"), kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: part.text, annotations: [] }] });
    }
  }
  return { id: nextId("resp"), createdAt: Date.now(), status: "completed", output };
}

interface McpToolInfoLike { name: string; description: string; inputSchema: Record<string, unknown> }

const MAX_TOOL_ROUNDS = 6;

/**
 * Runs one Studio turn against Gemini. Gemini has no native MCP connector the way OpenAI's Responses API
 * does, so when PAYPAL_MCP_ENABLED this resolves PayPal MCP tool calls itself, in a loop invisible to the
 * Studio harness: list tools, hand them to Gemini as function declarations, and if Gemini calls one, run it
 * through the MCP client and feed the result back. A call to one of AG's OWN tools (studio widgets,
 * get_dispute_case, ...) is NOT resolved here - it is returned to the harness, which executes it and calls
 * back with the result, exactly as it would for the OpenAI adapter.
 */
export async function runGeminiStudioTurn(cfg: Cfg, request: StudioLlmRequest): Promise<StudioLlmResponse> {
  if (!cfg.GEMINI_API_KEY) return { id: nextId("resp"), createdAt: Date.now(), status: "failed", output: [], error: { code: "no_key", message: "Set GEMINI_API_KEY to use the Gemini Studio agent." } };

  const studioTools = (request.tools ?? []).filter(t => t.kind !== "provided");
  let mcpTools: McpToolInfoLike[] = [];
  if (cfg.PAYPAL_MCP_ENABLED) {
    try { mcpTools = await listPaypalMcpTools(cfg); } catch (err) { console.error("PayPal MCP tool listing failed", err); }
  }
  const mcpNames = new Set(mcpTools.map(t => t.name));
  const functionDeclarations = [
    ...studioTools.map(t => ({ name: t.name, description: t.description, parameters: sanitizeSchema(t.parameters) })),
    ...mcpTools.map(t => ({ name: t.name, description: t.description, parameters: sanitizeSchema(t.inputSchema) })),
  ];

  const contents = toGeminiContents(request.input);
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let data: GeminiGenerateContentResponse;
    try {
      data = await callGemini(cfg, {
        ...(request.instructions ? { systemInstruction: { parts: [{ text: request.instructions }] } } : {}),
        contents,
        ...(functionDeclarations.length ? { tools: [{ functionDeclarations }] } : {}),
      });
    } catch (err) {
      return { id: nextId("resp"), createdAt: Date.now(), status: "failed", output: [], error: { code: "upstream_error", message: err instanceof Error ? err.message : String(err) } };
    }
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const mcpCall = parts.find((p): p is GeminiFunctionCallPart => isFunctionCallPart(p) && mcpNames.has(p.functionCall.name));
    if (mcpCall) {
      contents.push({ role: "model", parts });
      let result: string;
      try { result = await callPaypalMcpTool(cfg, mcpCall.functionCall.name, mcpCall.functionCall.args ?? {}); }
      catch (err) { result = `Error: ${err instanceof Error ? err.message : String(err)}`; }
      contents.push({ role: "function", parts: [{ functionResponse: { name: mcpCall.functionCall.name, response: { result } } }] });
      continue;
    }
    return buildResponse(parts);
  }
  return buildResponse([{ text: "The analyst stopped after too many tool-call rounds." }]);
}
