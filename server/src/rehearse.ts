import { z } from "zod";
import type { Effort } from "../../shared/plans.ts";
import {
  describeDeckRun,
  type ChatTurn,
  type DeckChange,
  type DeckFeedbackReply,
  type DeckFeedbackRequest,
  type DeckScript,
  type RobotVoice,
  type ShowChange,
  type ShowFeedbackReply,
  type ShowFeedbackRequest,
  type ShowScript,
} from "../../shared/rehearse.ts";
import { CueSchema, RunEventSchema, type DeckRecord, type Show } from "../../shared/schema.ts";
import { callModel, requireKey, withRetry, type UsageSink } from "./analyze.ts";
import { CUE_GUIDE } from "./prompt.ts";

/*
 * Robot rehearsal: Claude writes what a presenter would say, and turns the presenter's feedback on the rehearsal into
 * edits. The edits come back to the browser, which applies them with the shared functions in shared/rehearse.ts and
 * saves them the usual way, so nothing here races the page's own autosave.
 */

const SCRIPT_EFFORT: Effort = "low";
const FEEDBACK_EFFORT: Effort = "medium";
/** Keeps a very long deck's description inside one request. */
const MAX_DECK_TEXT = 60_000;

/** How the coach changes the robot's speed, pitch and voice. Shared by decks and demos. */
const VOICE_COACHING = `How the robot sounds: it speaks with the browser's built-in voice. Its current speed, pitch and voice are given below, with the voices it can switch to. When the presenter asks it to go slower or faster, sound different, or use another voice, set voice.change to true and give the full new settings:
- rate: 1 is normal speed, from 0.6 to 1.6. "A bit slower" is about 0.1 less, "much faster" about 0.3 more.
- pitch: 1 is normal, from 0.5 to 1.5.
- voice: exactly one of the listed voice names, or "" to keep the current one. For a style such as "British", "a woman's voice" or "deeper", choose from what the names suggest (language and region codes, well-known voice names). A calmer or deeper style can also lower pitch and rate a little; a more energetic one can raise them a little.
Style that lives in the words, such as more energy, less jargon or a more formal tone, is a script change: rewrite the robot's lines with setScript.
If the voice should stay as it is, set voice.change to false and copy the current settings.`;

const VOICE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["change", "rate", "pitch", "voice"],
  properties: { change: { type: "boolean" }, rate: { type: "number" }, pitch: { type: "number" }, voice: { type: "string" } },
} as const;
const RawVoice = z.object({ change: z.boolean(), rate: z.number(), pitch: z.number(), voice: z.string() });
const toVoice = (v: z.infer<typeof RawVoice>) => (v.change ? { rate: v.rate, pitch: v.pitch, voice: v.voice || null } : null);

const describeVoice = (voice: RobotVoice, voices: string[]) =>
  `The robot's voice now: speed ${voice.rate}, pitch ${voice.pitch}, voice ${voice.voice ? `"${voice.voice}"` : "the browser's default"}.
Voices it can switch to: ${voices.length ? voices.map((v) => `"${v}"`).join(", ") : "(none listed: leave voice empty)"}`;

const VOICE_RULES = `- Each line is one spoken sentence of 6 to 25 words, the way a confident presenter talks to a client.
- No stage directions, markdown, quotes, bullet characters or emoji: only the words to speak.`;

/* ---------- decks ---------- */

const DECK_SCRIPT_PROMPT = `You write a talk track for a robot that rehearses a presentation out loud, so the presenter can watch how Stage reacts. Stage listens to the presenter and, on each slide, fires cues (zoom, spotlight, highlight and so on) on regions of the slide when the presenter starts talking about them.

Write what a real, well-prepared presenter would say on each slide:
- 1 to 5 lines per slide.
- Reach the slide's regions in the order listed, one or two lines each. Make clear which one you're on the way a person would, by naming the section, the number or the point, but mostly paraphrase rather than reading the region's trigger phrases word for word. About one line in three may stay close to a trigger phrase; the rest should be natural rewordings. This tests whether Stage follows real speech.
- If a slide has speaker notes, follow them: they are what the presenter plans to say.
- A slide with no regions gets one or two lines on its point.
- Never say navigation words such as "next slide", "go back", "zoom out", "previous slide" or "go to slide": the robot moves slides itself.
${VOICE_RULES}

Return every slide, numbered from 1.`;

