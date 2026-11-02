import * as pdfjs from "pdfjs-dist";
import type { SlideFacts } from "../../../shared/schema";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface SlideImage {
  /** what a PowerPoint file states about the slide; PDFs don't have this */
  facts?: SlideFacts;
  index: number;
  /** JPEG data URL, ~1600px wide */
  url: string;
  width: number;
  height: number;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Render every page to a JPEG data URL. Calls onPage as each page finishes. */
export async function renderPdf(
  bytes: ArrayBuffer,
  onPage?: (done: number, total: number) => void,
  targetWidth = 1600,
): Promise<SlideImage[]> {
  // pdf.js transfers (detaches) the buffer it's given, so hand it a copy.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) });
  const doc = await task.promise;
  const out: SlideImage[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: targetWidth / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvas, viewport }).promise;
    out.push({ index: i - 1, url: canvas.toDataURL("image/jpeg", 0.88), width: canvas.width, height: canvas.height });
    page.cleanup();
    onPage?.(i, doc.numPages);
  }
  await task.destroy();
  return out;
}
