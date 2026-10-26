import { z } from "zod";

/** Fractions of slide width/height, 0..1, origin top-left. */
export const BoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export type Box = z.infer<typeof BoxSchema>;

export const RegionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
  keywords: z.array(z.string().min(1)),
  box: BoxSchema,
});
export type Region = z.infer<typeof RegionSchema>;

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
      box: clampBox(r.box),
    };
  });
}

/* ---------- library: matters, decks, runs ---------- */

const Id = z.string().min(1).max(64);

/** A matter groups the presentations (decks) for one project, plus their run history. */
export const MatterSchema = z.object({
  id: Id,
  name: z.string().trim().min(1).max(200),
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
  hasThumb: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type DeckRecord = z.infer<typeof DeckRecordSchema>;

export const DeckPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  slides: z.array(SlideSchema).optional(),
  analyzed: z.boolean().optional(),
});
export type DeckPatch = z.infer<typeof DeckPatchSchema>;

/** One thing that happened while presenting. `t` is ms since the run started. */
export const RunEventSchema = z.discriminatedUnion("type", [
  z.object({ t: z.number(), type: z.literal("slide"), slide: z.number().int() }),
  z.object({ t: z.number(), type: z.literal("zoom"), slide: z.number().int(), regionId: z.string(), label: z.string() }),
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
