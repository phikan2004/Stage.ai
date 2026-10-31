import { OoxmlError, PptxPresentation } from "@silurus/ooxml/pptx";
import type { SlideImage } from "./pdf";

const LOAD_ERRORS: Record<string, string> = {
  encrypted: "This PowerPoint is password-protected. Remove the password in PowerPoint and add it again.",
  "invalid-password": "This PowerPoint is password-protected. Remove the password in PowerPoint and add it again.",
  "unsupported-encryption": "This PowerPoint is password-protected. Remove the password in PowerPoint and add it again.",
  "legacy-binary-format": "Older .ppt files aren't supported. In PowerPoint, use Save As to make a .pptx.",
  "not-ooxml": "That file isn't a valid PowerPoint (.pptx) file.",
};

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
      out.push({ index: out.length, url: canvas.toDataURL("image/jpeg", 0.88), width: canvas.width, height: canvas.height });
      onPage?.(out.length, visible.length);
    }
    return out;
  } finally {
    pres.destroy();
  }
}
