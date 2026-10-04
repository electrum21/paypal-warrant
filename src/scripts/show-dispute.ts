import { loadConfig } from "../config.js";
import { ppFetch } from "../paypal/client.js";

const id = process.argv[2];
const cfg = loadConfig();
console.log(JSON.stringify(await ppFetch(cfg, `/v1/customer/disputes/${id}`), null, 2));