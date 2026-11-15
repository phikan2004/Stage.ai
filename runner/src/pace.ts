/** How fast Stage moves on screen. STAGE_PACE scales everything: 1 is natural, 1.5 is slower, 0.7 is quicker. */
const scale = () => {
  const n = Number(process.env.STAGE_PACE);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Short moves are quick and long ones take longer, as a hand does. */
export const glideMs = (distance: number) => Math.round(clamp(320 + distance * 0.4, 320, 1100) * scale());

/** The moment a person takes on a target before clicking it. */
export const hoverMs = () => Math.round(220 * scale());

/** Uneven typing, with a beat after words and sentences. */
export function keyDelayMs(ch: string, random = Math.random): number {
  const pause = /[.,:;!?]/.test(ch) ? 180 : ch === " " ? 40 : 0;
  return Math.round((55 + random() * 55 + pause) * scale());
}

/** Between one action and the next. */
export const actionGapMs = (random = Math.random) => Math.round((450 + random() * 500) * scale());

/** Between one wheel notch and the next. */
export const scrollStepMs = () => Math.round(45 * scale());