const DECK_FEEDBACK_PROMPT = `You coach a rehearsal for Stage, a presentation tool that listens to the presenter and fires cues on regions of each slide. A robot just rehearsed the deck out loud from a script, the presenter watched, and now they've written feedback. Turn the feedback into specific edits to the deck, then reply briefly.

How cues fire: each region has keywords and phrases. When recent speech matches one region clearly better than the others on the slide, its cue fires. So:
- A cue that fired late or never: add phrases a presenter says at that moment, taken from what the robot said there in the log where they fit.
- A cue that fired early or on the wrong region: remove the generic keywords or phrases that matched too soon (check what was said just before it fired) and add more distinctive ones.
- The wrong kind of emphasis: setCue.
- A cue that shouldn't be there at all: removeRegion.
- The robot said something a real presenter wouldn't, or the presenter wants it to talk differently: setScript with the slide's new lines.

Cue types. When the presenter asks for a different cue, or asks you to suggest cue types for a slide or for the deck, choose for each region from these, keeping the lightest one that works, and use setCue only where the cue should change:
${CUE_GUIDE}
When you're suggesting rather than following an exact instruction, say in the reply which cue you picked for what and why, in a few words each.

Ops and their fields:
- addPhrases, removePhrases, setKeywords: slide, regionId, items (phrases of 3 to 7 words; keywords of 1 to 3 words)
- setCue: slide, regionId, cue
- removeRegion: slide, regionId
- setScript: slide, items (the slide's new lines, each one spoken sentence)
Fill the fields an op doesn't use with an empty string, an empty list or cue "none". Use only region ids that exist on that slide. Slides are numbered from 1. "This slide" or "that cue" means the slide that was on screen when they wrote, given below.

If edits can't fix it, make no changes and say what to do instead: new regions are drawn on the slide in the editor, and how fast cues fire overall is set in the presenter's debug panel (press D while presenting).

${VOICE_COACHING}

reply: 1 to 3 short, plain sentences on what you changed and why. Don't mention ids or op names.
rerunFrom: the first slide your changes affect, or the slide on screen if you changed nothing or only the voice.`;

const DECK_SCRIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["slides"],
  properties: {
    slides: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slide", "lines"],
        properties: { slide: { type: "integer" }, lines: { type: "array", items: { type: "string" } } },
      },
    },
  },
} as const;

const DECK_OPS = ["addPhrases", "removePhrases", "setKeywords", "setCue", "removeRegion", "setScript"] as const;

const DECK_FEEDBACK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "rerunFrom", "changes", "voice"],
  properties: {
    reply: { type: "string" },
    rerunFrom: { type: "integer" },
    voice: VOICE_SCHEMA,
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op", "slide", "regionId", "items", "cue"],
        properties: {
          op: { type: "string", enum: DECK_OPS },
          slide: { type: "integer" },
          regionId: { type: "string" },
          items: { type: "array", items: { type: "string" } },
          cue: { type: "string", enum: [...CueSchema.options, "none"] },
        },
      },
    },
  },
} as const;

const RawDeckScript = z.object({ slides: z.array(z.object({ slide: z.number().int(), lines: z.array(z.string()) })) });
const RawDeckFeedback = z.object({
  reply: z.string(),
  voice: RawVoice,
  rerunFrom: z.number().int(),
  changes: z.array(
    z.object({ op: z.enum(DECK_OPS), slide: z.number().int(), regionId: z.string(), items: z.array(z.string()), cue: z.string() }),
  ),
});

