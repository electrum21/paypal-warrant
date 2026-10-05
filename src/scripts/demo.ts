import "dotenv/config";
import { randomUUID } from "node:crypto";
import { signControl, type ControlAction } from "../mandate/control.js";
import { cartFor, checkout, loadOrCreateAgent, loadOrCreateUser, buildMandate, signFor, buyFromRequest, planShoppingRequest, searchCatalog, DEMO_CATALOG, SCENARIOS, type ProductCandidate, type Scenario } from "../agent/buyer.js";

const base = process.env.WARRANT_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
const token = process.env.ADMIN_TOKEN ?? "";
const merchantId = process.env.MERCHANT_ID ?? "warrant-demo-merchant";
const [cmd, arg] = process.argv.slice(2);
const agent = loadOrCreateAgent(".demo-agent.json");
const user = loadOrCreateUser(".demo-user.json");

async function admin(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-admin-token": token }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Signs a control request with the USER's key and sends it. The agent never holds this key. */
async function userControl(path: string, action: ControlAction, subjectId: string, reason?: string) {
  const signedControl = signControl({ action, userId: user.userId, subjectId, reason, issuedAt: new Date().toISOString(), nonce: randomUUID() }, user.privateKeyPem);
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signedControl }) });
  const body = await res.json().catch(() => ({})) as any;
  console.log(res.ok ? `${action}: ok ${JSON.stringify(body)}` : `${action} failed (${res.status}): ${body.error ?? JSON.stringify(body)}`);
  if (!res.ok) process.exit(1);
}

