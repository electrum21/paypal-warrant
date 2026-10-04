import { loadConfig } from "../config.js";
import { getAccessToken } from "../paypal/client.js";

const token = await getAccessToken(loadConfig());
console.log(`Auth OK. Token starts with ${token.slice(0, 8)}...`);
