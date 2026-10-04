import { loadConfig } from "../config.js";
import { openDb } from "./index.js";

const cfg = loadConfig();
openDb(cfg.DATABASE_PATH);
console.log(`Database ready at ${cfg.DATABASE_PATH}`);
