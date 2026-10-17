// A working AgLlmAdapter backed by Gemini, used automatically when openaiAdapter.js is still a stub.
//
// AG Studio is provider-agnostic (api/ai/agLlmAdapter.d.ts): an adapter just implements `executeTurn`,
// taking one turn's conversation/instructions/tools and returning a streamed response. Everything
// provider-specific lives here. The actual Gemini call (and, when enabled, the PayPal MCP tool-call loop -
// Gemini has no native MCP connector the way OpenAI's Responses API does) happens server-side in
// src/integrations/geminiAgentBridge.ts; this file only talks to Warrant's own /studio-api/llm endpoint and
// translates its response into AG's event protocol.
export function geminiAdapter({ endpoint, key }) {
  return {
    async executeTurn(request, options) {
      let res;
      let data;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify(request),
          signal: options?.signal,
        });
        data = await res.json();
      } catch (err) {
        const message = err?.message ?? "The Studio agent request failed.";
        return { stream: toEventStream([], message), complete: Promise.resolve(failure(message)) };
      }
      if (!res.ok || data.error) {
        const message = data?.error?.message ?? `Studio agent request failed (${res.status}).`;
        return { stream: toEventStream([], message), complete: Promise.resolve(data?.error ? data : failure(message)) };
      }
      return { stream: toEventStream(data.output ?? []), complete: Promise.resolve(data) };
    },
  };
}

function failure(message) {
  return { id: "error", createdAt: Date.now(), status: "failed", output: [], error: { code: "request_failed", message } };
}

function toEventStream(output, errorMessage) {
  return { [Symbol.asyncIterator]: () => eventsFor(output, errorMessage) };
}

async function* eventsFor(output, errorMessage) {
  if (errorMessage) {
    yield { type: "RUN_ERROR", message: errorMessage };
    return;
  }
  for (const item of output) {
    if (item.type === "message") {
      const text = (item.content ?? []).filter(c => c.type === "text").map(c => c.text).join("");
      yield { type: "TEXT_MESSAGE_CHUNK", messageId: item.id, role: "assistant", delta: text };
    } else if (item.type === "function_call") {
      yield { type: "TOOL_CALL_CHUNK", toolCallId: item.callId, toolCallName: item.name, delta: item.arguments };
    }
  }
}