const cleanLines = (lines: string[], max: number) =>
  lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.slice(0, 400))
    .slice(0, max);

/** The deck as text: each slide's purpose, notes and regions in order. */
export function describeDeck(deck: DeckRecord, notes?: string[]): string {
  const parts: string[] = [];
  if (deck.plan?.summary) parts.push(`The deck: ${deck.plan.summary}`);
  for (let i = 0; i < deck.slideCount; i++) {
    const slide = deck.slides.find((s) => s.index === i);
    const purpose = deck.plan?.slides.find((s) => s.index === i)?.purpose;
    const lines = [`Slide ${i + 1}${purpose ? `: ${purpose}` : ""}`];
    const note = notes?.[i]?.trim();
    if (note) lines.push(`  Speaker notes: ${note.slice(0, 1500)}`);
    for (const r of slide?.regions ?? []) {
      lines.push(
        `  - [${r.id}] "${r.label}" (${r.cue ?? "zoom"}): ${r.description}. Keywords: ${r.keywords.join(", ")}.${r.phrases?.length ? ` Trigger phrases: ${r.phrases.map((p) => `"${p}"`).join(", ")}.` : ""}`,
      );
    }
    if (!slide?.regions.length) lines.push("  (no regions)");
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n").slice(0, MAX_DECK_TEXT);
}

export const history = (turns: ChatTurn[]) =>
  turns.length ? `Earlier in this chat:\n${turns.map((t) => `${t.role === "presenter" ? "Presenter" : "You"}: ${t.text}`).join("\n")}\n\n` : "";

export async function deckScript(deck: DeckRecord, notes: string[] | undefined, onUsage: UsageSink): Promise<DeckScript> {
  requireKey();
  return withRetry("script", async (retryError) => {
    const raw = RawDeckScript.parse(
      await callModel({
        system: DECK_SCRIPT_PROMPT,
        schema: DECK_SCRIPT_SCHEMA,
        content: [{ type: "text", text: retryError ? `${describeDeck(deck, notes)}\n\nYour previous answer was invalid: ${retryError}` : describeDeck(deck, notes) }],
        effort: SCRIPT_EFFORT,
        maxTokens: 24000,
        usage: (u) => onUsage({ ...u, kind: "rehearse", slideIndex: null }),
      }),
    );
    const slides = Array.from({ length: deck.slideCount }, (_, i) => ({
      slide: i + 1,
      lines: cleanLines(raw.slides.find((s) => s.slide === i + 1)?.lines ?? [], 8),
    }));
    if (!slides.some((s) => s.lines.length)) throw new Error("the script has no lines");
    return { slides };
  });
}

export async function deckFeedback(deck: DeckRecord, req: DeckFeedbackRequest, onUsage: UsageSink): Promise<DeckFeedbackReply> {
  requireKey();
  const events = req.events.flatMap((e) => {
    const parsed = RunEventSchema.safeParse(e);
    return parsed.success ? [parsed.data] : [];
  });
  const label = (slide: number, id: string) => deck.slides.find((s) => s.index === slide)?.regions.find((r) => r.id === id)?.label;
  const script = req.script.slides.map((s) => `Slide ${s.slide}:\n${s.lines.map((l) => `  ${l}`).join("\n")}`).join("\n");
  const text = [
    describeDeck(deck),
    `The robot's script:\n${script}`.slice(0, 20_000),
    `What happened in the rehearsal (seconds from the start):\n${describeDeckRun(events, label) || "(nothing yet)"}`,
    describeVoice(req.voice, req.voices),
    `${history(req.history)}On screen when they wrote: slide ${req.slide + 1}.\nThe presenter's feedback: ${req.feedback}`,
  ].join("\n\n");
  return withRetry("feedback", async (retryError) => {
    const raw = RawDeckFeedback.parse(
      await callModel({
        system: DECK_FEEDBACK_PROMPT,
        schema: DECK_FEEDBACK_SCHEMA,
        content: [{ type: "text", text: retryError ? `${text}\n\nYour previous answer was invalid: ${retryError}` : text }],
        effort: FEEDBACK_EFFORT,
        maxTokens: 8000,
        usage: (u) => onUsage({ ...u, kind: "rehearse", slideIndex: req.slide }),
      }),
    );
    const changes = raw.changes.flatMap((c): DeckChange[] => {
      if (c.op === "setScript") return [{ op: c.op, slide: c.slide, items: c.items }];
      if (c.op === "removeRegion") return [{ op: c.op, slide: c.slide, regionId: c.regionId }];
      if (c.op === "setCue") {
        const cue = CueSchema.safeParse(c.cue);
        return cue.success ? [{ op: c.op, slide: c.slide, regionId: c.regionId, cue: cue.data }] : [];
      }
      return [{ op: c.op, slide: c.slide, regionId: c.regionId, items: c.items }];
    });
    const rerunFrom = Math.min(Math.max(1, raw.rerunFrom), Math.max(1, deck.slideCount));
    return { reply: raw.reply.trim(), changes, rerunFrom, voice: toVoice(raw.voice) };
  });
}

/* ---------- demos ---------- */

const SHOW_SCRIPT_PROMPT = `You write a talk track for a robot that rehearses a live software demo out loud, so the presenter can watch how the AI operator keeps up. The operator performs each beat of the demo on screen. The first beat starts when the presenter says something matching its trigger words. After that, each beat starts once the one before it is done and the presenter finishes a thought.

For each beat, write what the presenter says leading into it: what they're about to show and why it matters to the client.
- 1 to 3 lines per beat.
- Paraphrase the trigger words naturally. The first beat's lines must clearly include the gist of one of its trigger phrases, or the demo never starts.
- Never use these words, which are voice commands: hold on, hang on, wait, stop, pause, not yet, go ahead, carry on, keep going, continue, go on, next, ready, resume.
${VOICE_RULES}

Return every beat, numbered from 1.`;

const SHOW_FEEDBACK_PROMPT = `You coach a rehearsal of a live software demo. An AI operator performs each beat on screen while the presenter talks. A robot just rehearsed the demo out loud from a script, the presenter watched, and now they've written feedback. Turn it into specific edits to the demo, then reply briefly.

Each beat has a goal, a "done when" check, trigger words that tell the operator the presenter has reached it, the presenter's notes for the AI, and lessons from earlier runs. The first beat starts on its trigger words; later beats start once the previous one is done and the presenter finishes a thought.

Ops and their fields:
- addCues, removeCues: beat, items (trigger phrases of 2 to 6 words, distinctive to that moment)
- setNotes: beat, text. This replaces the beat's notes for the AI, so keep what's already there and add to it unless the presenter says otherwise.
- setGoal, setSuccess: beat, text
- addLesson: beat, text (one line)
- setScript: beat, items (the robot's new lines before that beat, each one spoken sentence)
Fill the fields an op doesn't use with an empty string or an empty list. Beats are numbered from 1.

You can't change which apps, websites, terminal commands or risky buttons the operator may use. If the feedback needs that, make no change for it and tell the presenter to edit Limits on the demo page.

${VOICE_COACHING}

reply: 1 to 3 short, plain sentences on what you changed and why. Don't mention op names.`;

const SHOW_SCRIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["beats"],
  properties: {
    beats: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["beat", "lines"],
        properties: { beat: { type: "integer" }, lines: { type: "array", items: { type: "string" } } },
      },
    },
  },
} as const;

