import type { Frame } from "./driver.ts";

/** What this show's agent may touch. */
export interface Limits {
  /** app names or bundle ids */
  apps: string[];
  /** web origins, e.g. http://localhost:5173 */
  origins: string[];
  /** terminal commands the presenter has already shown it; anything else is refused during a demo */
  taughtCommands: string[];
  /** risky buttons the presenter pressed while teaching, or added in review */
  taughtActions: string[];
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

/** apple.com and www.apple.com are one site to a presenter, so the allowlist treats them as one. */
const site = (origin: string) => origin.replace(/^(https?:\/\/)www\./, "$1");

/** A bare address like apple.com is a website, not an app. */
export const openTarget = (target: string) => (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(target) && !/\.app$/i.test(target) ? `https://${target}` : target);

export function originAllowed(limits: Limits, url: string): boolean {
  try {
    const { protocol, origin } = new URL(url);
    return protocol === "about:" || protocol === "data:" || limits.origins.some((o) => site(o) === site(origin));
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

export const actionTaught = (limits: Limits, name: string) => limits.taughtActions.some((a) => a.trim().toLowerCase() === name.trim().toLowerCase());

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

/** The presenter's own Stage page, by its window title. */
export const isConsole = (title?: string) => /^Stage\b/.test(title ?? "");

/** The Stage page sitting on the display the AI works on: it changes as the AI runs, and the AI would see and could touch it. */
export const consoleOnStage = (front: { title?: string; frame?: Frame }, stage: Bounds) =>
  !!front.frame && isConsole(front.title) && insideBounds(stage, front.frame.x + front.frame.width / 2, front.frame.y + front.frame.height / 2);

/* ---------- local connection ---------- */

/** Only the Stage console may connect: a random website can't, because browsers always send its real Origin. */
export function connectionAllowed(origin: string | undefined, token: string | null, expected: { origins: string[]; token: string }): boolean {
  return pairAllowed(origin, expected.origins) && token === expected.token;
}

/**
 * The console pairs itself by asking for the token. Only the Stage console's own origin gets it:
 * a website can't fake its Origin, and anything on this Mac that could fake one can already read the token file.
 */
export function pairAllowed(origin: string | undefined, origins: string[]): boolean {
  return !!origin && origins.includes(origin);
}
