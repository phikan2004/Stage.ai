import type { Cue } from "./schema.ts";

/**
 * What each plan's analysis uses. `premium` is the highest quality; `free` keeps the core experience by analyzing each
 * slide on its own with a cheaper model. There are no accounts yet, so the whole app runs on one plan (PRODUCER_PLAN).
 */
export type PlanId = "free" | "premium";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Plan {
  id: PlanId;
  model: string;
  /** per-slide region finding */
  effort: Effort;
  /** the whole-deck director pass; off means each slide is analyzed on its own */
  director: boolean;
  directorEffort: Effort;
}

export const PLANS: Record<PlanId, Plan> = {
  free: { id: "free", model: "claude-sonnet-5-5", effort: "medium", director: false, directorEffort: "medium" },
  premium: { id: "premium", model: "claude-opus-5-5", effort: "high", director: true, directorEffort: "xhigh" },
};

/**
 * How hard Claude thinks about a cue someone drew, by what the cue needs. Lighter cues only need to know how the
 * presenter will refer to the area; a Zoom or Callout is read closely, because the audience studies what it shows.
 * Highlight lines and Reveal covers come from the slide image in the browser, so those cost no Claude time at all.
 */
export const CUE_EFFORT: Record<Cue, Effort> = {
  outline: "low",
  spotlight: "low",
  arrow: "low",
  reveal: "low",
  highlight: "medium",
  zoom: "medium",
  callout: "medium",
};

export const planFor = (id: string | undefined): Plan => (id === "free" ? PLANS.free : PLANS.premium);

/** USD per million tokens. */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Cost of one call in USD, or null for a model with no known price (a fallback model, say). */
export function costUsd(model: string, u: TokenUsage): number | null {
  const p = PRICES[model];
  if (!p) return null;
  const perToken = (tokens: number, rate: number) => (tokens * rate) / 1_000_000;
  return (
    perToken(u.inputTokens, p.input) +
    perToken(u.outputTokens, p.output) +
    perToken(u.cacheReadTokens, p.cacheRead) +
    perToken(u.cacheWriteTokens, p.cacheWrite)
  );
}
