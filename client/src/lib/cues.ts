import type { Box, Cue } from "../../../shared/schema";

/** Every cue, in the order the popup offers them. */
export const CUES: [Cue, string][] = [
  ["outline", "Outline"],
  ["spotlight", "Spotlight"],
  ["zoom", "Zoom"],
  ["highlight", "Highlight"],
  ["callout", "Callout"],
  ["arrow", "Arrow"],
  ["reveal", "Reveal"],
];

/** How a cue reads in a run's timeline. */
export const CUE_PAST_TENSE: Record<Cue, string> = {
  outline: "Outlined",
  spotlight: "Spotlit",
  zoom: "Zoomed to",
  highlight: "Highlighted",
  callout: "Called out",
  arrow: "Pointed to",
  reveal: "Revealed",
};

const ARROW_LENGTH = 0.13;
const GAP = 0.012;

export interface Point {
  x: number;
  y: number;
}

/** An arrow pointing at a box from the side with the most room, in slide fractions, staying on the slide. */
export function arrowFor(box: Box): { from: Point; to: Point } {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const sides = [
    { room: box.x, to: { x: box.x - GAP, y: cy }, dx: -1, dy: 0 },
    { room: 1 - box.x - box.w, to: { x: box.x + box.w + GAP, y: cy }, dx: 1, dy: 0 },
    { room: box.y, to: { x: cx, y: box.y - GAP }, dx: 0, dy: -1 },
    { room: 1 - box.y - box.h, to: { x: cx, y: box.y + box.h + GAP }, dx: 0, dy: 1 },
  ];
  const side = sides.reduce((a, b) => (b.room > a.room ? b : a));
  const length = Math.min(ARROW_LENGTH, Math.max(0, side.room - GAP * 2));
  return { to: side.to, from: { x: side.to.x + side.dx * length, y: side.to.y + side.dy * length } };
}

/** Which side of a box a callout's label goes on: above unless that would leave the slide. */
export const calloutBelow = (box: Box) => box.y < 0.12;
