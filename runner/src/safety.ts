import type { Frame } from "./driver.ts";

/** What this show's agent may touch. */
export interface Limits {
  /** app names or bundle ids */
  apps: string[];
  /** web origins, e.g. http://localhost:5173 */
  origins: string[];
  /** terminal commands the presenter has already shown it; anything else needs approval */
  taughtCommands: string[];
}

export const TERMINALS = new Set([
  "com.apple.Terminal",
  "com.googlecode.iterm2",
  "dev.warp.Warp-Stable",
  "net.kovidgoyal.kitty",
  "com.github.wez.wezterm",
  "org.alacritty",
  "com.mitchellh.ghostty",
]);

/** Never operated, whatever a show's limits say: these reach your AI sessions, your settings and your passwords. */
const NEVER_APPS = new Set(["claude", "com.anthropic.claudefordesktop", "system settings", "com.apple.systempreferences", "keychain access", "com.apple.keychainaccess", "passwords", "com.apple.passwords"]);

export function appAllowed(limits: Limits, app: string, bundleId: string): boolean {
  if (NEVER_APPS.has(app.toLowerCase()) || NEVER_APPS.has(bundleId.toLowerCase())) return false;
  return limits.apps.some((a) => a.toLowerCase() === app.toLowerCase() || a === bundleId);
}

export function originAllowed(limits: Limits, url: string): boolean {
  try {
    const { protocol, origin } = new URL(url);
    return protocol === "about:" || protocol === "data:" || limits.origins.includes(origin);
  } catch {
    return false;
  }
}

/** Shortcuts that reach outside the app in front: launchers, app and space switchers, logging out. */
const ESCAPES = ["cmd+space", "cmd+tab", "cmd+shift+tab", "cmd+alt+escape", "cmd+shift+q", "cmd+alt+shift+q", "cmd+ctrl+q", "ctrl+up", "ctrl+down", "ctrl+left", "ctrl+right", "ctrl+space"];
const ALIASES: Record<string, string> = { command: "cmd", super: "cmd", meta: "cmd", win: "cmd", control: "ctrl", option: "alt", opt: "alt", esc: "escape" };
const ORDER = ["cmd", "ctrl", "alt", "shift"];

export function normalizeCombo(combo: string): string {
  const parts = combo
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .map((p) => ALIASES[p] ?? p);
  const mods = ORDER.filter((m) => parts.includes(m));
  return [...mods, ...parts.filter((p) => !ORDER.includes(p))].join("+");
}

export const keyBlocked = (combo: string) => ESCAPES.includes(normalizeCombo(combo));

const RISKY = /\b(delete|remove|erase|destroy|send|publish|post|pay|purchase|buy|checkout|confirm|transfer|deploy|merge|sign out|log out)\b/i;

export const riskyName = (name: string) => RISKY.test(name);

/** A terminal command runs without asking only if the presenter already taught it. */
export function commandTaught(limits: Limits, text: string): boolean {
  const cmd = text.trim();
  return limits.taughtCommands.some((t) => t.trim() === cmd);
}

/* ---------- display fence ---------- */

/** A display's rectangle in global screen points. */
export type Bounds = Frame;

export function insideBounds(b: Bounds, x: number, y: number): boolean {
  return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
}

/** Screenshot pixels → global screen points. Throws for anything outside the stage display. */
export function toScreen(b: Bounds, shotW: number, shotH: number, x: number, y: number): { x: number; y: number } {
  if (!(x >= 0 && y >= 0 && x < shotW && y < shotH)) throw new Error(`(${x}, ${y}) is outside the stage display`);
  return { x: b.x + (x / shotW) * b.width, y: b.y + (y / shotH) * b.height };
}

/* ---------- local connection ---------- */

/** Only the Stage console may connect: a random website can't, because browsers always send its real Origin. */
export function connectionAllowed(origin: string | undefined, token: string | null, expected: { origins: string[]; token: string }): boolean {
  return !!origin && expected.origins.includes(origin) && token === expected.token;
}
