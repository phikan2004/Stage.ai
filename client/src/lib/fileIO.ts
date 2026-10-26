import { PRODUCER_FILE_VERSION, ProducerFileSchema, normalizeRegions, type ProducerFile, type Slide } from "../../../shared/schema";

export function buildFile(pdfName: string, pdfHash: string, slides: Slide[]): ProducerFile {
  return { version: PRODUCER_FILE_VERSION, pdfName, pdfHash, slides };
}

export function downloadFile(file: ProducerFile): void {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = file.pdfName.replace(/\.pdf$/i, "") + ".regions.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export interface LoadedRegions {
  file: ProducerFile;
  /** human-readable warnings, e.g. hash or slide-count mismatch */
  warnings: string[];
}

/** Parse + validate a regions file and compare it against the loaded PDF. */
export function parseRegionsFile(text: string, pdfHash: string, slideCount: number): LoadedRegions {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  const parsed = ProducerFileSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Not a Producer regions file: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const file = parsed.data;
  const warnings: string[] = [];
  if (file.pdfHash !== pdfHash) warnings.push(`This regions file was made for a different PDF ("${file.pdfName}"). Boxes may not line up.`);
  if (file.slides.length !== slideCount) warnings.push(`File has ${file.slides.length} slides; the PDF has ${slideCount}.`);
  // Align by index; pad/truncate to the PDF's slide count.
  const slides: Slide[] = Array.from({ length: slideCount }, (_, i) => ({
    index: i,
    regions: normalizeRegions(file.slides.find((s) => s.index === i)?.regions ?? []),
  }));
  return { file: { ...file, slides }, warnings };
}
