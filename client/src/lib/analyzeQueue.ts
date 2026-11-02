import type { Region, SlideFacts } from "../../../shared/schema";

export type SlideStatus =
  | { state: "pending" }
  | { state: "running" }
  | { state: "done"; count: number }
  | { state: "error"; message: string };

export interface SlideRef {
  deckId: string;
  slideIndex: number;
  facts?: SlideFacts;
}

export async function analyzeImage(image: string, ref: SlideRef, signal?: AbortSignal): Promise<Region[]> {
  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image, ...ref }),
    signal,
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.regions as Region[];
}

/** Analyze slides with limited concurrency, reporting per-slide status as it goes. */
export async function analyzeAll(
  images: string[],
  refs: SlideRef[],
  onStatus: (index: number, status: SlideStatus, regions?: Region[]) => void,
  { concurrency = 2, signal }: { concurrency?: number; signal?: AbortSignal } = {},
): Promise<void> {
  let next = 0;
  images.forEach((_, i) => onStatus(i, { state: "pending" }));
  const worker = async () => {
    while (next < images.length && !signal?.aborted) {
      const i = next++;
      onStatus(i, { state: "running" });
      try {
        const regions = await analyzeImage(images[i], refs[i], signal);
        onStatus(i, { state: "done", count: regions.length }, regions);
      } catch (e) {
        if (signal?.aborted) return;
        onStatus(i, { state: "error", message: e instanceof Error ? e.message : String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, images.length) }, worker));
}
