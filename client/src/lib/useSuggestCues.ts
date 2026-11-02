import { useEffect, useRef, useState } from "react";
import type { Region, SlideFacts } from "../../../shared/schema";
import { analyzeAll } from "./analyzeQueue";
import { api } from "./api";
import { planImages, type Deck } from "./deck";
import { highlightMarks } from "./textLines";

interface Options {
  deckId: string;
  deck: Deck;
  /** the deck already has a director's plan */
  planned: boolean;
  onRegions: (index: number, regions: Region[]) => void;
}

/**
 * Has Claude read the whole deck and suggest cues. Only slides with nothing on them are filled in, so anything the
 * presenter drew is left alone.
 */
export function useSuggestCues({ deckId, deck, planned, onRegions }: Options) {
  const [progress, setProgress] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const hasPlan = useRef(planned);
  hasPlan.current ||= planned;

  useEffect(() => () => abort.current?.abort(), []);

  const suggest = async () => {
    const health = await fetch("/api/health").then((r) => r.json()).catch(() => null);
    if (!health?.hasKey) return setMessage("Claude isn't connected, so cues can't be suggested. You can still drag them on.");
    const indices = deck.images.map((_, i) => i).filter((i) => !deck.slides[i]?.regions.length);
    if (indices.length === 0) return setMessage("Every slide already has cues. Delete a slide's cues to have Claude suggest new ones.");

    const ctrl = new AbortController();
    abort.current = ctrl;
    setMessage(null);
    if (health.director && !hasPlan.current) {
      setProgress("Reading the whole deck…");
      try {
        const facts = deck.images.every((img) => img.facts) ? deck.images.map((img) => img.facts as SlideFacts) : undefined;
        await api.planDeck(deckId, await planImages(deck.images), facts, ctrl.signal);
        hasPlan.current = true;
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setMessage(`Whole-deck planning didn't finish (${e instanceof Error ? e.message : e}), so slides were read one at a time.`);
      }
    }

    let done = 0;
    let added = 0;
    let failed = 0;
    setProgress(`Suggesting cues: 0 of ${indices.length} slides`);
    await analyzeAll(
      indices.map((i) => deck.images[i].url),
      indices.map((slideIndex) => ({ deckId, slideIndex, facts: deck.images[slideIndex].facts })),
      (k, status, regions) => {
        if (status.state === "error") failed++;
        if (status.state !== "done" && status.state !== "error") return;
        setProgress(`Suggesting cues: ${++done} of ${indices.length} slides`);
        if (!regions) return;
        added += regions.length;
        const slide = indices[k];
        const cued = regions.map((r) => ({ ...r, cue: r.cue ?? ("outline" as const) }));
        onRegions(slide, cued);
        // Highlights need their lines worked out from the slide, which happens right here in the browser.
        Promise.all(cued.map(async (r) => (r.cue === "highlight" ? { ...r, marks: await highlightMarks(deck.images[slide], r.box) } : r)))
          .then((marked) => cued.some((r) => r.cue === "highlight") && onRegions(slide, marked))
          .catch(() => {});
      },
      { concurrency: 2, signal: ctrl.signal },
    );
    if (ctrl.signal.aborted) return;
    setProgress(null);
    setMessage(failed ? `Added ${added} cues. ${failed} slides failed, so try again for those.` : `Added ${added} cues.`);
  };

  return { suggest, progress, message };
}
