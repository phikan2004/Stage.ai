import type { Box } from "../../../shared/schema";

export interface ZoomTransform {
  /** uniform scale, 1 = full slide */
  scale: number;
  /** translation as a fraction of slide width / height (transform-origin: 0 0) */
  tx: number;
  ty: number;
}

export const IDENTITY: ZoomTransform = { scale: 1, tx: 0, ty: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Transform that centers `box` (fractions of the slide) inside a viewport the
 * same size as the slide. A point p maps to p * scale + t. Translation is
 * clamped so the slide always covers the viewport: never any area outside it.
 */
export function computeZoom(box: Box, padding: number, maxZoom: number): ZoomTransform {
  const w = clamp(box.w + 2 * padding, 1e-6, 1);
  const h = clamp(box.h + 2 * padding, 1e-6, 1);
  const scale = clamp(Math.min(1 / w, 1 / h), 1, Math.max(1, maxZoom));
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const tx = clamp(0.5 - cx * scale, 1 - scale, 0);
  const ty = clamp(0.5 - cy * scale, 1 - scale, 0);
  return { scale, tx: tx || 0, ty: ty || 0 };
}

export function toCss(z: ZoomTransform): string {
  return `translate(${(z.tx * 100).toFixed(4)}%, ${(z.ty * 100).toFixed(4)}%) scale(${z.scale.toFixed(4)})`;
}
