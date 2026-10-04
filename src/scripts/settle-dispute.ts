import { loadConfig } from "../config.js";
import { ppFetch } from "../paypal/client.js";

const [id, outcome] = process.argv.slice(2); // SELLER_FAVOR or BUYER_FAVOR
const cfg = loadConfig();
console.log(JSON.stringify(
  await ppFetch(cfg, `/v1/customer/disputes/${id}/adjudicate`, { body: { adjudication_outcome: outcome } }), null, 2));