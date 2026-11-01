// "Sign in with Google" for Kite accounts (OpenID Connect, authorization code
// flow with PKCE). No dependencies.
//
// Set these (see start_home.bat and the README):
//   GOOGLE_CLIENT_ID       from Google Cloud Console -> Credentials -> OAuth client ID
//   GOOGLE_CLIENT_SECRET   (same place)
//   GOOGLE_REDIRECT_URI    https://<your backend>/__kite/google/callback
//                          (must also be listed on the OAuth client in Google Cloud)
//   KITE_GOOGLE_ALLOWED    optional: only these Google emails may sign in (comma-separated)
//
// How it works: the Kite UI opens a popup at /__kite/google/start with a secret
// "claim" value only it knows. Google sends the popup back to /__kite/google/callback;
// the backend checks the answer directly with Google, and holds the result under
// that claim. The Kite UI then collects it (POST /__kite/account/google) from its
// own context, where its Kite session cookie lives, and is signed in.
//
// This signs you in to *Kite* with your Google identity. It does not sign you
// in to youtube.com inside Kite (Google only gives those cookies to its own
// sign-in page).

import crypto from "node:crypto";

const START_MS = 10 * 60 * 1000; // a sign-in must finish within 10 minutes
const RESULT_MS = 2 * 60 * 1000; // and be collected within 2 minutes

const list = (v) => String(v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export function googleConfig(env = process.env) {
  const c = {
    clientId: env.GOOGLE_CLIENT_ID || "",
    clientSecret: env.GOOGLE_CLIENT_SECRET || "",
    redirectUri: env.GOOGLE_REDIRECT_URI || "",
    allowed: list(env.KITE_GOOGLE_ALLOWED),
    // Only for tests (a stand-in for Google).
    authUrl: env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token",
  };
  c.enabled = Boolean(c.clientId && c.clientSecret && c.redirectUri);
  return c;
}

const pending = new Map(); // state -> { verifier, claim, origin, expires }
const results = new Map(); // claim -> { ok: { sub, email, name } | error, expires }
function tidy() {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires <= now) pending.delete(k);
  for (const [k, v] of results) if (v.expires <= now) results.delete(k);
  while (pending.size > 1000) pending.delete(pending.keys().next().value);
  while (results.size > 1000) results.delete(results.keys().next().value);
}

const CLAIM = /^[A-Za-z0-9_-]{32,128}$/;

function page(res, status, title, text) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    "referrer-policy": "no-referrer",
    "x-kite-source": "kite",
  });
  res.end(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<body style="font:16px system-ui;background:#16181d;color:#e6e8ec;display:grid;place-items:center;height:90vh">
<div style="text-align:center"><h2>${esc(title)}</h2><p>${esc(text)}</p></div>
<script>setTimeout(function(){ window.close(); }, 1500)</script>`);
}

// GET /__kite/google/start?claim=...&origin=...  (opened in a popup by the Kite UI)
// GET /__kite/google/callback?code=...&state=...  (Google sends the popup back here)
export async function handleGoogle(req, res, { allowedOrigins = [], config = googleConfig(), fetchImpl = fetch } = {}) {
  const url = new URL(req.url, "http://localhost");
  if (!config.enabled) return page(res, 404, "Not set up", "Sign in with Google isn't set up on this Kite backend.");
  tidy();

  if (url.pathname === "/__kite/google/start") {
    const claim = url.searchParams.get("claim") || "";
    const origin = url.searchParams.get("origin") || "";
    if (!CLAIM.test(claim)) return page(res, 400, "Can't sign in", "This sign-in link is broken. Try again from Kite.");
    if (allowedOrigins.length && !allowedOrigins.includes(origin)) {
      return page(res, 403, "Can't sign in", "Sign in from your Kite page.");
    }
    const state = crypto.randomBytes(24).toString("base64url");
    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    pending.set(state, { verifier, claim, origin, expires: Date.now() + START_MS });
    const google = new URL(config.authUrl);
    google.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    res.writeHead(302, { location: google.href, "cache-control": "no-store", "referrer-policy": "no-referrer", "x-kite-source": "kite" });
    return res.end();
  }

  if (url.pathname === "/__kite/google/callback") {
    const state = url.searchParams.get("state") || "";
    const p = pending.get(state);
    pending.delete(state); // one use only
    if (!p) return page(res, 400, "Can't sign in", "This sign-in has expired or was already used. Try again from Kite.");
    const finish = (value, title, text) => {
      results.set(p.claim, { ...value, expires: Date.now() + RESULT_MS });
      return page(res, value.ok ? 200 : 403, title, text);
    };
    if (url.searchParams.get("error")) return finish({ error: "Google sign-in was cancelled." }, "Cancelled", "You can close this window.");
    const code = url.searchParams.get("code");
    if (!code) return finish({ error: "Google didn't send a sign-in code." }, "Can't sign in", "Try again from Kite.");
    let who;
    try {
      who = await exchange(code, p.verifier, config, fetchImpl);
    } catch (err) {
      console.warn(`[warn] Google sign-in failed: ${err.message}`);
      return finish({ error: "Google sign-in failed: " + err.message }, "Can't sign in", err.message);
    }
    if (config.allowed.length && !config.allowed.includes(who.email)) {
      return finish({ error: `${who.email} isn't allowed to use this Kite.` }, "Not allowed", `${who.email} isn't allowed to use this Kite.`);
    }
    return finish({ ok: who }, "Signed in", "You're signed in to Kite. You can close this window.");
  }

  return page(res, 404, "Not found", "");
}

// Trade the code for an ID token, straight from Google over HTTPS (with the client
// secret and PKCE verifier), and read who signed in from it.
async function exchange(code, verifier, config, fetchImpl) {
  const r = await fetchImpl(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.id_token) throw new Error(data.error_description || data.error || `Google answered ${r.status}`);
  // Received directly from Google's token endpoint over TLS, so the token's
  // signature needn't be checked (OpenID Connect Core 3.1.3.7); its contents are.
  const part = String(data.id_token).split(".")[1] || "";
  let claims;
  try {
    claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new Error("Google's answer couldn't be read");
  }
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw new Error("wrong issuer");
  if (claims.aud !== config.clientId) throw new Error("token is for another app");
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new Error("token expired");
  if (!claims.sub) throw new Error("no account id");
  if (!claims.email || claims.email_verified === false) throw new Error("Google account has no verified email");
  return { sub: String(claims.sub), email: String(claims.email).toLowerCase(), name: String(claims.name || "") };
}

// The Kite UI collects a finished sign-in. Returns undefined while still waiting.
export function takeGoogleResult(claim) {
  if (!CLAIM.test(String(claim || ""))) return { error: "bad claim" };
  tidy();
  const r = results.get(claim);
  if (r) results.delete(claim);
  return r;
}
