import { loadConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { createApp } from "./app.js";

const cfg = loadConfig();
const db = openDb(cfg.DATABASE_PATH);
createApp(cfg, db).listen(cfg.PORT, () => console.log(`Warrant listening on :${cfg.PORT}`));
