import { z } from "zod";
import { BoxSchema, clampBox, MAX_BEAT_CUES, MAX_LESSONS, normalizeRegions, RegionSchema, SlideFactsSchema, type Beat, type Box, type Cue, type Region, type RunEvent, type Slide } from "./schema.ts";

/*
 * Robot rehearsal: a scripted presenter talks through a deck or demo, Stage reacts as it would live, and the
 * presenter's feedback in a chat becomes edits to the cues. These are the shapes both ends share, and the pure
 * functions that apply the edits, so the server, the browser and the tests all agree on them.
 */

/** Same cap as learning from runs, so neither can grow a region's phrases past it. */
export const MAX_REGION_PHRASES = 12;
/** Chat turns sent back with each message, oldest dropped first. */
export const MAX_HISTORY = 10;

const Line = z.string().trim().min(1).max(400);

/** What the robot says on each slide, numbered from 1 like the presenter sees them. */
export const DeckScriptSchema = z.object({
  slides: z.array(z.object({ slide: z.number().int().min(1), lines: z.array(Line).max(8) })),
});
export type DeckScript = z.infer<typeof DeckScriptSchema>;

/** What the robot says leading into each beat of a demo. */
export const ShowScriptSchema = z.object({
  beats: z.array(z.object({ beatId: z.string().min(1), lines: z.array(Line).max(6) })),
});
export type ShowScript = z.infer<typeof ShowScriptSchema>;

/** How the robot sounds. Rate and pitch are the browser's: 1 is normal. */
export const RobotVoiceSchema = z.object({
  rate: z.number().min(0.5).max(2),
  pitch: z.number().min(0).max(2),
  /** a voice installed in the browser, or null for the default */
  voice: z.string().max(200).nullable(),
});
export type RobotVoice = z.infer<typeof RobotVoiceSchema>;
export const DEFAULT_VOICE: RobotVoice = { rate: 1, pitch: 1, voice: null };
export const RATE_RANGE = [0.6, 1.6] as const;
export const PITCH_RANGE = [0.5, 1.5] as const;

const clamp = (n: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, n));
const round = (n: number) => Math.round(n * 100) / 100;

/** A voice change from the coach, kept within range, to a voice this browser actually has. */
export function applyVoice(current: RobotVoice, change: Partial<RobotVoice> | null | undefined, voices: string[]): RobotVoice {
  if (!change) return current;
  return {
    rate: change.rate != null && Number.isFinite(change.rate) ? round(clamp(change.rate, RATE_RANGE)) : current.rate,
    pitch: change.pitch != null && Number.isFinite(change.pitch) ? round(clamp(change.pitch, PITCH_RANGE)) : current.pitch,
    voice: change.voice && voices.includes(change.voice) ? change.voice : current.voice,
  };
}

/** One line for the chat on what changed in the voice, or null if nothing did. */
export function describeVoiceChange(before: RobotVoice, after: RobotVoice): string | null {
  const parts: string[] = [];
  if (after.rate !== before.rate) parts.push(`speed ${before.rate}× → ${after.rate}×`);
  if (after.pitch !== before.pitch) parts.push(`pitch ${before.pitch} → ${after.pitch}`);
  if (after.voice !== before.voice) parts.push(`voice ${after.voice ?? "default"}`);
  return parts.length ? `Robot's voice: ${parts.join(", ")}` : null;
}

/** What the coach knows about the voice: how it sounds now, and which voices it may switch to. */
const VoiceContext = {
  voice: RobotVoiceSchema.default(DEFAULT_VOICE),
  voices: z.array(z.string().max(200)).max(80).default([]),
};

export const ChatTurnSchema = z.object({ role: z.enum(["presenter", "coach"]), text: z.string().max(4000) });
export type ChatTurn = z.infer<typeof ChatTurnSchema>;

/* ---------- decks ---------- */

/** Speaker notes, by slide index from 0, for PowerPoint decks; the server doesn't keep them. */
export const DeckScriptRequestSchema = z.object({
  notes: z.array(z.string().max(4000)).max(300).optional(),
});