if (cmd === "register") {
  const u = await admin("/api/users", { userId: user.userId, publicKeyPem: user.publicKeyPem });
  console.log(u.status === 201 ? `Registered user key for "${user.userId}" with ${base}` : `User registration failed (${u.status}): ${JSON.stringify(u.body)}`);
  const r = await admin("/api/agents", { agentId: agent.agentId, publicKeyPem: agent.publicKeyPem });
  console.log(r.status === 201 ? `Registered agent "${agent.agentId}" with ${base}` : `Agent registration failed (${r.status}): ${JSON.stringify(r.body)}`);
} else if (cmd === "link-payment" && arg) {
  const r = await admin("/api/users/payment-token", { userId: user.userId, tokenId: arg });
  console.log(r.status === 201 ? `Linked payment token to user "${user.userId}". The agent can now buy with: npm run demo -- buy-auto <scenario>` : `Failed (${r.status}): ${JSON.stringify(r.body)}`);
} else if (cmd === "buy-auto") {
  const s = arg as Scenario;
  if (!SCENARIOS[s]) { console.error(`Usage: npm run demo -- buy-auto <${Object.keys(SCENARIOS).join("|")}>`); process.exit(1); }
  const sc = SCENARIOS[s];
  const signedMandate = signFor(user, buildMandate(agent, merchantId));
  const signedCart = cartFor(agent, signedMandate, { merchantId, amountCents: sc.amountCents, category: sc.category });
  console.log(`Scenario ${s}: ${sc.label}\nAutonomous purchase: no approval link, the saved PayPal account is charged directly.`);
  const r = await checkout(base, signedMandate, signedCart, { amountCents: sc.amountCents, category: sc.category, description: `Warrant demo auto (${s})` }, "autonomous");
  if (r.status === 201) console.log(`Paid. Order ${r.body.orderId}, capture ${r.body.captureId}. Findings: ${r.body.findings.length ? r.body.findings.map((f: any) => f.code).join(", ") : "none"}\nNow raise a dispute on that payment as the sandbox buyer, then: npm run demo -- import <PAYPAL_DISPUTE_ID>`);
  else console.log(`Refused (${r.status}): ${r.body.error}${r.body.findings?.length ? ` Findings: ${r.body.findings.map((f: any) => f.code).join(", ")}` : ""}`);
} else if (cmd === "buy") {
  const s = arg as Scenario;
  if (!SCENARIOS[s]) { console.error(`Usage: npm run demo -- buy <${Object.keys(SCENARIOS).join("|")}>`); process.exit(1); }
  const mandate = buildMandate(agent, merchantId);
  const sc = SCENARIOS[s];
  console.log(`Scenario ${s}: ${sc.label}\nMandate ${mandate.id}: "${mandate.description}"`);
  const signedMandate = signFor(user, mandate);
  const signedCart = cartFor(agent, signedMandate, { merchantId, amountCents: sc.amountCents, category: sc.category });
  const r = await checkout(base, signedMandate, signedCart, { amountCents: sc.amountCents, category: sc.category, description: `Warrant demo (${s})` });
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
  const parsed = request.match(/(?:under|below|maximum|max|up to|less than)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i);
  const category = /(?:shoe|runner|footwear)/i.test(request) ? "footwear" : /(?:gadget|electronic|phone|laptop)/i.test(request) ? "electronics" : "general";
  let remote: { source: string; products: ProductCandidate[] } = { source: "local", products: [] };
  if (parsed) {
    try {
      remote = await searchCatalog(base, {
        query: request, maxAmountCents: Math.round(Number(parsed[1]) * 100), currency: "USD", category,
      });
    } catch (err) {
      console.log(`Catalog search failed (${(err as Error).message}); using the local catalog instead.`);
    }
  }
  const catalog = remote.products.length ? remote.products : DEMO_CATALOG;
  console.log(`Catalog source: ${remote.products.length ? remote.source : "local fallback"}`);
  const plan = planShoppingRequest(request, user, agent, merchantId, catalog);
  console.log(`Buyer agent understood: ${plan.intent.productDescription}`);
  console.log(`Budget: ${(plan.intent.maxAmountCents / 100).toFixed(2)} ${plan.intent.currency}`);
  console.log(`Selected product: ${plan.product.description} for ${(plan.product.amountCents / 100).toFixed(2)} ${plan.product.currency}`);
  console.log(`Mandate ${plan.mandate.mandate.id} signed by user "${user.userId}"; cart ${plan.cart.cart.cartId} signed by agent "${agent.agentId}"`);
  const r = await checkout(base, plan.mandate, plan.cart, {
    amountCents: plan.product.amountCents, category: plan.product.category, description: plan.product.description,
  });
  if (r.status !== 201) { console.error(`Checkout failed (${r.status}): ${JSON.stringify(r.body)}`); process.exit(1); }
  console.log(`Order ${r.body.orderId} created. Findings: ${r.body.findings.length ? r.body.findings.map((f: any) => f.code).join(", ") : "none"}`);
  console.log(`Approve at: ${r.body.approveUrl}`);
  } catch (err) {
  console.error(`Buyer agent could not plan this purchase: ${(err as Error).message}`);
  process.exit(1);
  }
} else if (cmd === "buy-request-auto") {
  const request = process.argv.slice(3).join(" ").trim();
  if (!request) { console.error('Usage: npm run demo -- buy-request-auto "Buy trail running shoes under $120"'); process.exit(1); }
  const r = await buyFromRequest(base, request, { user, agent, merchantId }, "autonomous");
  console.log(`Catalog source: ${r.catalogSource}`);
  if (r.fallbackReason) console.log(`FALLBACK: remote catalog unavailable (${r.fallbackReason}); using the local demo catalog instead.`);
  if (r.planError || !r.plan || !r.response) { console.error(`Buyer agent could not plan this purchase: ${r.planError}`); process.exit(1); }
  const { plan, response } = r;
  console.log(`Selected product: ${plan.product.description} (${plan.product.id}) for ${(plan.product.amountCents / 100).toFixed(2)} ${plan.product.currency}`);
  console.log(`Mandate: ${plan.mandate.mandate.id}\nCart: ${plan.cart.cart.cartId}`);
  const findings = (response.body.findings ?? []).map((f: any) => f.code).join(", ") || "none";
  if (response.status === 201) console.log(`Order: ${response.body.orderId}\nCapture: ${response.body.captureId}\nFindings: ${findings}`);
  else { console.error(`Refused (${response.status}): ${response.body.error}\nFindings: ${findings}`); process.exit(1); }
} else if (cmd === "revoke" && arg) {
  await userControl(`/api/mandates/${encodeURIComponent(arg)}/revoke`, "revoke_mandate", arg, process.argv.slice(4).join(" ") || undefined);
} else if (cmd === "pause") {
  await userControl(`/api/users/${encodeURIComponent(user.userId)}/pause-agent`, "pause_agent", user.userId, process.argv.slice(3).join(" ") || undefined);
} else if (cmd === "resume") {
  await userControl(`/api/users/${encodeURIComponent(user.userId)}/resume-agent`, "resume_agent", user.userId);
} else if (cmd === "revoke-payment") {
  await userControl(`/api/users/${encodeURIComponent(user.userId)}/revoke-payment`, "revoke_payment_authorization", user.userId, process.argv.slice(3).join(" ") || undefined);
} else if (cmd === "import" && arg) {
  const r = await admin("/api/disputes/import", { paypalDisputeId: arg });
  console.log(r.status === 201 ? `Proposal: ${r.body.decision?.action}\n${r.body.explanation}` : `Failed (${r.status}): ${JSON.stringify(r.body)}`);
} else {
  console.log("Usage:\n  npm run demo -- register\n  npm run demo -- link-payment <VAULT_TOKEN_ID>\n  npm run demo -- buy <within|over|category>\n  npm run demo -- buy-auto <within|over|category>\n  npm run demo -- buy-request \"Buy trail running shoes under $120\"\n  npm run demo -- buy-request-auto \"Buy trail running shoes under $120\"\n  npm run demo -- pause [reason]\n  npm run demo -- resume\n  npm run demo -- revoke <MANDATE_ID> [reason]\n  npm run demo -- revoke-payment [reason]\n  npm run demo -- import <PAYPAL_DISPUTE_ID>");
}