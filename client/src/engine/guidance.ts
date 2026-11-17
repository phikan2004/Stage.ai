import type { ProducerConfig } from "./config";
import type { RegionScore } from "./matcher";

/** Words that tell the audience where to look; with one of these, less evidence is enough. */
const LEAD_IN =
  /\b(look(ing)? at|take a look|(you )?can see|you('ll| can| will) see|notice|focus on|point out|highlight|turn(ing)? to|moving (on )?to|pay attention|let('s| me) (talk|walk|show|dive|jump|go|look|start|discuss|explain|break)|i want to (talk|show|discuss|highlight|walk|point)|let('s| me) (take a look|focus)|talk(ing)? about|discuss(ing)?|here (we have|you can|you'll|you see|is|are)|when it comes to|in terms of|as (for|far as)|on the (topic|subject) of|getting into|jumping to|starting with|first(ly)?|next up|moving on|speaking of|regarding|about)\b/i;

export const hasLeadIn = (recentText: string) => LEAD_IN.test(recentText);

export interface Guidance {
  /** regions in the director's order */
  order: string[];
  /** regions already cued on this slide */
  done: ReadonlySet<string>;
  /** the region on screen right now, which always keeps its score */
  activeId: string | null;
  sinceSlide: number;
  leadIn: boolean;
}

type Cfg = Pick<ProducerConfig, "overviewMs" | "minHits" | "confidenceThreshold">;

/**
 * Whether a region may fire. The presenter introduces a slide first, so nothing can fire during the overview. After
 * that only the next planned step can, on real evidence. Saying one of a region's own phrases always counts, so going
 * out of order or returning to something still works.
 */
export function eligible(s: RegionScore, g: Guidance, cfg: Cfg): boolean {
  if (s.id === g.activeId) return true;
  if (g.sinceSlide < cfg.overviewMs) return false;
  if (s.trigger) return true;
  if (s.id !== g.order.find((id) => !g.done.has(id))) return false;
  return (s.hits ?? 0) >= (g.leadIn ? 1 : cfg.minHits);
}

/** Scores with everything that may not fire right now zeroed, sorted high → low. */
export function gate(scores: RegionScore[], g: Guidance, cfg: Cfg): RegionScore[] {
  return scores
    .map((s) => {
      if (!eligible(s, g, cfg)) return { ...s, score: 0 };
      // A lead-in makes up for a word or two: on its own one word scores below the bar.
      return g.leadIn && s.id !== g.activeId ? { ...s, score: Math.max(s.score, cfg.confidenceThreshold) } : s;
    })
    .sort((a, b) => b.score - a.score);
}
