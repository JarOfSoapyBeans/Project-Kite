// Kite Web's own panels: Kite accounts (sign in, Google), the site cookie jar
// on the backend (list, clear, import), and the backend's address. The Kite app
// doesn't need these: it has real browser profiles instead.

export function initWebPanels({ backend, reloadAll, resetBackend, accountChanged = () => {} }) {
  // ---------- cookies (Stage 4) ----------
  // Sites' cookies live in a jar on the Kite backend. This panel lists them and
  // lets you clear them; it talks to the backend directly (not through a tab).

  const cookiePanel = document.getElementById("cookie-panel");
  const cookieList = document.getElementById("cookie-list");

  async function cookieApi(path, form) {
    const r = await fetch(backend() + "/__kite/" + path, {
      method: form ? "POST" : "GET",
      credentials: "include",
      headers: form ? { "content-type": "application/x-www-form-urlencoded" } : undefined,
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    if (!r.ok) throw new Error(`backend answered ${r.status}`);
    return (await r.json()).sites;
  }

  function renderCookies(sites) {
    cookieList.textContent = "";
    const entries = Object.entries(sites).sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
      const li = document.createElement("li");
      li.textContent = "No cookies yet.";
      cookieList.append(li);
      return;
    }
    for (const [site, count] of entries) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "site";
      name.textContent = site;
      const n = document.createElement("span");
      n.className = "count";
      n.textContent = `${count} cookie${count === 1 ? "" : "s"}`;
      const clear = document.createElement("button");
      clear.type = "button";
      clear.textContent = "Clear";
      clear.addEventListener("click", () => updateCookies("cookies/clear", { site }));
      li.append(name, n, clear);
      cookieList.append(li);
    }
  }

  async function updateCookies(path = "cookies", form) {
    try {
      renderCookies(await cookieApi(path, form));
    } catch (err) {
      cookieList.textContent = `Couldn't load cookies: ${err.message}`;
    }
  }

  document.getElementById("cookies").addEventListener("click", () => {
    cookiePanel.hidden = !cookiePanel.hidden;
    if (!cookiePanel.hidden) updateCookies();
  });
  // ---------- Kite accounts ----------
  // Signing in to Kite gives this browser your account's cookie jar (your site
  // logins), the same on every device. Guests each get their own separate jar.

  const accountPanel = document.getElementById("account-panel");
  const accountBtn = document.getElementById("account");
  const accountMsg = document.getElementById("account-message");
  let currentUser = null;

  async function accountApi(path, body) {
    const r = await fetch(backend() + "/__kite/account" + path, {
      method: body ? "POST" : "GET",
      credentials: "include",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `backend answered ${r.status}`);
    return data;
  }

  function showAccount(user, signupOn = true, googleOn = undefined) {
    if (googleOn !== undefined) document.getElementById("account-google").hidden = !googleOn;
    if (user !== currentUser) accountChanged(user); // history, bookmarks... come from the account now
    currentUser = user;
    accountBtn.classList.toggle("signed-in", Boolean(user));
    accountBtn.title = user ? `Signed in as ${user}` : "Kite account (guest)";
    document.getElementById("account-guest").hidden = Boolean(user);
    document.getElementById("account-user-view").hidden = !user;
    document.getElementById("account-name").textContent = user || "";
    document.getElementById("account-signup").hidden = !signupOn;
  }

  // Pages in open tabs were loaded with the old account's cookies.
  function reloadTabs() {
    reloadAll();
    if (!cookiePanel.hidden) updateCookies();
  }

  async function accountAction(path, body) {
    accountMsg.textContent = "...";
    try {
      const data = await accountApi(path, body);
      accountMsg.textContent = "";
      document.getElementById("account-pass").value = "";
      showAccount(data.user);
      try { localStorage.setItem("kite-account-seen", "1"); } catch {}
      accountPanel.hidden = true;
      reloadTabs();
    } catch (err) {
      accountMsg.textContent = err.message;
    }
  }

  accountBtn.addEventListener("click", () => {
    accountPanel.hidden = !accountPanel.hidden;
    if (!accountPanel.hidden) document.getElementById(currentUser ? "account-signout" : "account-user").focus();
  });
  document.getElementById("account-form").addEventListener("submit", (e) => {
    e.preventDefault();
    accountAction("/signin", { username: document.getElementById("account-user").value, password: document.getElementById("account-pass").value });
  });
  document.getElementById("account-signup").addEventListener("click", () => {
    const username = document.getElementById("account-user").value;
    const password = document.getElementById("account-pass").value;
    if (!username || !password) return (accountMsg.textContent = "Pick a username and a password (8+ characters), then click Create account.");
    accountAction("/signup", { username, password });
  });
  // Sign in with Google: Google opens in a popup; this page then collects the
  // result with a secret only it knows (so it lands in this page's Kite session).
  document.getElementById("account-google").addEventListener("click", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const claim = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const start = `${backend()}/__kite/google/start?claim=${claim}&origin=${encodeURIComponent(location.origin)}`;
    const popup = window.open(start, "kite-google", "width=500,height=680");
    if (!popup) return (accountMsg.textContent = "Allow pop-ups for Kite, then try again.");
    accountMsg.textContent = "Finish signing in with Google in the pop-up window...";
    const began = Date.now();
    let closedAt = 0;
    const poll = async () => {
      try {
        const r = await fetch(backend() + "/__kite/account/google", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ claim }),
        });
        const data = await r.json().catch(() => ({}));
        if (r.status === 200) {
          accountMsg.textContent = "";
          showAccount(data.user);
          try { localStorage.setItem("kite-account-seen", "1"); } catch {}
          accountPanel.hidden = true;
          reloadTabs();
          return;
        }
        if (r.status !== 202) return (accountMsg.textContent = data.error || `backend answered ${r.status}`);
      } catch {}
      // A window Google showed can look "closed" to this page, so keep trying a
      // little after that, and give up after 10 minutes.
      let closed = false;
      try { closed = popup.closed; } catch {}
      if (closed && !closedAt) closedAt = Date.now();
      if ((closedAt && Date.now() - closedAt > 8000) || Date.now() - began > 10 * 60 * 1000) {
        accountMsg.textContent = "Google sign-in didn't finish.";
        return;
      }
      setTimeout(poll, 1000);
    };
    setTimeout(poll, 1000);
  });
  document.getElementById("account-guest-go").addEventListener("click", () => {
    try { localStorage.setItem("kite-account-seen", "1"); } catch {}
    accountPanel.hidden = true;
  });
  document.getElementById("account-signout").addEventListener("click", () => accountAction("/signout", {}));
  document.getElementById("account-signout-all").addEventListener("click", () => {
    if (confirm("Sign out of your Kite account on every device?")) accountAction("/signout-everywhere", {});
  });

  // Linking the Kite app to this account (a one-time code), and the linked apps.
  async function renderLinkedApps() {
    const ul = document.getElementById("linked-apps");
    ul.textContent = "";
    if (!currentUser) return;
    let list = [];
    try {
      list = (await accountApi("/../sync/devices")).devices || [];
    } catch {}
    for (const d of list) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = `${d.device} — linked ${new Date(d.created).toLocaleDateString()}` + (d.lastUsed ? `, last synced ${new Date(d.lastUsed).toLocaleString()}` : "");
      const unlink = document.createElement("button");
      unlink.type = "button";
      unlink.textContent = "Unlink";
      unlink.addEventListener("click", async () => {
        await accountApi("/../sync/unlink", { id: d.id }).catch(() => {});
        renderLinkedApps();
      });
      li.append(label, unlink);
      ul.append(li);
    }
  }
  document.getElementById("link-app").addEventListener("click", async () => {
    const box = document.getElementById("link-app-box");
    try {
      const { code, expires } = await accountApi("/../sync/link-code", {});
      document.getElementById("link-backend").textContent = backend();
      document.getElementById("link-code").textContent = code;
      document.getElementById("link-expiry").textContent = `works once, until ${new Date(expires).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
      box.hidden = false;
    } catch (err) {
      accountMsg.textContent = err.message;
    }
  });
  accountBtn.addEventListener("click", () => !accountPanel.hidden && renderLinkedApps());

  async function loadAccount() {
    try {
      const data = await accountApi("");
      showAccount(data.user, data.signup, data.google);
      let seen = false;
      try { seen = localStorage.getItem("kite-account-seen") === "1"; } catch {}
      if (!data.user && !seen) accountPanel.hidden = false; // first visit: sign in or continue as guest
    } catch {}
  }
  loadAccount();

  // Import cookies exported from your normal browser (to be signed in inside Kite).
  const importBox = document.getElementById("cookie-import");
  const importText = document.getElementById("cookie-import-text");
  const importResult = document.getElementById("cookie-import-result");
  document.getElementById("cookies-import-open").addEventListener("click", () => {
    importBox.hidden = !importBox.hidden;
  });
  document.getElementById("cookie-import-file").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importText.value = await file.text();
  });
  document.getElementById("cookie-import-go").addEventListener("click", async () => {
    const text = importText.value.trim();
    if (!text) return (importResult.textContent = "Paste cookies or choose a file first.");
    importResult.textContent = "Importing...";
    try {
      const r = await fetch(backend() + "/__kite/cookies/import", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "text/plain" },
        body: text,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `backend answered ${r.status}`);
      importText.value = ""; // don't leave sign-in cookies lying around on screen
      importResult.textContent = `Imported ${data.imported} of ${data.found} cookies. Reload the site's tab to use them.`;
      renderCookies(data.sites);
    } catch (err) {
      importResult.textContent = `Couldn't import: ${err.message}`;
    }
  });
  document.getElementById("cookies-clear-all").addEventListener("click", () => {
    if (confirm("Clear all cookies? You'll be signed out of every site.")) updateCookies("cookies/clear", { site: "" });
  });

  // ---------- backend address ----------
  document.getElementById("settings").addEventListener("click", () => {
    const next = prompt("Kite backend URL (https://host):", backend());
    if (next === null) return;
    try {
      if (next.trim()) localStorage.setItem("backendUrl", next.trim());
      else localStorage.removeItem("backendUrl");
    } catch {}
    resetBackend();
  });
}
