import type { Region } from "../../../shared/schema";

/**
 * Words to bias speech recognition toward on this slide: every keyword, then
 * labels, de-duplicated. Capped well under Deepgram's 500-token limit.
 */
export function keytermsFor(regions: Region[], maxTerms = 50, maxChars = 1200): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let chars = 0;
  const candidates = [...regions.flatMap((r) => r.keywords), ...regions.map((r) => r.label)];
  for (const raw of candidates) {
    const term = raw.trim().replace(/\s+/g, " ");
    const key = term.toLowerCase();
    if (!term || seen.has(key) || term.length > 60) continue;
    if (out.length >= maxTerms || chars + term.length > maxChars) break;
    seen.add(key);
    out.push(term);
    chars += term.length;
  }
  return out;
}
