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

## How it works

1. A tab loads `BACKEND/proxy/<base64url of the real URL>` in an iframe.
2. `backend/proxy.js` fetches the real page and rewrites every URL in the HTML and
   CSS (`href`, `src`, `srcset`, `action`, `style`, `url()`, `@import`, redirects) to
   point back through `/proxy/`.
3. It removes headers that would stop the page loading in a tab (CSP,
   X-Frame-Options...) and never forwards your cookies.
4. A script injected into every page (`kiteClient` in `proxy.js`) catches the URLs the
   page's own JavaScript builds (`fetch`, XHR, `img.src`, `location.href = ...`,
   `window.open`...) and sends them through Kite too. It also tells the Kite UI the
   page's real address and title.
5. Anything that still slips past is caught on the server using the Referer header.

## Roadmap

- [x] **Stage 1:** server-side fetch and HTML/CSS rewriting
- [x] **Stage 2:** injected script that intercepts `fetch`, XHR, `sendBeacon`, workers,
  element URLs, links, forms, `location`, `window.open` and history
- [x] **Stage 3:** WebSocket (`wss://`) relay at `/ws/` (`backend/websocket.js`)
- [ ] **Stage 4:** per-site cookie jar and a service worker
- [ ] **Stage 5:** JavaScript rewriting (needed for Google, YouTube, logins)

Right now, most ordinary sites work, including live updates over WebSockets. Logins
(cookies) and the very hardest sites (Google, YouTube) need the later stages.

## Security

- Set `ALLOWED_ORIGINS` so only your Kite frontend can use the backend.
- The backend refuses private, loopback and cloud-metadata addresses, including
  hostnames that resolve to them, so it can't be used to reach your own network.
- Only ports 80, 443, 8080 and 8443 are allowed by default (`ALLOWED_PORTS` to change).
- Open proxies get abused fast. Don't share your backend URL publicly.
