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

### Kite is becoming an app (Stage 7)

Kite is mainly a **desktop browser app** (real Chromium, in progress), with
**Kite Web**, the version above, that looks and works like it. Both use one
interface:

```
shared/            the browser interface and logic, written once
  ui/              tabs, toolbar, address bar, new tab page (index.html, app.js, ...)
                   features.js: padlock, permissions, find, zoom, downloads, profiles, menus
                   pages.js: new tab, history, bookmarks, settings; store.js: their data
  lib/             shared logic (omnibox.js: address or search?; data.js: history,
                   bookmarks, shortcuts, settings)
  platform/        how tabs work where Kite runs:
    web.js           Kite Web: each tab is an iframe through the backend
    web-panels.js    Kite Web only: accounts, cookie jar, backend address
    desktop.js       the Kite app: each tab is a real Chromium view
frontend/          Kite Web: `npm run build` assembles shared/ into frontend/dist
backend/           the proxy that powers Kite Web
desktop/           the Kite app (Electron): main.js, preload.js, view-preload.js,
  lib/               profiles, site permissions, downloads, menus, sync
  pages/             the app's own pages (error.html)
```

From the repo folder: `npm test` runs the shared, backend and app tests, `npm run web`
builds and serves Kite Web on http://localhost:3000.

### Run the Kite app

Double-click `start_desktop.bat` (Windows), or from the repo folder:

```bash
npm install --workspace desktop   # first time: downloads Electron
npm run desktop
```

Each tab is a real Chromium page: sites load directly, as in Chrome or Edge, with
no backend and no rewriting. What the app has:

- **Profiles**: each with its own logins, cookies, storage and site permissions
  (👤). Windows belong to one profile. **Guest windows** (Ctrl+Shift+N) keep nothing.
- **Site permissions**: when a site asks for your camera, microphone, location,
  notifications..., a bar asks you (this time / every visit / never). The padlock
  (🔒, or "Not secure" on http) shows the site's permissions and can clear its data.
- **Downloads** (Ctrl+J) go to your Downloads folder, with pause, resume, open
  and show in folder.
- **Find in page** (Ctrl+F), **zoom** (Ctrl+=, Ctrl+-, Ctrl+0, Ctrl+wheel),
  **print** (Ctrl+P) and **save as PDF**.
- **Right-click menus** on pages (links, images, text, spelling) and tabs, and
  the ⋮ menu. F12 opens DevTools for the page.
- Kite's own **error page** when a site can't be reached, and no way past an
  invalid security certificate.

### Kite's own pages (the app and Kite Web)

- **New tab page**: search box and shortcuts (your most visited sites, or your own).
- **History** (`kite://history`, Ctrl+H): by day, searchable, remove or clear.
- **Bookmarks**: the ☆ in the address bar or Ctrl+D, the bookmarks bar
  (Ctrl+Shift+B), and `kite://bookmarks` (Ctrl+Shift+O) to edit and reorder.
- **Settings** (`kite://settings`): search engine (Bing, Google, DuckDuckGo),
  home page and button, what opens at startup (including last time's tabs),
  bookmarks bar, keeping history.

The app keeps these per profile (`profile-data` in its folder; guest windows keep
nothing). Kite Web keeps them in your **Kite account** when you're signed in (so
they follow you to every device), otherwise in the browser you use it in.

### Syncing the app with your Kite account

1. In Kite Web, sign in, open the account panel (👤) and click **Link the Kite app**.
   It shows your Kite address and a one-time code (valid 10 minutes).
2. In the app: **Settings → Sync with a Kite account**, enter both, **Link**.

That profile's history, bookmarks, new tab shortcuts and settings then sync at
start, every 2 minutes and a few seconds after a change. If both sides changed,
history and bookmarks keep both sides' additions; for settings the newest wins.
Linked apps are listed in Kite Web's account panel, where you can unlink them.
The backend stores only a hash of each app's token.

