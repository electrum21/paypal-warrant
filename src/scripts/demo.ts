import "dotenv/config";
import { checkout, loadOrCreateAgent, buildMandate, signFor, planShoppingRequest, DEMO_CATALOG, SCENARIOS, type Scenario } from "../agent/buyer.js";

const base = process.env.WARRANT_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
const token = process.env.ADMIN_TOKEN ?? "";
const merchantId = process.env.MERCHANT_ID ?? "warrant-demo-merchant";
const [cmd, arg] = process.argv.slice(2);
const agent = loadOrCreateAgent(".demo-agent.json");

async function admin(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-admin-token": token }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

if (cmd === "register") {
  const r = await admin("/api/agents", { agentId: agent.agentId, publicKeyPem: agent.publicKeyPem });
  console.log(r.status === 201 ? `Registered agent "${agent.agentId}" with ${base}` : `Failed (${r.status}): ${JSON.stringify(r.body)}`);
} else if (cmd === "buy") {
  const s = arg as Scenario;
  if (!SCENARIOS[s]) { console.error(`Usage: npm run demo -- buy <${Object.keys(SCENARIOS).join("|")}>`); process.exit(1); }
  const mandate = buildMandate(agent, merchantId);
  const sc = SCENARIOS[s];
  console.log(`Scenario ${s}: ${sc.label}\nMandate ${mandate.id}: "${mandate.description}"`);
  const r = await checkout(base, signFor(agent, mandate), { amountCents: sc.amountCents, category: sc.category, description: `Warrant demo (${s})` });
  if (r.status !== 201) { console.error(`Checkout failed (${r.status}): ${JSON.stringify(r.body)}`); process.exit(1); }
  console.log(`Order ${r.body.orderId} created. Findings: ${r.body.findings.length ? r.body.findings.map((f: any) => f.code).join(", ") : "none"}`);
  console.log(`\nNext:\n 1. Open this link in a private window and approve as the sandbox PERSONAL account:\n    ${r.body.approveUrl}\n 2. Then raise a dispute on that payment as the sandbox buyer, and import it:\n    npm run demo -- import <PAYPAL_DISPUTE_ID>\n 3. Review it at ${base}/admin?token=<ADMIN_TOKEN>\n    Expected proposal: ${sc.expect}`);
} else if (cmd === "buy-request") {
  const request = process.argv.slice(3).join(" ").trim();
  if (!request) {
  console.error("Usage: npm run demo -- buy-request \"Buy trail running shoes under $120\"");
  process.exit(1);
  }
  try {
  const plan = planShoppingRequest(request, agent, merchantId, DEMO_CATALOG);
  console.log(`Buyer agent understood: ${plan.intent.productDescription}`);
  console.log(`Budget: ${(plan.intent.maxAmountCents / 100).toFixed(2)} ${plan.intent.currency}`);
  console.log(`Selected product: ${plan.product.description} for ${(plan.product.amountCents / 100).toFixed(2)} ${plan.product.currency}`);
  console.log(`Signed mandate: ${plan.mandate.mandate.id}`);
  const r = await checkout(base, plan.mandate, {
    amountCents: plan.product.amountCents, category: plan.product.category, description: plan.product.description,
  });
  if (r.status !== 201) { console.error(`Checkout failed (${r.status}): ${JSON.stringify(r.body)}`); process.exit(1); }
  console.log(`Order ${r.body.orderId} created. Findings: ${r.body.findings.length ? r.body.findings.map((f: any) => f.code).join(", ") : "none"}`);
  console.log(`Approve at: ${r.body.approveUrl}`);
  } catch (err) {
  console.error(`Buyer agent could not plan this purchase: ${(err as Error).message}`);
  process.exit(1);
  }
} else if (cmd === "import" && arg) {
  const r = await admin("/api/disputes/import", { paypalDisputeId: arg });
  console.log(r.status === 201 ? `Proposal: ${r.body.decision?.action}\n${r.body.explanation}` : `Failed (${r.status}): ${JSON.stringify(r.body)}`);
} else {
  console.log("Usage:\n  npm run demo -- register\n  npm run demo -- buy <within|over|category>\n  npm run demo -- buy-request \"Buy trail running shoes under $120\"\n  npm run demo -- import <PAYPAL_DISPUTE_ID>");
}