const SHOW_OPS = ["addCues", "removeCues", "setNotes", "setGoal", "setSuccess", "addLesson", "setScript"] as const;

const SHOW_FEEDBACK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "changes", "voice"],
  properties: {
    reply: { type: "string" },
    voice: VOICE_SCHEMA,
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op", "beat", "items", "text"],
        properties: {
          op: { type: "string", enum: SHOW_OPS },
          beat: { type: "integer" },
          items: { type: "array", items: { type: "string" } },
          text: { type: "string" },
        },
      },
    },
  },
} as const;

const RawShowScript = z.object({ beats: z.array(z.object({ beat: z.number().int(), lines: z.array(z.string()) })) });
const RawShowFeedback = z.object({
  reply: z.string(),
  voice: RawVoice,
  changes: z.array(z.object({ op: z.enum(SHOW_OPS), beat: z.number().int(), items: z.array(z.string()), text: z.string() })),
});

function describeShow(show: Show): string {
  const beats = show.beats.map((b, i) =>
    [
      `Beat ${i + 1}: ${b.label}`,
      `  Goal: ${b.goal}`,
      `  Done when: ${b.success}`,
      `  Trigger words: ${b.cues.map((c) => `"${c}"`).join(", ") || "(none)"}`,
      b.notes && `  Notes for the AI: ${b.notes}`,
      b.lessons?.length && `  Lessons: ${b.lessons.join(" ")}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return `The demo is "${show.name}".\n\n${beats.join("\n\n")}`;
}

export async function showScript(show: Show, onUsage: UsageSink): Promise<ShowScript> {
  requireKey();
  return withRetry("script", async (retryError) => {
    const raw = RawShowScript.parse(
      await callModel({
        system: SHOW_SCRIPT_PROMPT,
        schema: SHOW_SCRIPT_SCHEMA,
        content: [{ type: "text", text: retryError ? `${describeShow(show)}\n\nYour previous answer was invalid: ${retryError}` : describeShow(show) }],
        effort: SCRIPT_EFFORT,
        maxTokens: 8000,
        usage: (u) => onUsage({ ...u, kind: "rehearse", slideIndex: null }),
      }),
    );
    const beats = show.beats.map((b, i) => ({ beatId: b.id, lines: cleanLines(raw.beats.find((x) => x.beat === i + 1)?.lines ?? [], 6) }));
    if (!beats[0]?.lines.length) throw new Error("the first beat has no lines");
    return { beats };
  });
}

export async function showFeedback(show: Show, req: ShowFeedbackRequest, onUsage: UsageSink): Promise<ShowFeedbackReply> {
  requireKey();
  const index = new Map(show.beats.map((b, i) => [b.id, i + 1]));
  const script = req.script.beats.map((b) => `Before beat ${index.get(b.beatId) ?? "?"}:\n${b.lines.map((l) => `  ${l}`).join("\n")}`).join("\n");
  const text = [
    describeShow(show),
    `The robot's script:\n${script}`,
    `What happened in the rehearsal:\n${req.log.join("\n").slice(-12_000) || "(nothing yet)"}`,
    describeVoice(req.voice, req.voices),
    `${history(req.history)}The presenter's feedback: ${req.feedback}`,
  ].join("\n\n");
  return withRetry("feedback", async (retryError) => {
    const raw = RawShowFeedback.parse(
      await callModel({
        system: SHOW_FEEDBACK_PROMPT,
        schema: SHOW_FEEDBACK_SCHEMA,
        content: [{ type: "text", text: retryError ? `${text}\n\nYour previous answer was invalid: ${retryError}` : text }],
        effort: FEEDBACK_EFFORT,
        maxTokens: 8000,
        usage: (u) => onUsage({ ...u, kind: "rehearse", slideIndex: null }),
      }),
    );
    const changes = raw.changes.flatMap((c): ShowChange[] => {
      const beatId = show.beats[c.beat - 1]?.id;
      if (!beatId) return [];
      if (c.op === "addCues" || c.op === "removeCues" || c.op === "setScript") return [{ op: c.op, beatId, items: c.items }];
      return [{ op: c.op, beatId, text: c.text }];
    });
    return { reply: raw.reply.trim(), changes, voice: toVoice(raw.voice) };
  });
}
