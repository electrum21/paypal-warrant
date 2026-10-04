import { loadConfig } from "../config.js";
import { createOrder } from "../paypal/client.js";

const cfg = loadConfig();
const order = await createOrder(cfg, {
  amountCents: 1000, currency: "USD", mandateId: "mandate-smoke-test", description: "Warrant smoke test",
  returnUrl: `${cfg.APP_URL}/paypal/return`,
  cancelUrl: `${cfg.APP_URL}/paypal/cancel`,
});
const approve = order.links.find(l => l.rel === "payer-action" || l.rel === "approve");
console.log(`Order ${order.id} (${order.status}).`);
console.log(`Open this link in a private window and approve it as the sandbox PERSONAL account:\n${approve?.href ?? "(no approval link found)"}`);
console.log(`\nMake sure the server is running (npm run dev) so the return page can capture the payment.`);