export const DeckFeedbackRequestSchema = z.object({
  feedback: z.string().trim().min(1).max(2000),
  history: z.array(ChatTurnSchema).max(MAX_HISTORY).default([]),
  /** the rehearsal so far */
  events: z.array(z.any()).max(5000).default([]),
  /** the slide on screen when they wrote, from 0 */
  slide: z.number().int().min(0),
  script: DeckScriptSchema,
  ...VoiceContext,
});
export type DeckFeedbackRequest = z.infer<typeof DeckFeedbackRequestSchema>;

export type DeckChange =
  | { op: "addPhrases" | "removePhrases" | "setKeywords"; slide: number; regionId: string; items: string[] }
  | { op: "setCue"; slide: number; regionId: string; cue: Cue }
  | { op: "removeRegion"; slide: number; regionId: string }
  | { op: "setScript"; slide: number; items: string[] }
  /* the cue chat in the editor, which sees the slide, can also draw, move, rename and reorder cues */
  | { op: "addRegion"; slide: number; label: string; cue: Cue; box: Box; description: string; keywords: string[]; phrases: string[] }
  | { op: "setBox"; slide: number; regionId: string; box: Box }
  | { op: "setLabel"; slide: number; regionId: string; text: string }
  | { op: "setOrder"; slide: number; items: string[] };

/** The cue chat in the deck editor: one message about the slide on screen, which Claude sees. */
export const CueChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  history: z.array(ChatTurnSchema).max(MAX_HISTORY).default([]),
  /** on screen, from 0 */
  slide: z.number().int().min(0),
  image: z.string().startsWith("data:image/").max(4_000_000),
  /** what a PowerPoint file says about the slide: notes and exact text boxes */
  facts: SlideFactsSchema.optional(),
  /** the slide's cues as the editor has them, which may be newer than the saved ones */
  regions: z.array(RegionSchema).max(40),
});
export type CueChatRequest = z.infer<typeof CueChatRequestSchema>;

export interface CueChatReply {
  reply: string;
  changes: DeckChange[];
}

/** Highlight cues whose box or cue type is new, so their marker lines must be worked out again. */
export function staleHighlights(before: Slide[], after: Slide[]): { slide: number; regionId: string }[] {
  return after.flatMap((s) =>
    s.regions.flatMap((r) => {
      if (r.cue !== "highlight") return [];
      const old = before.find((b) => b.index === s.index)?.regions.find((x) => x.id === r.id);
      const same = old && old.cue === "highlight" && JSON.stringify(old.box) === JSON.stringify(r.box);
      return same ? [] : [{ slide: s.index, regionId: r.id }];
    }),
  );
}

const validBox = (b: Box) => BoxSchema.safeParse(b).success && b.w > 0.01 && b.h > 0.01 && b.x >= 0 && b.y >= 0 && b.x < 1 && b.y < 1;

export interface DeckFeedbackReply {
  reply: string;
  changes: DeckChange[];
  /** slide to start again from, from 1 */
  rerunFrom: number;
  /** a change to how the robot sounds, if they asked for one */
  voice: Partial<RobotVoice> | null;
}

const clean = (items: string[], max = 400) => items.map((s) => s.trim()).filter((s) => s.length > 0 && s.length <= max);
const lower = (s: string) => s.toLowerCase();

/**
 * Applies the edits to the slides (indexes from 0; changes number slides from 1). Changes to slides or regions that
 * don't exist are skipped, so a confused answer can't damage the deck.
 */
