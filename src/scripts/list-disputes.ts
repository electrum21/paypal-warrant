import { loadConfig } from "../config.js";
import { ppFetch } from "../paypal/client.js";

const cfg = loadConfig();
const r: any = await ppFetch(cfg, "/v1/customer/disputes?page_size=20");
for (const d of r.items ?? []) {
  console.log(`${d.dispute_id}  ${d.reason}  ${d.status}  ${d.dispute_amount?.value} ${d.dispute_amount?.currency_code}  created ${d.create_time}`);
}
if (!(r.items ?? []).length) console.log("No disputes visible to the merchant account yet.");