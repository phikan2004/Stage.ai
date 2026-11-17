import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { costUsd, CUE_EFFORT, planFor, type Effort, type Plan, type TokenUsage } from "../../shared/plans.ts";
import {
  AnalysisSchema,
  CueSchema,
  GuidedAnalysisSchema,
  normalizeRegions,
  RegionDetailsSchema,
  type Cue,
  type DeckPlan,
  type Region,
  type RegionDetails,
  type SlideFacts,
  type SlidePlan,
  type UsageEntry,
} from "../../shared/schema.ts";
import {
  DIRECTOR_PROMPT,
  DIRECTOR_SCHEMA,
  directorPrompt,
  factsPrompt,
  GUIDED_PROMPT,
  GUIDED_SCHEMA,
  guidedPrompt,
  LEARN_PROMPT,
  LEARN_SCHEMA,
  learnPrompt,
  REGION_PROMPT,
  REGION_SCHEMA,
  regionPrompt,
  RESPONSE_SCHEMA,
  SYSTEM_PROMPT,
  userPrompt,
} from "./prompt.ts";
import type { Library } from "./store.ts";

export class AnalyzeError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

/** Called once per billed Claude call, including calls whose answer turns out to be unusable. */
export type UsageSink = (entry: Omit<UsageEntry, "deckId">) => Promise<void>;

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic());

export const currentPlan = (): Plan => planFor(process.env.PRODUCER_PLAN);
// VISION_MODEL and VISION_EFFORT override the plan, for trying other settings.
export const model = () => process.env.VISION_MODEL || currentPlan().model;
const effort = () => (process.env.VISION_EFFORT || currentPlan().effort) as Effort;
const directorEffort = () => (process.env.VISION_EFFORT || currentPlan().directorEffort) as Effort;

function parseDataUrl(url: string) {
  const m = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/.exec(url);
  if (!m) throw new AnalyzeError("Image must be a base64 JPEG, PNG, GIF or WebP data URL.", 400);
  return { media_type: m[1] as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: m[2] };
}

interface Call {
  system: string;
  schema: Record<string, unknown>;
  content: Anthropic.Beta.BetaContentBlockParam[];
  effort: Effort;
  maxTokens: number;
  modelOverride?: string;
  usage: (u: TokenUsage & { model: string; effort: string; costUsd: number | null; durationMs: number }) => Promise<void>;
}

async function callModel(call: Call): Promise<unknown> {
  const started = Date.now();
  // Streamed because a whole-deck plan at high effort can outlast a plain request's timeout.
  const res = await getClient()
    .beta.messages.stream({
      model: call.modelOverride ?? model(),
      max_tokens: call.maxTokens,
      // On a safety decline, re-run on Anthropic's recommended fallback model instead of failing.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: call.effort, format: { type: "json_schema", schema: call.schema } },
      system: call.system,
      messages: [{ role: "user", content: call.content }],
    })
    .finalMessage();

  // Billed whatever happens next, so this comes before any check on the answer.
  const usage: TokenUsage = {
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
  };
  await call.usage({ ...usage, model: res.model, effort: call.effort, costUsd: costUsd(res.model, usage), durationMs: Date.now() - started });

  if (res.stop_reason === "refusal") {
    throw new AnalyzeError(`Claude declined this request${res.stop_details?.explanation ? `: ${res.stop_details.explanation}` : "."}`);
  }
  if (res.stop_reason === "max_tokens") throw new Error("response was cut off (max_tokens)");
  const text = res.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("empty response");
  return JSON.parse(text);
}

function requireKey() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new AnalyzeError("ANTHROPIC_API_KEY is not set on the server. Add it to .env, or use the sample deck.", 503);
  }
}

/** Run an attempt, feeding a validation error back once. API errors aren't retried here. */
async function withRetry<T>(what: string, attempt: (retryError?: string) => Promise<T>): Promise<T> {
  let lastError = "";
  for (let i = 0; i < 2; i++) {
    try {
      return await attempt(i ? lastError : undefined);
    } catch (e) {
      if (e instanceof AnalyzeError) throw e;
      if (e instanceof Anthropic.AuthenticationError) throw new AnalyzeError("Claude rejected the API key. Check ANTHROPIC_API_KEY in .env.", 401);
      if (e instanceof Anthropic.RateLimitError) throw new AnalyzeError("Claude rate limit hit. Wait a moment and retry the failed slides.", 429);
      if (e instanceof Anthropic.APIError) throw new AnalyzeError(`Claude API error: ${e.message}`, e.status ?? 502);
      lastError = e instanceof Error ? e.message.slice(0, 800) : String(e);
    }
  }
  throw new AnalyzeError(`Claude returned an invalid ${what} twice: ${lastError}`);
}

