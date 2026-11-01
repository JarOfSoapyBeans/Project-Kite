// Site permissions, like Chrome's: a site asks (camera, microphone, location,
// notifications...), Kite shows "Allow / Block" under the toolbar, and your
// answer can be remembered for that site (per profile).
const path = require("node:path");
const { JsonStore } = require("./store.js");

// Always fine, never asked about.
const ALWAYS = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock"]);
// Asked about. Everything else is refused.
const ASKED = {
  media: "use your camera and microphone",
  geolocation: "know your location",
  notifications: "show notifications",
  midi: "use your MIDI devices",
  midiSysex: "control your MIDI devices",
  "clipboard-read": "see text and images you copy",
  "idle-detection": "know when you're using this device",
  "window-management": "manage windows on your displays",
  "storage-access": "use cookies and site data while embedded",
  "top-level-storage-access": "use cookies and site data while embedded",
  "speaker-selection": "choose your speakers",
};

function describe(permission, details = {}) {
  if (permission === "media") {
    const t = details.mediaTypes || [];
    if (t.includes("video") && t.includes("audio")) return "use your camera and microphone";
    if (t.includes("video")) return "use your camera";
    if (t.includes("audio")) return "use your microphone";
  }
  return ASKED[permission] || null;
}

// The decision key: camera and microphone are remembered separately.
function keysFor(permission, details = {}) {
  if (permission !== "media") return [permission];
  const t = details.mediaTypes || [];
  const keys = [];
  if (t.includes("video")) keys.push("camera");
  if (t.includes("audio")) keys.push("microphone");
  return keys.length ? keys : ["camera", "microphone"];
}

function originOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

class SitePermissions {
  constructor(dir, profileId) {
    this.store = new JsonStore(dir ? path.join(dir, `permissions-${profileId}.json`) : null, { sites: {} });
  }

  // "allow", "block" or undefined (ask) for every key.
  decision(origin, keys) {
    const site = this.store.data.sites[origin] || {};
    const values = keys.map((k) => site[k]);
    if (values.every((v) => v === "allow")) return "allow";
    if (values.some((v) => v === "block")) return "block";
    return undefined;
  }

  set(origin, keys, value) {
    const site = (this.store.data.sites[origin] ||= {});
    for (const k of keys) site[k] = value;
    this.store.changed();
  }

  forSite(origin) {
    return { ...(this.store.data.sites[origin] || {}) };
  }

  reset(origin) {
    delete this.store.data.sites[origin];
    this.store.changed();
  }
}

// Hook a profile's session up. ask({ webContents, origin, permission, keys, text })
// returns a promise of { allow, remember }.
function attachPermissions(ses, perms, ask) {
  ses.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    if (ALWAYS.has(permission)) return callback(true);
    const text = describe(permission, details);
    const origin = originOf(details.requestingUrl || (webContents && webContents.getURL()));
    if (!text || !origin) return callback(false);
    const keys = keysFor(permission, details);
    const known = perms.decision(origin, keys);
    if (known) return callback(known === "allow");
    Promise.resolve(ask({ webContents, origin, permission, keys, text }))
      .then((answer) => {
        const allow = Boolean(answer && answer.allow);
        if (answer && answer.remember) perms.set(origin, keys, allow ? "allow" : "block");
        callback(allow);
      })
      .catch(() => callback(false));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details = {}) => {
    if (ALWAYS.has(permission)) return true;
    const origin = originOf(requestingOrigin);
    if (!origin) return false;
    const keys = permission === "media" ? keysFor("media", { mediaTypes: details.mediaType ? [details.mediaType] : [] }) : [permission];
    return perms.decision(origin, keys) === "allow";
  });
}

module.exports = { SitePermissions, attachPermissions, describe, keysFor, originOf, ALWAYS };
