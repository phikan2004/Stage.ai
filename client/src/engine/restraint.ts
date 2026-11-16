import type { ProducerConfig } from "./config";
import type { RegionScore } from "./matcher";

export type Phase = "idle" | "dwell" | "zoomed" | "cooldown";

export interface RestraintState {
  phase: Phase;
  regionId: string | null;
  zoomedAt: number;
  lastMatchAt: number;
  cooldownUntil: number;
}

export type Action =
  | { type: "none" }
  | { type: "zoomTo"; regionId: string }
  | { type: "zoomOut"; reason: "timeout" | "slideChange" | "manual" | "automationOff" };

export interface StepResult {
  state: RestraintState;
  action: Action;
}

export const initialRestraint = (): RestraintState => ({
  phase: "idle",
  regionId: null,
  zoomedAt: 0,
  lastMatchAt: 0,
  cooldownUntil: 0,
});

type Cfg = Pick<
  ProducerConfig,
  "confidenceThreshold" | "margin" | "sustainThreshold" | "minDwellMs" | "noMatchTimeoutMs" | "cooldownMs"
>;

/** The region that clearly wins right now, or null when nothing is confident and unambiguous. */
export function decisiveWinner(scores: RegionScore[], cfg: Cfg): string | null {
  const [top, second] = scores;
  if (!top || top.score < cfg.confidenceThreshold) return null;
  if (top.score - (second?.score ?? 0) < cfg.margin) return null;
  return top.id;
}

const NONE: Action = { type: "none" };

/**
 * How long to wait before switching away from the current region.
 * A trigger phrase heard for the competing region drops it to 0.
 * Very high confidence scales it down proportionally.
 * Falls back to cfg.minDwellMs for timeout/zoom-out decisions (no competing winner).
 */
function effectiveDwellMs(scores: RegionScore[], state: RestraintState, cfg: Cfg): number {
  const winner = decisiveWinner(scores, cfg);
  if (!winner || winner === state.regionId) return cfg.minDwellMs;
  const top = scores.find((s) => s.id === winner);
  if (!top) return cfg.minDwellMs;
  if (top.trigger) return 0;
  const excess = Math.max(0, top.score - cfg.confidenceThreshold);
  const range = 1 - cfg.confidenceThreshold;
  return cfg.minDwellMs * Math.max(0, 1 - excess / range);
}

/** Advance the state machine one tick. Pure. `scores` must be sorted high → low. */
export function step(state: RestraintState, scores: RegionScore[], now: number, cfg: Cfg): StepResult {
  const winner = decisiveWinner(scores, cfg);
  const zoomTo = (regionId: string): StepResult => ({
    state: { phase: "dwell", regionId, zoomedAt: now, lastMatchAt: now, cooldownUntil: 0 },
    action: { type: "zoomTo", regionId },
  });

  switch (state.phase) {
    case "cooldown":
      if (now < state.cooldownUntil) return { state, action: NONE };
    // falls through
    case "idle": {
      const idle: RestraintState = { ...initialRestraint(), phase: "idle" };
      return winner ? zoomTo(winner) : { state: idle, action: NONE };
    }

    case "dwell":
    case "zoomed": {
      const current = scores.find((s) => s.id === state.regionId)?.score ?? 0;
      const lastMatchAt = current >= cfg.sustainThreshold ? now : state.lastMatchAt;
      const dwellDone = now - state.zoomedAt >= effectiveDwellMs(scores, state, cfg);
      const next: RestraintState = { ...state, lastMatchAt, phase: dwellDone ? "zoomed" : "dwell" };

      if (!dwellDone) return { state: next, action: NONE };

      if (winner && winner !== state.regionId) return zoomTo(winner);

      if (now - lastMatchAt >= cfg.noMatchTimeoutMs) {
        return {
          state: { ...initialRestraint(), phase: "cooldown", cooldownUntil: now + cfg.cooldownMs },
          action: { type: "zoomOut", reason: "timeout" },
        };
      }
      return { state: next, action: NONE };
    }
  }
}

/** Immediate zoom-out from an external event (slide change, Esc, automation off). */
export function forceZoomOut(
  state: RestraintState,
  reason: "slideChange" | "manual" | "automationOff",
  now: number,
  cfg: Pick<ProducerConfig, "cooldownMs">,
): StepResult {
  const wasZoomed = state.phase === "dwell" || state.phase === "zoomed";
  return {
    // Slide changes reset fully; a manual Esc gets a cooldown so we don't snap right back in.
    state:
      reason === "manual"
        ? { ...initialRestraint(), phase: "cooldown", cooldownUntil: now + Math.max(cfg.cooldownMs, 1500) }
        : initialRestraint(),
    action: wasZoomed || reason === "slideChange" ? { type: "zoomOut", reason } : NONE,
  };
}
