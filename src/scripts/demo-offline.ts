import { newAgent, SCENARIOS, type Scenario } from "../agent/buyer.js";
import { runOffline } from "../agent/offline.js";
import { anthropicClient } from "../ai/draft.js";
import { openDb } from "../db/index.js";

// Optional: set ANTHROPIC_API_KEY to see real LLM explanations instead of the template.
const key = process.env.ANTHROPIC_API_KEY;
const llm = key ? anthropicClient(key, process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5") : undefined;
const db = openDb();
const agent = newAgent();
const only = process.argv[2] as Scenario | undefined;
const list = (only ? [only] : (Object.keys(SCENARIOS) as Scenario[]));

console.log(`Warrant offline demo (fake PayPal, in-memory database, ${llm ? "LLM on" : "template text, no LLM"})\n`);
for (const s of list) {
  if (!SCENARIOS[s]) { console.error(`Unknown scenario "${s}". Use: ${Object.keys(SCENARIOS).join(", ")}`); process.exit(1); }
  const r = await runOffline(s, { db, agent, llm });
  const p = r.proposal;
  console.log(`=== ${s}: ${SCENARIOS[s].label}`);
  console.log(`Mandate says:      "${r.mandate.description}"`);
  console.log(`Buyer agent trace: ${r.buyerTrace.map(x => x.tool).join(" -> ")}`);
  console.log(`Checked at order:  ${r.findings.length ? r.findings.map(f => f.code).join(", ") : "within the mandate"}`);
  console.log(`Buyer disputes it as UNAUTHORISED.`);
  console.log(`Warrant proposes:  ${p.decision?.action}${p.decision?.refundCents ? ` (refund ${(p.decision.refundCents / 100).toFixed(2)} USD)` : ""}`);
  console.log(`Why:               ${p.explanation}`);
  console.log(`Sent to PayPal before approval: ${r.sentBeforeApproval} calls`);
  console.log(`After merchant approves:        ${r.sent.map(x => `${x.call} ${JSON.stringify(x.detail)}`).join("; ")}  -> ${r.approved.workflowState}`);
  console.log(`Merchant agent trace: ${p.agentEvents?.map(e => e.toolName).join(" -> ") ?? "not recorded"}`);
  console.log(`Matches expectation (${SCENARIOS[s].expect}): ${p.decision?.action === SCENARIOS[s].expect ? "yes" : "NO"}\n`);
}
