# Kite

A browser in your browser. Kite has tabs, an address bar and search, and loads
every site through its own proxy engine, written from scratch with no dependencies.

```
 Your browser                          Vercel                   Your server
┌──────────────────────────┐       ┌────────────────┐       ┌──────────────────────────┐
│ Kite UI (tabs, address)  │◄──────│ /frontend      │       │ /backend                 │
│                          │static │ static files   │       │ fetches the real page,   │
│ each tab = iframe ───────┼───────┴────────────────┴──────►│ rewrites every link,     │
│ /proxy/<encoded-url>     │◄─────────── rewritten page ────│ image, stylesheet, form  │
└──────────────────────────┘                                └──────────────────────────┘
```

- `frontend/` is static and deploys to Vercel.
- `backend/` is a small Node server you host yourself (Codespaces, a VPS, a home
  server behind a Cloudflare Tunnel, Fly.io, Railway...).

## Try it in GitHub Codespaces

1. Open this repo in a Codespace (Code > Codespaces > Create codespace).
2. In the terminal run:
   ```bash
   ./scripts/codespaces-start.sh
   ```
3. Open the frontend URL it prints (`https://<codespace>-3000.app.github.dev`).

The script starts both servers and makes ports 3000 and 8080 public. If it can't,
open the **Ports** tab, right-click each port, and choose **Port Visibility > Public**.
Stop the Codespace when you're done so the public ports go away.

Run the tests (no internet needed, uses a fake local website):

```bash
cd backend && npm test
```

## Run it locally

```bash
# terminal 1
cd backend
ALLOWED_ORIGINS=http://localhost:3000 node server.js

# terminal 2
cd frontend
npm run dev
```

Open http://localhost:3000.

## Deploy

**Backend:** run `node server.js` anywhere that can stay online, or use the Dockerfile:

```bash
cd backend
docker build -t kite-backend .
docker run -p 8080:8080 -e ALLOWED_ORIGINS=https://YOUR-KITE.vercel.app kite-backend
```

**Frontend on Vercel:** import the repo, set **Root Directory** to `frontend`, add
the environment variable `BACKEND_URL=https://YOUR-BACKEND-HOST`, and deploy. Then put
your Vercel URL in the backend's `ALLOWED_ORIGINS`.

You can also change the backend at any time with the gear button in Kite's toolbar.

## Run the backend at home (Windows)

A home internet connection is trusted by sites far more than a cloud server, so this is
the best place to run Kite's backend. You need [Git](https://git-scm.com),
[Node.js 20+](https://nodejs.org) and
[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):

```bat
winget install --id Git.Git -e
winget install OpenJS.NodeJS.LTS
winget install --id Cloudflare.cloudflared
```

1. Get the code: `git clone https://github.com/JarOfSoapyBeans/Project-Kite.git`
2. Edit the settings at the top of `start_home.bat` (`notepad start_home.bat`): set
   `ALLOWED_ORIGINS` to your Kite frontend's address.
3. Double-click `start_home.bat` (or run it in Command Prompt). It opens two windows:
   the backend, and a Cloudflare Tunnel that gives it a public `https://` address.
4. Give that address to Kite (gear button, or `BACKEND_URL` on Vercel).

**A permanent address (recommended).** A quick tunnel gets a new random address every
time. With a domain on Cloudflare, create a named tunnel once:

```bat
cloudflared tunnel login
cloudflared tunnel create kite
cloudflared tunnel route dns kite kite-api.YOUR-DOMAIN.com
```

then set `TUNNEL_NAME=kite` in `start_home.bat`. Your backend is then always at
`https://kite-api.YOUR-DOMAIN.com`.

To update later: `git pull`, then restart `start_home.bat`. Your cookies stay in
`.kite-cookies.json` (git-ignored; it holds your logins, so keep it private).

## How it works

1. A tab loads `BACKEND/proxy/<base64url of the real URL>` in an iframe.
2. `backend/proxy.js` fetches the real page and rewrites every URL in the HTML and
   CSS (`href`, `src`, `srcset`, `action`, `style`, `url()`, `@import`, redirects) to
   point back through `/proxy/`.
3. It removes headers that would stop the page loading in a tab (CSP,
   X-Frame-Options...) and never forwards your cookies.
4. The backend keeps each person's site cookies (Stage 4) and sends them with requests,
   following browser rules; your real browser only ever stores Kite's own session cookie.
5. A script injected into every page (`kiteClient` in `proxy.js`) catches the URLs the
   page's own JavaScript builds (`fetch`, XHR, `img.src`, `location.href = ...`,
   `window.open`...) and sends them through Kite too. It also tells the Kite UI the
   page's real address and title.
6. Anything that still slips past is caught on the server using the Referer header.

## Roadmap

- [x] **Stage 1:** server-side fetch and HTML/CSS rewriting
- [x] **Stage 2:** injected script that intercepts `fetch`, XHR, `sendBeacon`, workers,
  element URLs, links, forms, `location`, `window.open` and history
- [x] **Stage 3:** WebSocket (`wss://`) relay at `/ws/` (`backend/websocket.js`)
- [x] **Stage 4:** cookies: one private cookie jar per person, kept on the backend
  (`backend/cookies.js`, `sessions.js`, `kite-api.js`), `document.cookie` in pages,
  and a cookie manager (the cookie button in the toolbar)
- [ ] **Stage 5:** JavaScript rewriting (needed for Google, YouTube, logins)

Right now, most ordinary sites work, including live updates over WebSockets and staying
signed in. The very hardest sites (Google, YouTube) need Stage 5, and some sign-in pages
(notably Google's) refuse to work inside any proxy.

## Cookies and privacy

Sites' cookies never reach your real browser. The backend keeps one cookie jar per
person using Kite (picked by a private `kite_sid` cookie) and follows the same rules
browsers do: domains, paths, `Secure`, `HttpOnly`, expiry and `SameSite`.

- **Third-party cookies are blocked**, like Safari and Firefox do. In Kite every site
  shares the backend's address, so this is what stops one site from reading another
  site's signed-in pages through Kite. A site only gets its cookies when a page from
  that same site asks, or when *you* navigate to it (typing an address, clicking a link).
- Cookies live in memory unless `COOKIE_FILE` is set (the Codespaces script uses
  `.kite-cookies.json`, which is git-ignored). That file contains your logins: keep it
  private.
- The cookie button in the toolbar shows which sites have cookies and clears them.
- `kite_sid` is a `SameSite=None; Secure; Partitioned` cookie so it works when the
  frontend and backend are on different sites (e.g. Vercel + your home server). Safari
  blocks such cookies; if you use Safari, serve both from one site (e.g.
  `kite.example.com` and `api.kite.example.com`).

## Security

- Set `ALLOWED_ORIGINS` so only your Kite frontend can use the backend.
- The backend refuses private, loopback and cloud-metadata addresses, including
  hostnames that resolve to them, so it can't be used to reach your own network.
- Only ports 80, 443, 8080 and 8443 are allowed by default (`ALLOWED_PORTS` to change).
- Open proxies get abused fast. Don't share your backend URL publicly.