const imageBlock = (url: string): Anthropic.Beta.BetaContentBlockParam => ({
  type: "image",
  source: { type: "base64", ...parseDataUrl(url) },
});

/** The model numbers slides from 1 and may leave some out; every slide gets an entry. */
const RawPlan = z.object({
  summary: z.string(),
  slides: z.array(
    z.object({
      slide: z.number().int(),
      purpose: z.string(),
      density: z.enum(["clean", "busy"]),
      emphasis: z.array(z.object({ target: z.string().min(1), cue: CueSchema, why: z.string() })),
    }),
  ),
});

function toPlan(json: unknown, slideCount: number): DeckPlan {
  const raw = RawPlan.parse(json);
  if (raw.slides.length === 0) throw new Error("the plan has no slides");
  return {
    summary: raw.summary,
    slides: Array.from({ length: slideCount }, (_, index) => {
      const s = raw.slides.find((x) => x.slide === index + 1);
      return { index, purpose: s?.purpose ?? "", density: s?.density ?? "clean", emphasis: (s?.emphasis ?? []).slice(0, 5) };
    }),
  };
}

/** The director pass: read the whole deck and decide what deserves emphasis on each slide. */
export async function planDeck(images: string[], facts: SlideFacts[] | undefined, onUsage: UsageSink): Promise<DeckPlan> {
  requireKey();
  const content: Anthropic.Beta.BetaContentBlockParam[] = images.flatMap((url, i) => {
    const notes = facts?.[i]?.notes;
    return [
      { type: "text" as const, text: `Slide ${i + 1}:` },
      imageBlock(url),
      ...(notes ? [{ type: "text" as const, text: `Speaker notes for slide ${i + 1}:\n${notes}` }] : []),
    ];
  });
  return withRetry("plan", async (retryError) =>
    toPlan(
      await callModel({
        system: DIRECTOR_PROMPT,
        schema: DIRECTOR_SCHEMA,
        content: [...content, { type: "text", text: directorPrompt(images.length, retryError) }],
        effort: directorEffort(),
        maxTokens: 32000,
        usage: (u) => onUsage({ ...u, kind: "plan", slideIndex: null }),
      }),
      images.length,
    ),
  );
}

function validate(json: unknown): Region[] {
  const parsed = AnalysisSchema.parse(json);
  if (parsed.regions.length < 3) throw new Error(`expected 3 to 8 regions, got ${parsed.regions.length}`);
  return normalizeRegions(parsed.regions.slice(0, 8));
}

function validateGuided(json: unknown, slide: SlidePlan): Region[] {
  const parsed = GuidedAnalysisSchema.parse(json);
  if (parsed.regions.length !== slide.emphasis.length) {
    throw new Error(`expected ${slide.emphasis.length} regions, one per item, got ${parsed.regions.length}`);
  }
  // Cues are the director's decision, and order is the plan's.
  return normalizeRegions(parsed.regions.map((r, i) => ({ ...r, cue: slide.emphasis[i].cue })));
}

/** Work out a drawn cue's keywords and phrases. `image` is the slide with the region marked in red. */
export async function describeRegion(
  image: string,
  label: string,
  cue: Cue,
  notes: string | undefined,
  slideIndex: number | null,
  onUsage: UsageSink,
): Promise<RegionDetails> {
  requireKey();
  return withRetry("region", async (retryError) =>
    RegionDetailsSchema.parse(
      await callModel({
        system: REGION_PROMPT,
        schema: REGION_SCHEMA,
        content: [imageBlock(image), { type: "text", text: regionPrompt(label, notes, retryError) }],
        effort: CUE_EFFORT[cue],
        maxTokens: 4000,
        usage: (u) => onUsage({ ...u, kind: "region", slideIndex }),
      }),
    ),
  );
}

export interface SlideContext {
  slideIndex: number | null;
  /** present when the director planned this slide */
  plan?: { summary: string; slide: SlidePlan };
  /** what the file itself says about this slide, for PowerPoint decks */
  facts?: SlideFacts;
  onUsage: UsageSink;
}

const LEARN_MIN_WORDS = 15;
const MAX_PHRASES = 12;

