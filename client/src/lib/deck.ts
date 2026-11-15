import type { Box, Slide } from "../../../shared/schema";
import { api } from "./api";
import { parseRegionsFile } from "./fileIO";
import { deckFormat } from "./format";
import { renderPdf, sha256Hex, type SlideImage } from "./pdf";

/** A deck as the editor and presenter use it: rendered images plus regions. */
export interface Deck {
  name: string;
  hash: string;
  images: SlideImage[];
  slides: Slide[];
}

/* Rendering a deck takes a few seconds, so keep the last few decks' images for this tab. */
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

/** Hosts cap a request at about 4.5 MB, and a whole deck goes up in one. */
const PLAN_REQUEST_BYTES = 3_500_000;

async function shrink(url: string, width: number, height: number): Promise<string> {
  const el = new Image();
  el.src = url;
  await el.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(el, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.6);
}

/** The slide with one area marked in red, so Claude sees exactly what the presenter drew. */
export async function markRegion(img: SlideImage, box: Box, width = 1200): Promise<string> {
  const el = new Image();
  el.src = img.url;
  await el.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.round((width * img.height) / img.width);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#ff0000";
  ctx.lineWidth = 4;
  ctx.strokeRect(box.x * canvas.width, box.y * canvas.height, box.w * canvas.width, box.h * canvas.height);
  return canvas.toDataURL("image/jpeg", 0.8);
}

/** Every slide, small enough to send together for the director pass, which judges slides rather than measuring them. */
export async function planImages(images: SlideImage[]): Promise<string[]> {
  for (let width = 800; ; width = Math.round(width * 0.75)) {
    const out = await Promise.all(images.map((img) => shrink(img.url, width, Math.round((width * img.height) / img.width))));
    if (width < 320 || out.reduce((n, s) => n + s.length, 0) <= PLAN_REQUEST_BYTES) return out;
  }
}

/** Render a stored or newly chosen deck file, whichever format it is. */
export async function renderDeck(bytes: ArrayBuffer, onPage?: (done: number, total: number) => void): Promise<SlideImage[]> {
  const format = deckFormat(bytes);
  if (!format) throw new Error("That file isn't a PDF or a PowerPoint (.pptx) file.");
  if (format === "pdf") return renderPdf(bytes, onPage);
  // The PowerPoint renderer is large, so it only loads for decks that need it.
  const { renderPptx } = await import("./pptx");
  return renderPptx(bytes, onPage);
}

/**
 * Render a PDF or PowerPoint, store it in the matter, and attach regions if a regions file came with it.
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
  const images = await renderDeck(bytes, (done, total) => onProgress(`Rendering slide ${done} of ${total}…`));
  if (images.length === 0) throw new Error("That presentation has no slides to show.");
  // Validate the regions file before uploading anything.
  const loaded = regionsText ? parseRegionsFile(regionsText, hash, images.length) : null;

  onProgress("Saving…");
  const deck = await api.uploadDeck(matterId, name, deckFormat(bytes)!, bytes, hash, images.length);
  cacheImages(deck.id, images);
  await Promise.all([
    loaded && api.patchDeck(deck.id, { slides: loaded.file.slides, analyzed: true }),
    thumbnail(images[0]).then((b) => api.putThumb(deck.id, b)),
  ]);
  if (loaded?.warnings.length) notices.set(deck.id, loaded.warnings);
  return deck.id;
}

/** Split dropped/chosen files into one presentation and an optional regions JSON. */
export async function pickFiles(files: FileList | File[]): Promise<{ deck?: File; regions?: string }> {
  let deck: File | undefined;
  let regions: string | undefined;
  for (const f of Array.from(files)) {
    if (/\.(pdf|pptx)$/i.test(f.name) || f.type === "application/pdf") deck ??= f;
    else if (f.name.toLowerCase().endsWith(".json")) regions = await f.text();
  }
  return { deck, regions };
}

/** Add the bundled sample deck, on its own. */
export async function createSampleMatter(onProgress: (msg: string) => void): Promise<string> {
  onProgress("Loading sample deck…");
  const [pdf, regions] = await Promise.all([
    fetch("/sample/sample.pdf").then((r) => r.arrayBuffer()),
    fetch("/sample/sample.regions.json").then((r) => r.text()),
  ]);
  const matter = await api.createMatter("sample", true);
  return addDeck(matter.id, "sample.pdf", pdf, regions, onProgress);
}
