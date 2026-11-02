export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const GAP = 10;
const EDGE = 8;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(lo, hi), Math.max(lo, v));

/**
 * Where to put a popup for a box: off its top-right corner when there's room, otherwise the first side that fits,
 * and over the box's corner as a last resort. All coordinates are relative to `area`.
 */
export function placePopup(box: Rect, popup: { w: number; h: number }, area: { w: number; h: number }): { x: number; y: number } {
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  const candidates = [
    { x: right + GAP, y: box.y },
    { x: box.x - popup.w - GAP, y: box.y },
    { x: right - popup.w, y: box.y - popup.h - GAP },
    { x: right - popup.w, y: bottom + GAP },
  ];
  const fits = ({ x, y }: { x: number; y: number }) =>
    x >= EDGE && y >= EDGE && x + popup.w <= area.w - EDGE && y + popup.h <= area.h - EDGE;
  const spot = candidates.find(fits);
  if (spot) return spot;
  return {
    x: clamp(right - popup.w - GAP, EDGE, area.w - popup.w - EDGE),
    y: clamp(box.y + GAP, EDGE, area.h - popup.h - EDGE),
  };
}
