import type { Box } from "../../../shared/schema";
import type { SlideImage } from "./pdf";

/** How far a pixel must differ from the background to count as ink. */
const INK_DIFF = 40;
/** Rows of ink this close together belong to one line. */
const MAX_GAP = 0.004;
const MIN_LINE_HEIGHT = 0.008;

const luminance = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

/**
 * Find the lines of text in a block of pixels (RGBA), as fractions of the block. The background is whatever colour runs
 * round its edge, and a line is a band of rows with ink in them. Works on any slide image, so it needs no API call.
 */
export function findLines(rgba: Uint8ClampedArray, width: number, height: number): Box[] {
  const lum = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return luminance(rgba[i], rgba[i + 1], rgba[i + 2]);
  };
  const edge: number[] = [];
  for (let x = 0; x < width; x++) edge.push(lum(x, 0), lum(x, height - 1));
  for (let y = 0; y < height; y++) edge.push(lum(0, y), lum(width - 1, y));
  const background = median(edge);
  const isInk = (x: number, y: number) => Math.abs(lum(x, y) - background) > INK_DIFF;

  const rowHasInk: boolean[] = [];
  for (let y = 0; y < height; y++) {
    let ink = 0;
    for (let x = 0; x < width; x++) if (isInk(x, y)) ink++;
    rowHasInk.push(ink >= 2);
  }

  const maxGap = Math.max(1, Math.round(MAX_GAP * height * 4));
  const bands: [number, number][] = [];
  for (let y = 0; y < height; y++) {
    if (!rowHasInk[y]) continue;
    const last = bands.at(-1);
    if (last && y - last[1] <= maxGap) last[1] = y;
    else bands.push([y, y]);
  }

  const minHeight = Math.max(3, Math.round(MIN_LINE_HEIGHT * height));
  return bands
    .filter(([top, bottom]) => bottom - top + 1 >= minHeight)
    .map(([top, bottom]) => {
      let left = width;
      let right = 0;
      for (let y = top; y <= bottom; y++) {
        for (let x = 0; x < width; x++) {
          if (!isInk(x, y)) continue;
          left = Math.min(left, x);
          right = Math.max(right, x);
        }
      }
      return { x: left / width, y: top / height, w: (right - left + 1) / width, h: (bottom - top + 1) / height };
    });
}

async function crop(img: SlideImage, box: Box) {
  const el = new Image();
  el.src = img.url;
  await el.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(box.w * img.width));
  canvas.height = Math.max(1, Math.round(box.h * img.height));
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(el, box.x * img.width, box.y * img.height, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** Where to draw a highlight: each line of text in the box, in slide fractions, or the whole box if there's none. */
export async function highlightMarks(img: SlideImage, box: Box): Promise<Box[]> {
  const { data, width, height } = await crop(img, box);
  const lines = findLines(data, width, height).map((l) => ({
    x: box.x + l.x * box.w,
    y: box.y + l.y * box.h,
    w: l.w * box.w,
    h: l.h * box.h,
  }));
  return lines.length ? lines : [box];
}

/** The colour around a box, for covering it until a Reveal cue fires. */
export async function surroundingColor(img: SlideImage, box: Box): Promise<string> {
  const { data, width, height } = await crop(img, box);
  const channel = (offset: number) => {
    const values: number[] = [];
    for (let x = 0; x < width; x++) values.push(data[x * 4 + offset], data[(width * (height - 1) + x) * 4 + offset]);
    for (let y = 0; y < height; y++) values.push(data[y * width * 4 + offset], data[(y * width + width - 1) * 4 + offset]);
    return median(values);
  };
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}
