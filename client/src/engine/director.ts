import { isGuided, type Region } from "../../../shared/schema";
import type { ProducerConfig } from "./config";
import { gate, hasLeadIn } from "./guidance";
import { compileRegions, scoreRegions, type CompiledRegion, type RegionScore } from "./matcher";
import { forceZoomOut, initialRestraint, step, type Action, type RestraintState } from "./restraint";
import { tuneForSlide } from "./tune";
import { TranscriptWindow } from "./transcriptWindow";

/** How recently a lead-in like "if you look at" still counts. */
const LEAD_IN_MS = 4000;
/** Below this, a pace measurement is mostly noise. */
const MIN_WORDS_FOR_PACE = 30;

export interface TickResult {
  action: Action;
  scores: RegionScore[];
  state: RestraintState;
}

/**
 * Glues transcript window → matcher → restraint together. Still pure:
 * no timers, no DOM. The caller supplies `now` and calls tick() on its own schedule.
 */
export class ZoomDirector {
  readonly window = new TranscriptWindow();
  private compiled: CompiledRegion[] = [];
  private regions: Region[] = [];
  private state: RestraintState = initialRestraint();
  private compiledLabelWeight = NaN;
  private guided = false;
  private slideStart = 0;
  private done = new Set<string>();
  private tuned: ProducerConfig;
  private spokenWords = 0;
  private firstWordAt: number | null = null;
  private lastWordAt = 0;

  constructor(private cfg: ProducerConfig) {
    this.tuned = cfg;
  }

  /** Guided slides run on timings worked out for them; everything else uses the config as given. */
  private get active(): ProducerConfig {
    return this.guided ? this.tuned : this.cfg;
  }

  private get wordsPerMinute(): number | null {
    const elapsed = this.lastWordAt - (this.firstWordAt ?? this.lastWordAt);
    return this.spokenWords >= MIN_WORDS_FOR_PACE && elapsed > 0 ? (this.spokenWords / elapsed) * 60_000 : null;
  }

  setConfig(cfg: ProducerConfig): void {
    this.cfg = cfg;
    this.tuned = tuneForSlide(cfg, this.regions, this.wordsPerMinute);
    if (cfg.labelWeight !== this.compiledLabelWeight) this.compile();
  }

  private compile(): void {
    this.compiled = compileRegions(this.regions, this.cfg.labelWeight);
    this.compiledLabelWeight = this.cfg.labelWeight;
  }

  /** New slide: zoom out immediately and forget what was said on the previous slide. */
  setSlide(regions: Region[], now: number): Action {
    this.regions = regions;
    this.compile();
    this.window.clear();
    this.guided = isGuided(regions);
    this.tuned = tuneForSlide(this.cfg, regions, this.wordsPerMinute);
    this.slideStart = now;
    this.done.clear();
    const r = forceZoomOut(this.state, "slideChange", now, this.cfg);
    this.state = r.state;
    return r.action;
  }

  /** Same slide, edited regions (e.g. live tweaks): recompile without resetting. */
  updateRegions(regions: Region[]): void {
    this.regions = regions;
    this.compile();
  }

  hear(text: string, isFinal: boolean, t: number): void {
    this.window.push(text, isFinal, t);
    if (!isFinal) return;
    this.spokenWords += text.split(/\s+/).filter(Boolean).length;
    this.firstWordAt ??= t;
    this.lastWordAt = t;
  }

  zoomOut(reason: "manual" | "automationOff", now: number): Action {
    const r = forceZoomOut(this.state, reason, now, this.cfg);
    this.state = r.state;
    return r.action;
  }

  scores(now: number): RegionScore[] {
    const cfg = this.active;
    const heard = this.window.tokens(now, cfg.windowMs, cfg.interimWeight);
    // Words from the overview are the introduction, not evidence that the presenter has reached a step.
    const tokens = this.guided ? heard.filter((t) => t.t >= this.slideStart + cfg.overviewMs) : heard;
    return scoreRegions(tokens, this.compiled, now, cfg);
  }

  tick(now: number): TickResult {
    const scores = this.scores(now);
    const effective = this.guided ? this.gated(scores, now) : this.ungated(scores, now);
    const r = step(this.state, effective, now, this.active);
    this.state = r.state;
    if (r.action.type === "zoomTo") this.done.add(r.action.regionId);
    return { action: r.action, scores, state: r.state };
  }

  /**
   * Unguided slides don't enforce any order, but a lead-in phrase ("let me show you", "talking about",
   * "moving on to", etc.) near a region's keyword is strong presenter intent — boost the top region up to
   * confidenceThreshold so it fires without requiring the presenter to repeat keywords multiple times.
   * Requires a minimum raw score of 0.2 so truly unrelated content doesn't trigger on lead-ins alone.
   */
  private ungated(scores: RegionScore[], now: number): RegionScore[] {
    const { finals, interim } = this.window.text(now, LEAD_IN_MS);
    const leadIn = hasLeadIn(`${finals} ${interim}`);
    if (!leadIn || scores.length === 0 || scores[0].score < 0.2) return scores;
    return scores.map((s, i) =>
      i === 0 ? { ...s, score: Math.max(s.score, this.active.confidenceThreshold) } : s,
    );
  }

  private gated(scores: RegionScore[], now: number): RegionScore[] {
    const { finals, interim } = this.window.text(now, LEAD_IN_MS);
    return gate(
      scores,
      {
        order: this.regions.map((r) => r.id),
        done: this.done,
        activeId: this.state.regionId,
        sinceSlide: now - this.slideStart,
        leadIn: hasLeadIn(`${finals} ${interim}`),
      },
      this.tuned,
    );
  }

  get current(): RestraintState {
    return this.state;
  }
}