const LearnResult = z.object({
  regions: z.array(z.object({ id: z.string(), phrases: z.array(z.string()) })),
});

/**
 * Post-run learning: maps the transcript from each slide to regions, extracts natural phrases the
 * presenter used, and merges them into the deck's region phrases. Fire-and-forget — never throws.
 * Each run makes the next one smarter without any user action.
 */
export async function learnFromRun(runId: string, store: Library): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) return;
  const run = await store.run(runId);
  if (!run) return;
  const deck = await store.deck(run.deckId);
  if (!deck) return;

  const onUsage: UsageSink = async (entry) => {
    store
      .recordUsage({ ...entry, deckId: deck.id })
      .catch((e) => console.error(`learn: usage write failed: ${e instanceof Error ? e.message : e}`));
  };

  // Accumulate heard (non-simulated) text per slide in order
  const slideText = new Map<number, string[]>();
  for (const event of run.events) {
    if (event.type !== "heard" || event.simulated) continue;
    const parts = slideText.get(event.slide) ?? [];
    parts.push(event.text);
    slideText.set(event.slide, parts);
  }

  const patchedSlides = deck.slides.map((s) => ({ ...s, regions: [...s.regions] }));
  let changed = false;

  for (const [slideIndex, parts] of slideText) {
    const transcript = parts.join(" ");
    if (transcript.split(/\s+/).filter(Boolean).length < LEARN_MIN_WORDS) continue;

    const slide = deck.slides.find((s) => s.index === slideIndex);
    if (!slide?.regions.length) continue;

    const regionInput = slide.regions.map((r) => ({ id: r.id, label: r.label, keywords: r.keywords ?? [] }));

    try {
      const raw = await callModel({
        system: LEARN_PROMPT,
        schema: LEARN_SCHEMA,
        content: [{ type: "text", text: learnPrompt(regionInput, transcript) }],
        effort: "low" as Effort,
        maxTokens: 1000,
        modelOverride: "claude-haiku-5-5",
        usage: (u) => onUsage({ ...u, kind: "region", slideIndex }),
      });

      const result = LearnResult.safeParse(raw);
      if (!result.success) continue;

      let slideChanged = false;
      const patchIdx = patchedSlides.findIndex((s) => s.index === slideIndex);
      if (patchIdx < 0) continue;

      patchedSlides[patchIdx].regions = slide.regions.map((region) => {
        const learned = result.data.regions.find((r) => r.id === region.id);
        if (!learned?.phrases.length) return region;

        const existingLower = new Set((region.phrases ?? []).map((p) => p.toLowerCase()));
        const toAdd = learned.phrases.filter((p) => {
          const t = p.trim();
          return t.length >= 10 && t.split(/\s+/).length >= 3 && !existingLower.has(t.toLowerCase());
        });
        if (!toAdd.length) return region;

        slideChanged = true;
        return { ...region, phrases: [...(region.phrases ?? []), ...toAdd].slice(0, MAX_PHRASES) };
      });

      if (slideChanged) changed = true;
    } catch (e) {
      console.error(`learn: slide ${slideIndex} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  if (changed) {
    await store.patchDeck(deck.id, { slides: patchedSlides });
    console.log(`learn: updated phrases for deck ${deck.id} from run ${runId}`);
  }
}

/** Find a slide's regions; validate and retry once with the error fed back. */
export async function analyzeSlide(image: string, { slideIndex, plan, facts, onUsage }: SlideContext): Promise<Region[]> {
  // The director chose nothing here, so there's nothing to find and nothing to pay for.
  if (plan && plan.slide.emphasis.length === 0) return [];
  requireKey();
  const usage = (u: Parameters<Call["usage"]>[0]) => onUsage({ ...u, kind: "slide", slideIndex });
  return withRetry("regions", async (retryError) => {
    if (plan) {
      const content = [imageBlock(image), { type: "text" as const, text: guidedPrompt(plan.summary, plan.slide, facts, retryError) }];
      const json = await callModel({ system: GUIDED_PROMPT, schema: GUIDED_SCHEMA, content, effort: effort(), maxTokens: 16000, usage });
      return validateGuided(json, plan.slide);
    }
    const content = [imageBlock(image), { type: "text" as const, text: `${userPrompt(retryError)}${retryError ? "" : factsPrompt(facts)}` }];
    return validate(await callModel({ system: SYSTEM_PROMPT, schema: RESPONSE_SCHEMA, content, effort: effort(), maxTokens: 16000, usage }));
  });
}
