// Builds Kite Web into frontend/dist from the shared interface (../shared):
//   shared/ui/*          -> dist/            (the browser interface)
//   shared/lib/*         -> dist/lib/        (shared logic: address bar, ...)
//   shared/platform/web* -> dist/platform/   (Kite Web: tabs through the backend)
// and writes dist/config.js with the backend URL. Set BACKEND_URL (e.g.
// https://kite-api.example.com), e.g. as a Vercel environment variable.
import { cpSync, mkdirSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shared = join(here, "..", "..", "shared");
const dist = join(here, "..", "dist");
const backendUrl = (process.env.BACKEND_URL || "http://localhost:8080").replace(/\/+$/, "");

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "platform"), { recursive: true });
cpSync(join(shared, "ui"), dist, { recursive: true });
cpSync(join(shared, "lib"), join(dist, "lib"), { recursive: true });
for (const f of readdirSync(join(shared, "platform"))) {
  if (f.startsWith("web")) cpSync(join(shared, "platform", f), join(dist, "platform", f));
}
writeFileSync(join(dist, "platform", "index.js"), 'export { default } from "./web.js";\n');
writeFileSync(join(dist, "config.js"), `window.APP_CONFIG = ${JSON.stringify({ backendUrl }, null, 2)};\n`);
console.log(`[build] Kite Web built in frontend/dist (backendUrl = ${backendUrl})`);