export function applyDeckChanges(slides: Slide[], script: DeckScript, changes: DeckChange[]): { slides: Slide[]; script: DeckScript; applied: DeckChange[] } {
  let out = slides;
  let outScript = script;
  const applied: DeckChange[] = [];
  // Reordering goes last, so it can place cues added in the same answer.
  const ordered = [...changes.filter((c) => c.op !== "setOrder"), ...changes.filter((c) => c.op === "setOrder")];
  for (const c of ordered) {
    const index = c.slide - 1;
    if (c.op === "setScript") {
      const lines = clean(c.items).slice(0, 8);
      if (!lines.length || index < 0 || index >= slides.length) continue;
      const rest = outScript.slides.filter((s) => s.slide !== c.slide);
      outScript = { slides: [...rest, { slide: c.slide, lines }].sort((a, b) => a.slide - b.slide) };
      applied.push(c);
      continue;
    }
    const slide = out.find((s) => s.index === index);
    if (!slide) continue;
    if (c.op === "addRegion") {
      const label = c.label.trim().slice(0, 200);
      if (!label || !validBox(c.box)) continue;
      const fresh: Region = {
        id: label,
        label,
        description: c.description.trim(),
        keywords: clean(c.keywords, 80).slice(0, 12),
        phrases: clean(c.phrases, 120).slice(0, MAX_REGION_PHRASES),
        cue: c.cue,
        box: clampBox(c.box),
      };
      out = out.map((s) => (s === slide ? { ...s, regions: normalizeRegions([...s.regions, fresh]) } : s));
      applied.push(c);
      continue;
    }
    if (c.op === "setOrder") {
      const at = (id: string) => {
        const i = c.items.indexOf(id);
        return i < 0 ? Infinity : i;
      };
      if (!c.items.some((id) => slide.regions.some((r) => r.id === id))) continue;
      const regions = [...slide.regions].sort((a, b) => at(a.id) - at(b.id));
      out = out.map((s) => (s === slide ? { ...s, regions } : s));
      applied.push(c);
      continue;
    }
    const region = slide.regions.find((r) => r.id === c.regionId);
    if (!region) continue;
    let regions = slide.regions;
    if (c.op === "setBox" && !validBox(c.box)) continue;
    if (c.op === "setLabel" && !c.text.trim()) continue;
    if (c.op === "removeRegion") {
      regions = regions.filter((r) => r.id !== c.regionId);
    } else {
      regions = regions.map((r) => {
        if (r.id !== c.regionId) return r;
        if (c.op === "setCue") return { ...r, cue: c.cue };
        if (c.op === "setBox") return { ...r, box: clampBox(c.box) };
        if (c.op === "setLabel") return { ...r, label: c.text.trim().slice(0, 200) };
        if (c.op === "setKeywords") {
          const keywords = clean(c.items, 80).slice(0, 12);
          return keywords.length ? { ...r, keywords } : r;
        }
        if (c.op === "addPhrases") {
          const known = new Set((r.phrases ?? []).map(lower));
          const add = clean(c.items, 120).filter((p) => !known.has(lower(p)));
          return { ...r, phrases: [...(r.phrases ?? []), ...add].slice(0, MAX_REGION_PHRASES) };
        }
        const drop = new Set(c.items.map((s) => lower(s.trim())));
        return { ...r, phrases: (r.phrases ?? []).filter((p) => !drop.has(lower(p))), keywords: r.keywords.filter((k) => !drop.has(lower(k))) };
      });
    }
    out = out.map((s) => (s === slide ? { ...s, regions } : s));
    applied.push(c);
  }
  return { slides: out, script: outScript, applied };
}

/** The rehearsal as readable lines: per slide, what the robot said and which cues fired, with times. */
export function describeDeckRun(events: RunEvent[], regionLabel: (slide: number, regionId: string) => string | undefined): string {
  const out: string[] = [];
  const secs = (t: number) => `${(t / 1000).toFixed(1)}s`;
  let said: string[] = [];
  const flush = () => {
    if (said.length) out.push(`  robot said: "${said.join(" ").slice(-600)}"`);
    said = [];
  };
  for (const e of events) {
    if (e.type === "heard") {
      said.push(e.text);
      continue;
    }
    flush();
    if (e.type === "slide") out.push(`${secs(e.t)} slide ${e.slide + 1}`);
    else if (e.type === "zoom") out.push(`${secs(e.t)}   cue fired: ${regionLabel(e.slide, e.regionId) ?? e.label} [${e.regionId}] (${e.cue ?? "zoom"})${e.latencyMs != null ? `, ${e.latencyMs} ms after the last words` : ""}`);
  }
  flush();
  return out.join("\n").slice(-12000);
}

/* ---------- demos ---------- */

export const ShowFeedbackRequestSchema = z.object({
  feedback: z.string().trim().min(1).max(2000),
  history: z.array(ChatTurnSchema).max(MAX_HISTORY).default([]),
  /** what happened in the rehearsal so far, one line each */
  log: z.array(z.string().max(1000)).max(400).default([]),
  script: ShowScriptSchema,
  ...VoiceContext,
});
export type ShowFeedbackRequest = z.infer<typeof ShowFeedbackRequestSchema>;

