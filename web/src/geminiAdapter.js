// A working AgLlmAdapter backed by Gemini, used automatically when openaiAdapter.js is still a stub.
//
// AG Studio is provider-agnostic (api/ai/agLlmAdapter.d.ts): an adapter just implements `executeTurn`,
// taking one turn's conversation/instructions/tools and returning a streamed response. Everything
// provider-specific lives here. The actual Gemini call (and, when enabled, the PayPal MCP tool-call loop -
// Gemini has no native MCP connector the way OpenAI's Responses API does) happens server-side in
// src/integrations/geminiAgentBridge.ts; this file only talks to Warrant's own /studio-api/llm endpoint and
// translates its response into AG's event protocol.
//
// IMPORTANT: `executeTurn` itself must return `{ stream, complete }` SYNCHRONOUSLY - only `complete` (a
// Promise) and the items `stream` yields are async. An `async executeTurn` returns a Promise instead of
// that object, so the harness's `handler.stream` is undefined and `for await` on it throws.
export function geminiAdapter({ endpoint, key }) {
  return {
    executeTurn(request, options) {
      const resultPromise = runTurn(endpoint, key, request, options);
      return {
        stream: toEventStream(resultPromise),
        complete: resultPromise.then(r => r.response),
      };
    },
  };
}

async function runTurn(endpoint, key, request, options) {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(request),
      signal: options?.signal,
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      const message = data?.error?.message ?? `Studio agent request failed (${res.status}).`;
      return { response: data?.error ? data : failure(message), errorMessage: message };
    }
    return { response: data, errorMessage: undefined };
  } catch (err) {
    const message = err?.message ?? "The Studio agent request failed.";
    return { response: failure(message), errorMessage: message };
  }
}

function failure(message) {
  return { id: "error", createdAt: Date.now(), status: "failed", output: [], error: { code: "request_failed", message } };
}

function toEventStream(resultPromise) {
  return { [Symbol.asyncIterator]: () => eventsFor(resultPromise) };
}

async function* eventsFor(resultPromise) {
  const { response, errorMessage } = await resultPromise;
  if (errorMessage) {
    yield { type: "RUN_ERROR", message: errorMessage };
    return;
  }
  for (const item of response.output ?? []) {
    if (item.type === "message") {
      const text = (item.content ?? []).filter(c => c.type === "text").map(c => c.text).join("");
      yield { type: "TEXT_MESSAGE_CHUNK", messageId: item.id, role: "assistant", delta: text };
    } else if (item.type === "function_call") {
      yield { type: "TOOL_CALL_CHUNK", toolCallId: item.callId, toolCallName: item.name, delta: item.arguments };
    }
  }
}
