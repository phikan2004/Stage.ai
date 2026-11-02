import type { Input } from "./helper.ts";

/** One moment of a recording, in order. Frames are files in the recording's folder. */
export type Moment =
  | { t: number; kind: "frame"; file: string }
  | { t: number; kind: "click"; button: string; app: string; role?: string; name?: string; before?: string; after?: string }
  | { t: number; kind: "typed"; app: string; text: string }
  | { t: number; kind: "key"; app: string; combo: string }
  | { t: number; kind: "secure" }
  | { t: number; kind: "said"; text: string };

/** Keystrokes in a row become one piece of typed text, so the model reads "npm test" and not eight events. */
export function addKey(moments: Moment[], input: Extract<Input, { kind: "key" | "secure" }>): void {
  const last = moments.at(-1);
  if (input.kind === "secure") {
    if (last?.kind !== "secure") moments.push({ t: input.t, kind: "secure" });
    return;
  }
  if (input.combo === "backspace" && last?.kind === "typed") {
    last.text = last.text.slice(0, -1);
    if (!last.text) moments.pop();
    return;
  }
  if (input.combo) return void moments.push({ t: input.t, kind: "key", app: input.app, combo: input.combo });
  if (!input.text) return;
  if (last?.kind === "typed" && last.app === input.app) last.text += input.text;
  else moments.push({ t: input.t, kind: "typed", app: input.app, text: input.text });
}

/** False when the presenter never touched the stage display, so only their voice was recorded. */
export const presenterActed = (moments: Moment[]) => moments.some((m) => m.kind === "click" || m.kind === "typed" || m.kind === "key");

/** Frames worth sending: every one tied to a click, then periodic ones spread evenly, up to `max`. */
export function pickFrames(moments: Moment[], max: number): Set<string> {
  const keep = new Set<string>();
  for (const m of moments) {
    if (m.kind !== "click") continue;
    for (const f of [m.before, m.after]) if (f) keep.add(f);
  }
  if (keep.size > max) {
    const all = [...keep];
    return new Set(all.filter((_, i) => i % Math.ceil(all.length / max) === 0));
  }
  const rest = moments.flatMap((m) => (m.kind === "frame" && !keep.has(m.file) ? [m.file] : []));
  const room = max - keep.size;
  const step = rest.length / Math.max(room, 1);
  for (let i = 0; i < Math.min(room, rest.length); i++) keep.add(rest[Math.floor(i * step)]);
  return keep;
}

/** The recording as the model reads it. Frames not in `frames` are left out. */
export function describeMoment(m: Moment, startedAt: number): string | null {
  const at = `[${((m.t - startedAt) / 1000).toFixed(1)}s]`;
  switch (m.kind) {
    case "frame":
      return null;
    case "click":
      return `${at} ${m.button} click in ${m.app}${m.role || m.name ? ` on ${m.role ?? "element"} ${JSON.stringify(m.name ?? "")}` : ""}`;
    case "typed":
      return `${at} typed in ${m.app}: ${JSON.stringify(m.text)}`;
    case "key":
      return `${at} pressed ${m.combo} in ${m.app}`;
    case "secure":
      return `${at} typed into a password field (not captured)`;
    case "said":
      return `${at} presenter said: ${JSON.stringify(m.text)}`;
  }
}
