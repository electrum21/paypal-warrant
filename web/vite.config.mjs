import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Built into web/dist and served by the Warrant server at /studio.
// `npm run dev:web` serves the app with hot reload and proxies the API to a locally running Warrant (npm run dev).
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/studio/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173, proxy: { "/api": "http://localhost:8787", "/studio-api": "http://localhost:8787" } },
});
