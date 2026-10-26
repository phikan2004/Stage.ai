import type { Region } from "../../../shared/schema";
import type { ProducerConfig } from "./config";
import { compileRegions, scoreRegions, type CompiledRegion, type RegionScore } from "./matcher";
import { forceZoomOut, initialRestraint, step, type Action, type RestraintState } from "./restraint";
import { TranscriptWindow } from "./transcriptWindow";

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

  constructor(private cfg: ProducerConfig) {}

  setConfig(cfg: ProducerConfig): void {
    this.cfg = cfg;
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
  }

  zoomOut(reason: "manual" | "automationOff", now: number): Action {
    const r = forceZoomOut(this.state, reason, now, this.cfg);
    this.state = r.state;
    return r.action;
  }

  scores(now: number): RegionScore[] {
    const tokens = this.window.tokens(now, this.cfg.windowMs, this.cfg.interimWeight);
    return scoreRegions(tokens, this.compiled, now, this.cfg);
  }

  tick(now: number): TickResult {
    const scores = this.scores(now);
    const r = step(this.state, scores, now, this.cfg);
    this.state = r.state;
    return { action: r.action, scores, state: r.state };
  }

  get current(): RestraintState {
    return this.state;
  }
}
