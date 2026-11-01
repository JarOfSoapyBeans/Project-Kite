// Kite Search: robots.txt, the file where sites say what crawlers may read.
// Kite's crawler is "KiteBot"; rules for KiteBot win over rules for everyone (*).
// The longest matching rule wins; Allow wins a tie; * and $ work as in Google's.

export const BOT_NAME = "KiteBot";

export function parseRobots(text, bot = BOT_NAME) {
  const groups = []; // { agents: [], rules: [{ allow, path }], delay }
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(text || "").split(/\r?\n/).slice(0, 5000)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [], delay: null }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      if (key === "disallow" && !value) continue; // "Disallow:" = everything allowed
      current.rules.push({ allow: key === "allow", path: value });
    } else if (key === "crawl-delay") {
      const d = Number(value);
      if (Number.isFinite(d) && d >= 0) current.delay = Math.min(d, 60);
    }
  }
  const me = bot.toLowerCase();
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && me.includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules);
  const delay = chosen.map((g) => g.delay).find((d) => d !== null) ?? null;
  return { rules, delay };
}

function toRegex(pattern) {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern).replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + body + (anchored ? "$" : ""));
}

// May the crawler read this address? (path + query, e.g. "/a/b?c=1")
export function allowed(robots, pathAndQuery) {
  if (!robots || !robots.rules.length) return true;
  let best = null;
  for (const r of robots.rules) {
    if (!toRegex(r.path).test(pathAndQuery)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}
