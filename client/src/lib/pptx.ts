import { OoxmlError, PptxPresentation } from "@silurus/ooxml/pptx";
import { clampBox, type SlideFacts } from "../../../shared/schema";
import type { SlideImage } from "./pdf";

const MAX_NOTES = 4000;
const MAX_SHAPE_TEXT = 400;
const MAX_SHAPES = 40;

const LOAD_ERRORS: Record<string, string> = {
  encrypted: "This PowerPoint is password-protected. Remove the password in PowerPoint and add it again.",
  "invalid-password": "This PowerPoint is password-protected. Remove the password in PowerPoint and add it again.",
  "unsupported-encryption": "This PowerPoint is password-protected. Remove the password in PowerPoint and add it again.",
  "legacy-binary-format": "Older .ppt files aren't supported. In PowerPoint, use Save As to make a .pptx.",
  "not-ooxml": "That file isn't a valid PowerPoint (.pptx) file.",
};

/** The slide's notes and its text boxes, exactly as authored. Reading these needs no API call. */
async function slideFacts(pres: PptxPresentation, slide: number, width: number, height: number): Promise<SlideFacts> {
  const runs = await pres.collectSlideRuns(slide, width).catch(() => []);
  const shapes = new Map<string, { text: string; x: number; y: number; w: number; h: number }>();
  for (const run of runs) {
    // Text on the master or layout is furniture like footers, not what the slide says.
    if (!run.text.trim() || (run.origin && run.origin !== "slide")) continue;
    const key = run.shapeId ?? `${run.shapeX},${run.shapeY}`;
    const shape = shapes.get(key);
    if (shape) shape.text += run.text;
    else shapes.set(key, { text: run.text, x: run.shapeX, y: run.shapeY, w: run.shapeW, h: run.shapeH });
  }
  return {
    notes: (pres.getNotes(slide) ?? "").trim().slice(0, MAX_NOTES),
    shapes: [...shapes.values()].slice(0, MAX_SHAPES).map(({ text, x, y, w, h }) => ({
      text: text.trim().slice(0, MAX_SHAPE_TEXT),
      box: clampBox({ x: x / width, y: y / height, w: w / width, h: h / height }),
    })),
  };
}

/**
 * Render every visible slide to a JPEG data URL, in the browser. Slides hidden in PowerPoint are left out.
 * Google Fonts supplies metric-compatible stand-ins for Office fonts (Carlito for Calibri), so text wraps as authored.
 */
export async function renderPptx(
  bytes: ArrayBuffer,
  onPage?: (done: number, total: number) => void,
  targetWidth = 1600,
): Promise<SlideImage[]> {
  const pres = await PptxPresentation.load(bytes.slice(0), { mode: "worker", useGoogleFonts: true }).catch((e) => {
    throw new Error((e instanceof OoxmlError && LOAD_ERRORS[e.code]) || "That PowerPoint couldn't be opened.", { cause: e });
  });
  try {
    const visible = Array.from({ length: pres.slideCount }, (_, i) => i).filter((i) => !pres.isHidden(i));
    const out: SlideImage[] = [];
    for (const slide of visible) {
      const bitmap = await pres.renderSlideToBitmap(slide, { width: targetWidth, dpr: 1 });
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
      bitmap.close();
      const facts = await slideFacts(pres, slide, canvas.width, canvas.height);
      out.push({ index: out.length, url: canvas.toDataURL("image/jpeg", 0.88), width: canvas.width, height: canvas.height, facts });
      onPage?.(out.length, visible.length);
    }
    return out;
  } finally {
    pres.destroy();
  }
}
