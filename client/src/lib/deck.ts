import type { Slide } from "../../../shared/schema";
import { api } from "./api";
import { parseRegionsFile } from "./fileIO";
import { renderPdf, sha256Hex, type SlideImage } from "./pdf";

/** A deck as the editor and presenter use it: rendered images plus regions. */
export interface Deck {
  name: string;
  hash: string;
  images: SlideImage[];
  slides: Slide[];
}

/* Rendering a PDF takes a few seconds, so keep the last few decks' images for this tab. */
const CACHE_SIZE = 3;
const imageCache = new Map<string, SlideImage[]>();
export function cacheImages(deckId: string, images: SlideImage[]) {
  imageCache.delete(deckId);
  imageCache.set(deckId, images);
  while (imageCache.size > CACHE_SIZE) imageCache.delete(imageCache.keys().next().value!);
}
export const cachedImages = (deckId: string) => imageCache.get(deckId);

/* One-shot messages for the deck page (e.g. regions-file warnings from the upload). */
const notices = new Map<string, string[]>();
export function takeNotices(deckId: string): string[] {
  const n = notices.get(deckId) ?? [];
  notices.delete(deckId);
  return n;
}

async function thumbnail(img: SlideImage, width = 480): Promise<Blob> {
  const el = new Image();
  el.src = img.url;
  await el.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.round((width * img.height) / img.width);
  canvas.getContext("2d")!.drawImage(el, 0, 0, canvas.width, canvas.height);
  return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("thumbnail failed"))), "image/jpeg", 0.82));
}

/**
 * Render a PDF, store it in the matter, and attach regions if a regions file came with it.
 * Returns the new deck's id; its images are cached so opening it is instant.
 */
export async function addDeck(
  matterId: string,
  name: string,
  bytes: ArrayBuffer,
  regionsText: string | undefined,
  onProgress: (msg: string) => void,
): Promise<string> {
  onProgress("Rendering slides…");
  const hash = await sha256Hex(bytes);
  const images = await renderPdf(bytes, (done, total) => onProgress(`Rendering slide ${done} of ${total}…`));
  if (images.length === 0) throw new Error("That PDF has no pages.");
  // Validate the regions file before uploading anything.
  const loaded = regionsText ? parseRegionsFile(regionsText, hash, images.length) : null;

  onProgress("Saving…");
  const deck = await api.uploadDeck(matterId, name, bytes, hash, images.length);
  cacheImages(deck.id, images);
  await Promise.all([
    loaded && api.patchDeck(deck.id, { slides: loaded.file.slides, analyzed: true }),
    thumbnail(images[0]).then((b) => api.putThumb(deck.id, b)),
  ]);
  if (loaded?.warnings.length) notices.set(deck.id, loaded.warnings);
  return deck.id;
}

/** Split dropped/chosen files into one PDF and an optional regions JSON. */
export async function pickFiles(files: FileList | File[]): Promise<{ pdf?: File; regions?: string }> {
  let pdf: File | undefined;
  let regions: string | undefined;
  for (const f of Array.from(files)) {
    if (f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")) pdf ??= f;
    else if (f.name.toLowerCase().endsWith(".json")) regions = await f.text();
  }
  return { pdf, regions };
}

/** Create a "Sample" matter holding the bundled sample deck. */
export async function createSampleMatter(onProgress: (msg: string) => void): Promise<string> {
  onProgress("Loading sample deck…");
  const [pdf, regions] = await Promise.all([
    fetch("/sample/sample.pdf").then((r) => r.arrayBuffer()),
    fetch("/sample/sample.regions.json").then((r) => r.text()),
  ]);
  const matter = await api.createMatter("Sample matter");
  return addDeck(matter.id, "sample.pdf", pdf, regions, onProgress);
}
