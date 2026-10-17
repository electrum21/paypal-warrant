// Live smoke test for the Gemini-backed Studio agent bridge (src/integrations/geminiAgentBridge.ts).
// Hits the real Gemini API and, if PayPal sandbox credentials are present, the real PayPal MCP server too.
import { loadConfig } from "../config.js";
import { runGeminiStudioTurn, type StudioLlmRequest } from "../integrations/geminiAgentBridge.js";

const cfg = loadConfig();
if (!cfg.GEMINI_API_KEY) { console.log("No GEMINI_API_KEY set; nothing to smoke-test against."); process.exit(0); }

let failures = 0;

async function run(label: string, request: StudioLlmRequest, check: (r: Awaited<ReturnType<typeof runGeminiStudioTurn>>) => string | undefined) {
  console.log(`\n${label}`);
  const r = await runGeminiStudioTurn(cfg, request);
  console.log("  ", JSON.stringify(r).slice(0, 300));
  const problem = check(r);
  if (problem) { console.log(`  FAIL: ${problem}`); failures++; } else { console.log("  OK"); }
}

await run(
  "Plain Q&A, no tools",
  { instructions: "Answer in one short sentence.", input: [{ kind: "input", type: "message", role: "user", content: [{ type: "text", text: "What is 2 + 2? Answer with just the number." }] }] },
  r => (r.status === "completed" && r.output.some(o => o.type === "message")) ? undefined : "expected a completed text message",
);

await run(
  "Decides to call a declared client tool instead of answering directly",
  {
    instructions: "You must use the get_dispute_case tool to answer questions about a specific dispute id. Never guess.",
    input: [{ kind: "input", type: "message", role: "user", content: [{ type: "text", text: "Use the tool to look up dispute id 42." }] }],
    tools: [{ name: "get_dispute_case", description: "Reads one dispute by id.", parameters: { type: "object", properties: { disputeId: { type: "number" } }, required: ["disputeId"] } }],
  },
  r => (r.status === "completed" && r.output.some(o => o.type === "function_call" && o.name === "get_dispute_case")) ? undefined : "expected a function_call to get_dispute_case",
);

// A discriminated-union parameter schema (anyOf of two shapes, picked by a `kind` const), modelled on the
// real shape that broke in the browser (AG Studio's own executeQuery tool). Confirms Gemini accepts `anyOf`
// in function parameters and picks a branch, rather than just working against the simpler single-shape
// tools above.
await run(
  "Calls a tool whose parameters are a discriminated union (anyOf) with a valid branch",
  {
    instructions: "Use the run_query tool. Pick whichever branch of its schema fits a simple count query.",
    input: [{ kind: "input", type: "message", role: "user", content: [{ type: "text", text: "Run a count query grouped by category." }] }],
    tools: [{
      name: "run_query",
      description: "Runs a query, either a grouped aggregation or a flat projection.",
      parameters: {
        type: "object",
        properties: {
          query: {
            anyOf: [
              { type: "object", properties: { kind: { const: "aggregation" }, groupBy: { type: "string" } }, required: ["kind", "groupBy"] },
              { type: "object", properties: { kind: { const: "projection" }, fields: { type: "array", items: { type: "string" } } }, required: ["kind", "fields"] },
            ],
          },
        },
        required: ["query"],
      },
    }],
  },
  r => {
    const call = r.output.find(o => o.type === "function_call" && o.name === "run_query");
    if (!call || call.type !== "function_call") return "expected a function_call to run_query";
    const args = JSON.parse(call.arguments) as { query?: { kind?: string } };
    return args.query?.kind === "aggregation" || args.query?.kind === "projection" ? undefined : `args didn't match either anyOf branch: ${call.arguments}`;
  },
);

// Exercises the real PayPal sandbox MCP server through our own client, bridged into Gemini - forced on here
// regardless of .env, since the only preconditions (GEMINI_API_KEY, PayPal sandbox credentials) are both present.
async function runWithMcp() {
  const withMcp = { ...cfg, PAYPAL_MCP_ENABLED: true };
  console.log("\nResolves a real PayPal MCP tool call end to end (PAYPAL_MCP_ENABLED forced on)");
  const r = await runGeminiStudioTurn(withMcp, {
    instructions: "Use the list_disputes tool to answer.",
    input: [{ kind: "input", type: "message", role: "user", content: [{ type: "text", text: "List the sandbox disputes you can see, in one sentence." }] }],
  });
  console.log("  ", JSON.stringify(r).slice(0, 500));
  if (r.status === "completed" && r.output.some(o => o.type === "message")) console.log("  OK");
  else { console.log("  FAIL: expected a completed text message after the MCP round trip"); failures++; }
}
await runWithMcp();

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