Kite Web also has **find in page** (Ctrl+F), **zoom** and **print** now (done by
Kite's script inside the page), and a padlock showing the real site.

Where the app keeps things: `%APPDATA%\kite-desktop` on Windows (profiles.json,
permissions-*.json and the profiles' browser data).

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

**Frontend on Vercel:** import the repo, set **Root Directory** to `frontend`
(keep "Include files outside the Root Directory" on: the build reads `shared/`), add
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
2. Create your tunnel once (needs a domain on Cloudflare):

   ```bat
   cloudflared tunnel login
   cloudflared tunnel create kite
   cloudflared tunnel route dns kite kite-api.YOUR-DOMAIN.com
   ```

3. Edit the settings at the top of `start_home.bat` (`notepad start_home.bat`):
   `TUNNEL_NAME`, `TUNNEL_HOST` (e.g. `kite-api.YOUR-DOMAIN.com`) and `ALLOWED_ORIGINS`.
4. Double-click `start_home.bat`. It opens the backend, your tunnel and (with
   `START_FRONTEND=1`) the frontend at http://localhost:3000, then opens Kite.
   Check `https://kite-api.YOUR-DOMAIN.com/health` shows `ok`.

`start_home.bat` runs the tunnel with its own settings (`.kite-tunnel.yml`, git-ignored),
so other tunnels' shared `%USERPROFILE%\.cloudflared\config.yml` can't make Kite's
address answer 404. To use settings you wrote yourself, put them in
`%USERPROFILE%\.cloudflared\kite.yml`.

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
6. Scripts are rewritten as they pass through (Stage 5): `location` and `top` become
   `__kite$location` and `__kite$top`, which the injected script answers with the page's
   real address, so `location.pathname` is `/watch`, not `/proxy/...`. Only real code is
   touched (never strings, comments, regexes or object keys); the rewriter was checked
   against a full JavaScript parser on 745 real-world libraries (217 MB, no differences),
   and if a rewritten script ever fails to parse, the original is used.
7. Anything that still slips past is caught on the server using the Referer header.

## Roadmap

- [x] **Stage 1:** server-side fetch and HTML/CSS rewriting
- [x] **Stage 2:** injected script that intercepts `fetch`, XHR, `sendBeacon`, workers,
  element URLs, links, forms, `location`, `window.open` and history
- [x] **Stage 3:** WebSocket (`wss://`) relay at `/ws/` (`backend/websocket.js`)
- [x] **Stage 4:** cookies: one private cookie jar per person, kept on the backend
  (`backend/cookies.js`, `sessions.js`, `kite-api.js`), `document.cookie` in pages,
  and a cookie manager (the cookie button in the toolbar)
- [x] **Stage 5:** JavaScript rewriting (`backend/jsrewrite.js`): pages see their real
  address (`location`, `document.URL`, links' `.pathname`...) and the Kite tab looks like the
  top window, so single-page apps like YouTube route correctly
- [x] **Stage 6:** computed lookups (`window["loc" + "ation"]`) and `eval` are rewritten too,
  and Kite's replaced browser functions look like the browser's own
- [x] Kite accounts (password or Sign in with Google), cookie import
- [ ] **Stage 7:** Kite as a desktop app, with Kite Web working like it
  - [x] Part 1: one shared interface (`shared/`) with a platform layer
  - [x] Part 2: the app (Electron): real Chromium tabs
  - [x] Part 3: profiles, permissions, downloads, find, zoom, print, menus
  - [x] Part 4: history, bookmarks, new tab page, settings (app and Kite Web)
  - [x] Part 5: data in your Kite account; app sync; find/zoom/print in Kite Web
  - [ ] Part 6: Windows installer, auto-update, GitHub Actions, release

### Known limits of Kite Web

Most sites work, including live updates over WebSockets and staying signed in.
YouTube is the hardest: its anti-bot check (BotGuard) can tell it isn't really on
youtube.com, so videos may stop after about a minute, and in some browsers the
watch page crashes when shown inside a frame (it plays when opened on its own,
with the pop-out button). Some sign-in pages (notably Google's) refuse to work
inside any proxy. The **Kite app** has none of these limits: its tabs are real
browser pages. For finding problems: `KITE_MEDIA_LOG=1` (video requests),
`KITE_CLIENT_OFF=...` (switch parts of Kite's page script off) and
`frame-test.html` (a site in a plain frame); see `kite-secrets.example.bat`.
These switches can also be flipped live, without restarting, in Kite DevTools.

### Kite DevTools

`kite://devtools` (**Ctrl+Shift+K**, or Kite DevTools in the ⋮ menu) shows
what Kite is doing behind the scenes, in four tabs:

- **Requests**: every request with its real address, status, type, size, time
  and who answered. Filter by text or kind (pages, scripts, media, failed…),
  click one for all its details, pause, or copy them as JSON.
- **Log**: in Kite Web, the backend's log (`[kite 404]`, `[page error]`,
  `[video]`, `[PAGE CRASH]`...); in the app, pages' warnings and errors,
  crashes, pages that didn't load, permission questions, downloads and sync.
- **Status**: memory, caches and sessions (Kite Web); versions, memory,
  windows and tabs (the app).
- **Switches** (Kite Web only): Kite's page-script parts, script rewriting and
  the video log, changed live. Reload the tab you're testing afterwards.

In the app each window sees only its own profile's events, and F12 still opens
Chromium's developer tools for the page itself. In Kite Web, because the
backend's log includes everyone who browses through it, only Kite accounts
named in `KITE_DEVTOOLS_USERS` (in `kite-secrets.bat`) can open it. The backend serves it at
`/__kite/devtools/{check,events,status,settings,clear}`.

## Kite accounts and Sign in with Google

Anyone using your Kite can browse as a guest (their own separate cookie jar) or
sign in to a Kite account; signed in, their site logins follow them to every
device. Accounts are made with a username and password (stored only as scrypt
hashes) or with **Sign in with Google**. `KITE_SIGNUP=0` stops new accounts.

Sign in with Google only signs you in to *Kite*. It doesn't sign you in to
youtube.com inside Kite: Google gives those cookies only to its own sign-in page.
To use your YouTube login in Kite, import its cookies (🍪 → Import…).

To turn it on (once, free):

1. Go to <https://console.cloud.google.com/> and create a project (e.g. "Kite").
2. **APIs & Services → OAuth consent screen**: choose **External**, fill in the
   app name and your email. Under **Test users** add every Google account that
   may sign in (while the app is in "Testing", only those can).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   type **Web application**. Under **Authorized redirect URIs** add
   `https://kite-api.cat-code.org/__kite/google/callback` (your backend's address).
4. In your Project-Kite folder, make a file `kite-secrets.bat` (git ignores it;
   the client secret is a password, keep it out of GitHub) containing:

   ```bat
   set GOOGLE_CLIENT_ID=1234-abcd.apps.googleusercontent.com
   set GOOGLE_CLIENT_SECRET=GOCSPX-...
   rem optional: only these Google accounts may sign in
   set KITE_GOOGLE_ALLOWED=you@gmail.com
   ```
5. Restart Kite. The account panel (👤) now has **Sign in with Google**; allow
   pop-ups for your Kite page if the browser asks.

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
- In Kite Web every site is shown from the backend's one address, so sites share
  that address's browser storage (localStorage, IndexedDB): a site you visit through
  Kite Web could read what another one stored there. Cookies are kept per site on
  the backend and are safe from this. Use the Kite app (each site is its own
  origin) for anything sensitive.
- `.kite-cookies.json` on the backend holds everyone's site cookies and Kite
  account data (history, bookmarks; passwords only as scrypt hashes, sync tokens
  only as hashes). Keep it private; it's git-ignored and written owner-only.
