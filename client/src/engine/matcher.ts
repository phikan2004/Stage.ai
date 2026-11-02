import type { Region } from "../../../shared/schema";
import type { ProducerConfig } from "./config";
import { similarity, tokenize } from "./text";
import type { WindowToken } from "./transcriptWindow";

interface Phrase {
  stems: string[];
  weight: number;
  df: number;
}

/** A presenter phrase from the director. Hearing one is strong evidence on its own. */
const TRIGGER_WEIGHT = 1.5;

export interface CompiledRegion {
  id: string;
  /** stem → weight (a word of a k-word keyword weighs 1/k) */
  stems: Map<string, number>;
  /** stem → number of regions on the slide containing it */
  df: Map<string, number>;
  phrases: Phrase[];
  triggers: string[][];
}

export interface RegionScore {
  id: string;
  score: number;
  raw: number;
  /** how many words unique to this region were heard */
  hits?: number;
  /** one of the region's trigger phrases was heard */
  trigger?: boolean;
}

/** Precompute per-slide region terms. Call once per slide, not per tick. */
export function compileRegions(regions: Region[], labelWeight: number): CompiledRegion[] {
  const compiled = regions.map((r) => {
    const stems = new Map<string, number>();
    const phrases: Phrase[] = [];
    const add = (text: string, base: number) => {
      const st = [...new Set(tokenize(text))];
      if (!st.length) return;
      const w = base / st.length;
      for (const s of st) stems.set(s, Math.max(stems.get(s) ?? 0, w));
      const ordered = tokenize(text);
      if (ordered.length > 1) phrases.push({ stems: ordered, weight: base, df: 1 });
    };
    for (const k of r.keywords) add(k, 1);
    add(r.label, labelWeight);
    const triggers = (r.phrases ?? []).map(tokenize).filter((t) => t.length > 1);
    return { id: r.id, stems, df: new Map<string, number>(), phrases, triggers };
  });

  const counts = new Map<string, number>();
  for (const c of compiled) for (const s of c.stems.keys()) counts.set(s, (counts.get(s) ?? 0) + 1);
  for (const c of compiled) {
    for (const s of c.stems.keys()) c.df.set(s, counts.get(s) ?? 1);
    for (const p of c.phrases) p.df = Math.min(...p.stems.map((s) => counts.get(s) ?? 1));
  }
  return compiled;
}

const simCache = new Map<string, number>();
function cachedSim(a: string, b: string): number {
  if (a === b) return 1;
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  let v = simCache.get(key);
  if (v === undefined) {
    v = similarity(a, b);
    if (simCache.size > 50_000) simCache.clear();
    simCache.set(key, v);
  }
  return v;
}

function matchStrength(a: string, b: string, fuzzyThreshold: number): number {
  const s = cachedSim(a, b);
  return s >= fuzzyThreshold ? s : 0;
}

/**
 * Whether a trigger phrase was spoken. People don't say a phrase verbatim, so words must appear in order but may have
 * a word or two between them, and phrases of 4+ words may miss one.
 */
function triggerHeard(tokens: WindowToken[], stems: string[], fuzzyThreshold: number): boolean {
  const need = stems.length <= 3 ? stems.length : stems.length - 1;
  for (let start = 0; start < tokens.length; start++) {
    let found = 0;
    let next = 0;
    const end = Math.min(tokens.length, start + stems.length + 3);
    for (let i = start; i < end && next < stems.length; i++) {
      for (let j = next; j < stems.length; j++) {
        if (matchStrength(tokens[i].stem, stems[j], fuzzyThreshold)) {
          found++;
          next = j + 1;
          break;
        }
      }
    }
    if (found >= need) return true;
  }
  return false;
}

export function recency(t: number, now: number, cfg: Pick<ProducerConfig, "windowMs" | "recencyFloor">): number {
  const age = Math.max(0, now - t);
  if (age > cfg.windowMs) return 0;
  return cfg.recencyFloor + (1 - cfg.recencyFloor) * (1 - age / cfg.windowMs);
}

/** Score every region on the current slide against the rolling window. Sorted high → low. */
export function scoreRegions(
  tokens: WindowToken[],
  regions: CompiledRegion[],
  now: number,
  cfg: ProducerConfig,
): RegionScore[] {
  const tokenW = tokens.map((tk) => tk.weight * recency(tk.t, now, cfg));

  const scores = regions.map((r) => {
    let raw = 0;
    let hits = 0;

    // Single words: best evidence per stem, so repeating a word doesn't snowball.
    for (const [stem, w] of r.stems) {
      let best = 0;
      for (let i = 0; i < tokens.length; i++) {
        const m = matchStrength(tokens[i].stem, stem, cfg.fuzzyThreshold);
        if (m) best = Math.max(best, m * tokenW[i]);
      }
      raw += (w * best) / (r.df.get(stem) ?? 1);
      if (best > 0 && r.df.get(stem) === 1) hits++;
    }

    // Multi-word keywords spoken in order earn an extra bonus.
    for (const p of r.phrases) {
      let best = 0;
      for (let i = 0; i + p.stems.length <= tokens.length; i++) {
        let sum = 0;
        let ok = true;
        for (let j = 0; j < p.stems.length; j++) {
          const m = matchStrength(tokens[i + j].stem, p.stems[j], cfg.fuzzyThreshold);
          if (!m) {
            ok = false;
            break;
          }
          sum += m;
        }
        if (ok) best = Math.max(best, (sum / p.stems.length) * tokenW[i + p.stems.length - 1]);
      }
      raw += ((cfg.phraseBonus - 1) * p.weight * best) / p.df;
    }

    const trigger = r.triggers.some((t) => triggerHeard(tokens, t, cfg.fuzzyThreshold));
    if (trigger) raw += TRIGGER_WEIGHT;

    return { id: r.id, raw, hits, trigger, score: 1 - Math.exp(-raw / cfg.saturation) };
  });

  return scores.sort((a, b) => b.score - a.score);
}
