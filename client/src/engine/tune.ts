import type { Region } from "../../../shared/schema";
import type { ProducerConfig } from "./config";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Roughly how fast people present; the transcript window is sized for this pace. */
const TYPICAL_WPM = 150;

/**
 * Timings for one guided slide, worked out from what's on it and how the presenter is speaking, so nobody has to tune
 * anything. `wordsPerMinute` is null until there's been enough speech to measure.
 */
export function tuneForSlide(base: ProducerConfig, regions: Region[], wordsPerMinute: number | null): ProducerConfig {
  const largest = Math.max(0, ...regions.map((r) => r.box.w * r.box.h));
  return {
    ...base,
    // The more that's on a slide, the longer it takes to introduce.
    overviewMs: clamp(3000 + regions.length * 1000, 4000, 8000),
    // A region drawn by hand may only have its label to go on until its details arrive.
    minHits: regions.every((r) => r.keywords.length >= 3) ? 2 : 1,
    // Big regions take longer for the audience to take in, so they stay up longer.
    noMatchTimeoutMs: clamp(3500 + largest * 12000, 3500, 8000),
    // Slower speakers say fewer words in the same time, so they get a longer window.
    windowMs: wordsPerMinute ? clamp(base.windowMs * (TYPICAL_WPM / wordsPerMinute), 5000, 10000) : base.windowMs,
  };
}