/** Demo edits. There is deliberately no way to change the show's limits: they are the operator's safety rails. */
export type ShowChange =
  | { op: "addCues" | "removeCues" | "setScript"; beatId: string; items: string[] }
  | { op: "setNotes" | "setGoal" | "setSuccess" | "addLesson"; beatId: string; text: string };

export interface ShowFeedbackReply {
  reply: string;
  changes: ShowChange[];
  voice: Partial<RobotVoice> | null;
}

export function applyShowChanges(beats: Beat[], script: ShowScript, changes: ShowChange[]): { beats: Beat[]; script: ShowScript; applied: ShowChange[] } {
  let out = beats;
  let outScript = script;
  const applied: ShowChange[] = [];
  for (const c of changes) {
    if (!out.some((b) => b.id === c.beatId)) continue;
    if (c.op === "setScript") {
      const lines = clean(c.items).slice(0, 6);
      if (!lines.length) continue;
      const order = beats.map((b) => b.id);
      const rest = outScript.beats.filter((b) => b.beatId !== c.beatId);
      outScript = { beats: [...rest, { beatId: c.beatId, lines }].sort((a, b) => order.indexOf(a.beatId) - order.indexOf(b.beatId)) };
      applied.push(c);
      continue;
    }
    let ok = true;
    out = out.map((b) => {
      if (b.id !== c.beatId) return b;
      switch (c.op) {
        case "addCues": {
          const known = new Set(b.cues.map(lower));
          const add = clean(c.items, 120).filter((x) => !known.has(lower(x)));
          ok = add.length > 0;
          return { ...b, cues: [...b.cues, ...add].slice(0, MAX_BEAT_CUES) };
        }
        case "removeCues": {
          const drop = new Set(c.items.map((s) => lower(s.trim())));
          return { ...b, cues: b.cues.filter((x) => !drop.has(lower(x))) };
        }
        case "setNotes":
          return { ...b, notes: c.text.trim() };
        case "setGoal":
          ok = c.text.trim().length > 0;
          return ok ? { ...b, goal: c.text.trim() } : b;
        case "setSuccess":
          return { ...b, success: c.text.trim() };
        case "addLesson":
          ok = c.text.trim().length > 0;
          return ok ? { ...b, lessons: [...(b.lessons ?? []), c.text.trim()].slice(-MAX_LESSONS) } : b;
        default:
          ok = false;
          return b;
      }
    });
    if (ok) applied.push(c);
  }
  return { beats: out, script: outScript, applied };
}

/** One line per change, for the chat. */
export function describeChange(c: DeckChange | ShowChange, name: (c: DeckChange | ShowChange) => string): string {
  const items = "items" in c ? c.items.map((s) => `"${s}"`).join(", ") : "";
  switch (c.op) {
    case "addPhrases":
      return `${name(c)}: listens for ${items}`;
    case "removePhrases":
      return `${name(c)}: stops listening for ${items}`;
    case "setKeywords":
      return `${name(c)}: keywords are now ${items}`;
    case "setCue":
      return `${name(c)}: cue changed to ${c.cue}`;
    case "removeRegion":
      return `${name(c)}: removed`;
    case "setScript":
      return `${name(c)}: robot's lines rewritten`;
    case "addRegion":
      return `${name(c)}: new ${c.cue} cue "${c.label}"`;
    case "setBox":
      return `${name(c)}: moved or resized`;
    case "setLabel":
      return `${name(c)}: renamed "${c.text}"`;
    case "setOrder":
      return `${name(c)}: cues put in a new order`;
    case "addCues":
      return `${name(c)}: trigger words ${items} added`;
    case "removeCues":
      return `${name(c)}: trigger words ${items} removed`;
    case "setNotes":
      return `${name(c)}: notes for the AI updated`;
    case "setGoal":
      return `${name(c)}: goal rewritten`;
    case "setSuccess":
      return `${name(c)}: "done when" rewritten`;
    case "addLesson":
      return `${name(c)}: lesson added`;
  }
}
