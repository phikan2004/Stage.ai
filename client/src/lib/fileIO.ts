import { ProducerFileSchema, normalizeRegions, type ProducerFile, type Slide } from "../../../shared/schema";

export interface LoadedRegions {
  file: ProducerFile;
  /** human-readable warnings, e.g. hash or slide-count mismatch */
  warnings: string[];
}

/** Parse + validate a regions file and compare it against the loaded deck. */
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
  if (file.pdfHash !== pdfHash) warnings.push(`This regions file was made for a different presentation ("${file.pdfName}"). Boxes may not line up.`);
  if (file.slides.length !== slideCount) warnings.push(`File has ${file.slides.length} slides; the presentation has ${slideCount}.`);
  // Align by index; pad/truncate to the deck's slide count.
  const slides: Slide[] = Array.from({ length: slideCount }, (_, i) => ({
    index: i,
    regions: normalizeRegions(file.slides.find((s) => s.index === i)?.regions ?? []),
  }));
  return { file: { ...file, slides }, warnings };
}
