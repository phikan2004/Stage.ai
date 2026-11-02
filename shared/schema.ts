import { z } from "zod";
import type { TokenUsage } from "./plans.ts";

/** Fractions of slide width/height, 0..1, origin top-left. */
export const BoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export type Box = z.infer<typeof BoxSchema>;

/** How a region is emphasized while presenting. Regions with no cue are from before planning, and zoom. */
export const CueSchema = z.enum(["outline", "spotlight", "zoom", "highlight", "callout", "arrow", "reveal"]);
export type Cue = z.infer<typeof CueSchema>;

export const RegionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
  keywords: z.array(z.string().min(1)),
  box: BoxSchema,
  cue: CueSchema.optional(),
  /** things a presenter would say when reaching this point; hearing one counts as strong evidence */
  phrases: z.array(z.string().min(1)).optional(),
  /** where a Highlight cue draws: each line of text in the box */
  marks: z.array(BoxSchema).optional(),
});
export type Region = z.infer<typeof RegionSchema>;

/** What a PowerPoint file states outright, so it costs nothing to know. PDFs and scans have none of this. */
export const SlideFactsSchema = z.object({
  notes: z.string().max(4000),
  shapes: z.array(z.object({ text: z.string().max(400), box: BoxSchema })).max(40),
});
export type SlideFacts = z.infer<typeof SlideFactsSchema>;

/** A slide is guided when its regions came from the director: they run in order and need real evidence to fire. */
export const isGuided = (regions: Region[]) => regions.some((r) => r.cue !== undefined);

/** What the whole-deck director pass decides for one slide. An empty `emphasis` means the slide gets no cues. */
export const SlidePlanSchema = z.object({
  index: z.number().int().min(0),
  purpose: z.string(),
  density: z.enum(["clean", "busy"]),
  /** in the order a presenter would naturally reach them */
  emphasis: z
    .array(z.object({ target: z.string().min(1), cue: CueSchema, why: z.string() }))
    .max(5),
});
export type SlidePlan = z.infer<typeof SlidePlanSchema>;

export const DeckPlanSchema = z.object({
  summary: z.string(),
  slides: z.array(SlidePlanSchema),
});
export type DeckPlan = z.infer<typeof DeckPlanSchema>;

/** What gets worked out behind the scenes for a region the presenter drew. */
export const RegionDetailsSchema = z.object({
  description: z.string(),
  keywords: z.array(z.string().min(1)).min(3).max(12),
  phrases: z.array(z.string().min(1)).min(2).max(8),
});
export type RegionDetails = z.infer<typeof RegionDetailsSchema>;

