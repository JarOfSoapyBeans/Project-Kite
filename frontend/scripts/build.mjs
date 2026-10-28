// Writes public/config.js with the backend URL.
// Set BACKEND_URL (e.g. https://kite-backend.example.com) as a Vercel environment variable.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const backendUrl = (process.env.BACKEND_URL || "http://localhost:8080").replace(/\/+$/, "");

writeFileSync(join(pub, "config.js"), `window.APP_CONFIG = ${JSON.stringify({ backendUrl }, null, 2)};\n`);
console.log(`[build] wrote config.js (backendUrl = ${backendUrl})`);
