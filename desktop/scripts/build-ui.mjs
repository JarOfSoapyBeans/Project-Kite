// Assembles the Kite app's interface into desktop/app-ui from the shared one:
//   shared/ui/*                  -> app-ui/
//   shared/lib/*                 -> app-ui/lib/
//   shared/platform/desktop.js   -> app-ui/platform/ (tabs are real browser views)
//   desktop/pages/*              -> app-ui/          (the app's own pages: error.html)
// The app shows it at kite://app/ (see main.js).
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shared = join(here, "..", "..", "shared");
const out = join(here, "..", "app-ui");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "platform"), { recursive: true });
cpSync(join(shared, "ui"), out, { recursive: true });
cpSync(join(shared, "lib"), join(out, "lib"), { recursive: true });
cpSync(join(shared, "platform", "desktop.js"), join(out, "platform", "desktop.js"));
cpSync(join(here, "..", "pages"), out, { recursive: true }); // app-only pages (error.html)
writeFileSync(join(out, "platform", "index.js"), 'export { default } from "./desktop.js";\n');
writeFileSync(join(out, "config.js"), "window.APP_CONFIG = { app: true };\n");
console.log("[build] Kite app interface built in desktop/app-ui");