/** What the vision model must return for one slide. */
export const AnalysisSchema = z.object({
  regions: z
    .array(
      RegionSchema.extend({
        keywords: z.array(z.string().min(1)).min(3).max(12),
      }),
    )
    .min(1)
    .max(10),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

/** The same, for a slide the director planned: exactly the planned regions, with spoken phrases. */
export const GuidedAnalysisSchema = z.object({
  regions: z
    .array(
      RegionSchema.extend({
        keywords: z.array(z.string().min(1)).min(3).max(12),
        phrases: z.array(z.string().min(1)).min(2).max(8),
        cue: CueSchema,
      }),
    )
    .max(5),
});

export const SlideSchema = z.object({
  index: z.number().int().min(0),
  regions: z.array(RegionSchema),
});
export type Slide = z.infer<typeof SlideSchema>;

export const PRODUCER_FILE_VERSION = 1;

export const ProducerFileSchema = z.object({
  version: z.literal(PRODUCER_FILE_VERSION),
  pdfName: z.string(),
  pdfHash: z.string(),
  slides: z.array(SlideSchema),
});
export type ProducerFile = z.infer<typeof ProducerFileSchema>;

const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

/** Clamp a box so it lies fully inside the slide and has a minimum size. */
export function clampBox(b: Box, minSize = 0.02): Box {
  const x = clamp01(b.x);
  const y = clamp01(b.y);
  const w = Math.max(minSize, Math.min(clamp01(b.w), 1 - x));
  const h = Math.max(minSize, Math.min(clamp01(b.h), 1 - y));
  return { x: Math.min(x, 1 - w), y: Math.min(y, 1 - h), w, h };
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "region"
  );
}

/** Clamp boxes, slugify ids and make them unique within a slide. */
export function normalizeRegions(regions: Region[]): Region[] {
  const seen = new Set<string>();
  return regions.map((r) => {
    const base = slugify(r.id || r.label);
    let id = base;
    for (let i = 2; seen.has(id); i++) id = `${base}-${i}`;
    seen.add(id);
    return {
      ...r,
      id,
      keywords: [...new Set(r.keywords.map((k) => k.trim()).filter(Boolean))],
      ...(r.phrases ? { phrases: [...new Set(r.phrases.map((p) => p.trim()).filter(Boolean))] } : {}),
      box: clampBox(r.box),
    };
  });
}

/* ---------- library: matters, decks, runs ---------- */

const Id = z.string().min(1).max(64);

/** A matter groups the presentations (decks) for one project, plus their run history. */
/** Whether a matter holds a single presentation or several. */
export const DeckModeSchema = z.enum(["single", "multiple"]);
export type DeckMode = z.infer<typeof DeckModeSchema>;

export const MatterSchema = z.object({
  id: Id,
  name: z.string().trim().min(1).max(200),
  deckMode: DeckModeSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Matter = z.infer<typeof MatterSchema>;

export const DeckRecordSchema = z.object({
  id: Id,
  matterId: Id,
  name: z.string(),
  pdfHash: z.string(),
  slideCount: z.number().int().min(0),
  slides: z.array(SlideSchema),
  /** analysis finished (or was skipped); opening the deck goes straight to review */
  analyzed: z.boolean(),
  /** the director's plan, when the deck has been through it */
  plan: DeckPlanSchema.nullable().optional(),
  hasThumb: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type DeckRecord = z.infer<typeof DeckRecordSchema>;

export const DeckFormatSchema = z.enum(["pdf", "pptx"]);
export type DeckFormat = z.infer<typeof DeckFormatSchema>;

/** Asks where to send a new deck's file. */
export const DeckUploadRequestSchema = z.object({ format: DeckFormatSchema });

/** Registers a file that has already been uploaded to the url from `POST /matters/:id/decks/upload`. */
export const DeckCreateSchema = z.object({
  deckId: Id,
  name: z.string().trim().min(1).max(200),
  format: DeckFormatSchema,
  /** SHA-256 of the deck's file; the name predates PowerPoint support */
  pdfHash: z.string().regex(/^[0-9a-f]{64}$/),
  slideCount: z.number().int().min(1),
});
export type DeckCreate = z.infer<typeof DeckCreateSchema>;

/** Where the browser PUTs a new deck's file. */
export interface DeckUpload {
  deckId: string;
  url: string;
}

export const DeckPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  slides: z.array(SlideSchema).optional(),
  analyzed: z.boolean().optional(),
  plan: DeckPlanSchema.optional(),
});
/** Slide images for the director pass: small enough that a whole deck fits in one request. */
export const DeckPlanRequestSchema = z.object({
  images: z.array(z.string().startsWith("data:image/")).min(1).max(150),
  /** one entry per image, when the deck is a PowerPoint */
  facts: z.array(SlideFactsSchema).optional(),
});

export type DeckPatch = z.infer<typeof DeckPatchSchema>;

/** One thing that happened while presenting. `t` is ms since the run started. */
export const RunEventSchema = z.discriminatedUnion("type", [
  z.object({ t: z.number(), type: z.literal("slide"), slide: z.number().int() }),
  z.object({ t: z.number(), type: z.literal("zoom"), slide: z.number().int(), regionId: z.string(), label: z.string(), cue: CueSchema.optional() }),
  z.object({ t: z.number(), type: z.literal("command"), slide: z.number().int(), command: z.string(), text: z.string() }),
  z.object({ t: z.number(), type: z.literal("heard"), slide: z.number().int(), text: z.string(), simulated: z.boolean().optional() }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;

export const MAX_RUN_EVENTS = 5000;

export const RunInputSchema = z.object({
  deckId: Id,
  startedAt: z.number(),
  endedAt: z.number(),
  engine: z.string().nullable(),
  events: z.array(RunEventSchema).max(MAX_RUN_EVENTS),
});
export type RunInput = z.infer<typeof RunInputSchema>;

export interface RunStats {
  durationMs: number;
  slidesVisited: number;
  zooms: number;
  commands: number;
  words: number;
}

export interface Run extends RunInput {
  id: string;
  matterId: string;
  /** snapshot, so the run still reads well if the deck is renamed */
  deckName: string;
  slideCount: number;
  stats: RunStats;
}

export function summarizeRun(r: Pick<RunInput, "events" | "startedAt" | "endedAt">): RunStats {
  const slides = new Set<number>();
  let zooms = 0;
  let commands = 0;
  let words = 0;
  for (const e of r.events) {
    if (e.type === "slide") slides.add(e.slide);
    else if (e.type === "zoom") zooms++;
    else if (e.type === "command") commands++;
    else if (e.type === "heard") words += e.text.split(/\s+/).filter(Boolean).length;
  }
  return { durationMs: Math.max(0, r.endedAt - r.startedAt), slidesVisited: slides.size, zooms, commands, words };
}

/* ---------- stage: shows ---------- */

/** One thing the presenter says and one thing that happens on screen. An understanding, not a list of clicks. */
export const BeatSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(200),
  /** what the operator is trying to achieve */
  goal: z.string().trim().min(1),
  /** what the screen looks like when it's done */
  success: z.string(),
  /** the presenter's own words for this moment */
  cues: z.array(z.string().min(1)),
  /** reference screenshots, by file name in the recording. They stay on the presenter's Mac. */
  landmarks: z.array(z.string()),
  /** corrections from dry runs */
  notes: z.string(),
});
export type Beat = z.infer<typeof BeatSchema>;

/** What the operator may touch in this show. */
export const ShowLimitsSchema = z.object({
  apps: z.array(z.string().min(1)),
  origins: z.array(z.string().min(1)),
  /** terminal commands seen in the recording; anything else needs approval */
  commands: z.array(z.string().min(1)),
});
export type ShowLimits = z.infer<typeof ShowLimitsSchema>;

export const BEAT_OUTCOMES = ["done", "stuck", "stopped", "failed"] as const;

export const BeatResultSchema = z.object({
  beatId: z.string(),
  outcome: z.enum(BEAT_OUTCOMES),
  summary: z.string(),
  ms: z.number(),
  cueToActionMs: z.number().nullable(),
});
export type BeatResult = z.infer<typeof BeatResultSchema>;

export const DryRunSchema = z.object({ at: z.number(), results: z.array(BeatResultSchema) });
export type DryRun = z.infer<typeof DryRunSchema>;

/** Dry runs kept per show, newest last. Enough to score each beat. */
export const MAX_DRY_RUNS = 20;

/** A demo the operator has been taught. */
export const ShowSchema = z.object({
  id: Id,
  matterId: Id,
  name: z.string().trim().min(1).max(200),
  beats: z.array(BeatSchema),
  limits: ShowLimitsSchema,
  /** the local recording the beats were learned from */
  recordingId: z.string().nullable(),
  dryRuns: z.array(DryRunSchema).max(MAX_DRY_RUNS),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Show = z.infer<typeof ShowSchema>;

export const ShowPatchSchema = ShowSchema.pick({ name: true, beats: true, limits: true, recordingId: true, dryRuns: true }).partial();
export type ShowPatch = z.infer<typeof ShowPatchSchema>;

/** Passed dry runs out of all that reached this beat. */
export function beatScore(dryRuns: DryRun[], beatId: string): { passed: number; total: number } {
  const results = dryRuns.flatMap((r) => r.results.filter((b) => b.beatId === beatId && b.outcome !== "stopped"));
  return { passed: results.filter((b) => b.outcome === "done").length, total: results.length };
}

/* API response shapes */
export type RunSummary = Omit<Run, "events"> & { matterName: string };
export type DeckSummary = Omit<DeckRecord, "slides"> & { regionCount: number; runCount: number; lastRunAt: number | null };
export type MatterSummary = Matter & {
  deckCount: number;
  runCount: number;
  lastRunAt: number | null;
  /** most recently touched deck with a thumbnail, for the card image */
  thumbDeckId: string | null;
};
export interface HomeData {
  matters: MatterSummary[];
  runs: RunSummary[];
}
export interface MatterDetail {
  matter: Matter;
  decks: DeckSummary[];
  runs: RunSummary[];
}
export type DeckDetail = DeckRecord & { matterName: string };
export type RunDetail = Run & { matterName: string; deckExists: boolean };

/** One billed Claude call during analysis: the whole-deck plan, a slide, or one region the presenter drew. */
export interface UsageEntry extends TokenUsage {
  deckId: string | null;
  kind: "plan" | "slide" | "region";
  slideIndex: number | null;
  model: string;
  effort: string;
  costUsd: number | null;
  durationMs: number;
}

/** Totals for a deck. `costUsd` leaves out calls to models with no known price. */
export interface UsageSummary extends TokenUsage {
  calls: number;
  costUsd: number;
}
