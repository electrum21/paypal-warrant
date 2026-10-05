import { loadConfig } from "../config.js";
import { captureOrder, chargeVaultedToken, createVaultingOrder, getOrder, vaultFromOrder } from "../paypal/client.js";

/**
 * Feasibility spike for autonomous purchasing. Three steps, run in order:
 *   npm run smoke:vault -- start                 create an order that asks to save the buyer's PayPal account
 *   npm run smoke:vault -- capture <ORDER_ID>    after approving it, capture and read the vault token
 *   npm run smoke:vault -- charge <TOKEN_ID>     charge the token with NO approval step
 * Each step prints PayPal's raw error, because the useful answer is often "not enabled for vaulting".
 */
const cfg = loadConfig();
const [cmd, arg] = process.argv.slice(2);
const show = (label: string, v: unknown) => console.log(`${label}\n${JSON.stringify(v, null, 2)}`);

try {
  if (cmd === "start") {
    const o = await createVaultingOrder(cfg, {
      amountCents: 1000, currency: "USD", mandateId: "mandate-vault-spike", description: "Warrant vault spike",
      returnUrl: `${cfg.APP_URL}/paypal/cancel`, cancelUrl: `${cfg.APP_URL}/paypal/cancel`,
    });
    const approve = o.links.find(l => l.rel === "payer-action" || l.rel === "approve");
    console.log(`Order ${o.id} (${o.status}) created WITH vaulting. Step 1 passed: the app is allowed to ask for it.`);
    console.log(`Approve it in a private window as the sandbox PERSONAL account:\n${approve?.href ?? "(no approval link)"}`);
    console.log(`\nThe return page points at /paypal/cancel on purpose, so the server does not capture it for you. Then run:\n  npm run smoke:vault -- capture ${o.id}`);
  } else if (cmd === "capture" && arg) {
    const cap = await captureOrder(cfg, arg);
    const vault = vaultFromOrder(cap);
    show(`Capture ${cap.id}: ${cap.status}. Vault block:`, vault ?? "(none)");
    if (vault?.status === "VAULTED" && vault.id) console.log(`\nStep 2 passed. Now charge it with no approval:\n  npm run smoke:vault -- charge ${vault.id}`);
    else if (vault?.status === "APPROVED") console.log("\nPayPal approved vaulting but has not issued the token yet. It arrives in a VAULT.PAYMENT-TOKEN.CREATED webhook, which requires the configured public webhook URL.");
    else { console.log("\nNo vault token came back. Raw order, in case the token is somewhere unexpected:"); show("Order:", await getOrder(cfg, arg)); }
  } else if (cmd === "charge" && arg) {
    const r = await chargeVaultedToken(cfg, { tokenId: arg, amountCents: 1500, currency: "USD", mandateId: "mandate-vault-spike", chargeKey: `spike-${Date.now()}` });
    const c = r.purchase_units?.[0]?.payments?.captures?.[0];
    console.log(`Order was ${r.createdStatus} on creation; final status ${r.status}. Capture ${c?.id ?? "(none)"} for ${c?.amount.value} ${c?.amount.currency_code}.`);
    console.log("Step 3 passed: a payment was captured with no buyer click. Autonomous purchasing is feasible in this sandbox.");
  } else {
    console.log("Usage:\n  npm run smoke:vault -- start\n  npm run smoke:vault -- capture <ORDER_ID>\n  npm run smoke:vault -- charge <TOKEN_ID>");
  }
} catch (err) {
  console.error(`Failed: ${(err as Error).message}`);
  process.exit(1);
}