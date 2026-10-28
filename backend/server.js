// Starts the Kite backend. Settings come from environment variables:
//
//   PORT                   port to listen on (default 8080)
//   ALLOWED_ORIGINS        your Kite frontend(s), comma-separated, e.g.
//                          https://kite.vercel.app,http://localhost:3000
//                          Without it, anyone who finds this server can use it.
//   ALLOWED_PORTS          ports sites may be on (default 80,443,8080,8443)
//   MAX_ACTIVE_PER_IP      concurrent page requests per visitor (default 100)
//   MAX_WEBSOCKETS_PER_IP  open WebSockets per visitor (default 30)
//   TRUST_CF=1             behind a Cloudflare Tunnel
//   COOKIE_FILE            keep site cookies (your logins) across restarts in this file

import { createKiteServer } from "./app.js";
import { PREFIX } from "./proxy.js";
import { WS_PREFIX } from "./websocket.js";

const list = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);

const PORT = Number(process.env.PORT || 8080);
const allowedOrigins = list(process.env.ALLOWED_ORIGINS);

const { server, sessions } = createKiteServer({
  allowedOrigins,
  allowedPorts: process.env.ALLOWED_PORTS ? list(process.env.ALLOWED_PORTS).map(Number) : undefined,
  maxActivePerIp: Number(process.env.MAX_ACTIVE_PER_IP || 100),
  maxWebSocketsPerIp: Number(process.env.MAX_WEBSOCKETS_PER_IP || 30),
  trustCloudflare: process.env.TRUST_CF === "1",
  cookieFile: process.env.COOKIE_FILE || null,
});

if (!allowedOrigins.length) console.warn("[warn] ALLOWED_ORIGINS is not set: anyone can use this proxy.");

// Save cookie jars (if COOKIE_FILE is set) when stopped with Ctrl+C.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    sessions.save();
    process.exit(0);
  });
}

server.listen(PORT, () => {
  console.log(`Kite backend on :${PORT}  (pages: ${PREFIX}, websockets: ${WS_PREFIX}, health: /health)`);
  console.log(`Allowed origins: ${allowedOrigins.length ? allowedOrigins.join(", ") : "ANY"}`);
  console.log(`Cookies: ${process.env.COOKIE_FILE ? `saved to ${process.env.COOKIE_FILE}` : "in memory (set COOKIE_FILE to keep them across restarts)"}`);
});
