// The interface's copy of your browsing data (history, bookmarks, shortcuts,
// settings, last session), loaded once and saved through the platform:
//   the Kite app   your profile's folder (guest windows: memory only)
//   Kite Web       this browser (localStorage), or your Kite account (part 5)
// Other windows of the same profile can change it too; the platform tells us.

import { withDefaults } from "./lib/data.js";

export const NAMES = ["history", "bookmarks", "shortcuts", "settings", "session"];

export async function openStore(platform) {
  const values = {};
  await Promise.all(
    NAMES.map(async (name) => {
      try {
        values[name] = await platform.loadData(name);
      } catch {
        values[name] = null;
      }
    })
  );
  values.history ||= [];
  values.bookmarks ||= [];
  values.shortcuts ||= [];
  values.session ||= [];
  values.settings = withDefaults(values.settings);

  const listeners = new Set();
  const timers = {};
  const store = {
    get: (name) => values[name],
    // Replace one kind of data; saved a moment later, in one go.
    set(name, value) {
      values[name] = name === "settings" ? withDefaults(value) : value;
      clearTimeout(timers[name]);
      timers[name] = setTimeout(() => platform.saveData(name, values[name]), name === "history" ? 1500 : 200);
      for (const fn of listeners) fn(name);
    },
    update: (name, fn) => store.set(name, fn(values[name])),
    onChange: (fn) => listeners.add(fn),
  };
  if (platform.onDataChanged) {
    platform.onDataChanged((name, value) => {
      if (!NAMES.includes(name)) return;
      values[name] = name === "settings" ? withDefaults(value) : value || [];
      for (const fn of listeners) fn(name);
    });
  }
  return store;
}
