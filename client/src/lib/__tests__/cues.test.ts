import { describe, expect, it } from "vitest";
import { CUE_EFFORT } from "../../../../shared/plans";
import { CueSchema } from "../../../../shared/schema";
import { arrowFor, calloutBelow, CUES, CUE_PAST_TENSE } from "../cues";
import { findLines } from "../textLines";

/** A white block with dark rectangles on it, as RGBA. */
function page(width: number, height: number, inks: [x: number, y: number, w: number, h: number][], paper = 255, ink = 20) {
  const px = new Uint8ClampedArray(width * height * 4).fill(255);
  const paint = (x: number, y: number, v: number) => {
    const i = (y * width + x) * 4;
    px[i] = px[i + 1] = px[i + 2] = v;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) paint(x, y, paper);
  for (const [ix, iy, w, h] of inks) for (let y = iy; y < iy + h; y++) for (let x = ix; x < ix + w; x++) paint(x, y, ink);
  return px;
}

describe("cue types", () => {
  it("every cue has a name, a timeline verb and an analysis depth", () => {
    for (const cue of CueSchema.options) {
      expect(CUES.some(([c]) => c === cue)).toBe(true);
      expect(CUE_PAST_TENSE[cue]).toBeTruthy();
      expect(CUE_EFFORT[cue]).toBeTruthy();
    }
  });

  it("cues that only need naming think less than ones the audience studies", () => {
    expect(CUE_EFFORT.outline).toBe("low");
    expect(CUE_EFFORT.zoom).toBe("medium");
  });
});

describe("findLines", () => {
  it("finds each line of text and how wide it is", () => {
    const lines = findLines(page(400, 200, [[20, 20, 300, 14], [20, 60, 200, 14], [20, 100, 340, 14]]), 400, 200);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ x: 0.05, y: 0.1 });
    expect(lines[0].w).toBeCloseTo(0.75);
    expect(lines[1].w).toBeCloseTo(0.5);
  });

  it("works on a dark background", () => {
    expect(findLines(page(400, 200, [[20, 40, 300, 14]], 30, 240), 400, 200)).toHaveLength(1);
  });

  it("keeps a line whole when its letters have gaps between rows", () => {
    expect(findLines(page(400, 200, [[20, 40, 300, 6], [20, 47, 300, 6]]), 400, 200)).toHaveLength(1);
  });

  it("finds nothing in an empty block", () => {
    expect(findLines(page(100, 100, []), 100, 100)).toEqual([]);
  });

  it("ignores specks", () => {
    expect(findLines(page(400, 400, [[10, 10, 2, 1]]), 400, 400)).toEqual([]);
  });
});

describe("arrowFor", () => {
  it("comes from the side with the most room and stops short of the box", () => {
    const box = { x: 0.7, y: 0.4, w: 0.2, h: 0.2 };
    const { from, to } = arrowFor(box);
    expect(from.x).toBeLessThan(to.x);
    expect(to.x).toBeLessThan(box.x);
    expect(to.y).toBeCloseTo(0.5);
  });

  it("stays on the slide for a box that fills most of it", () => {
    const { from } = arrowFor({ x: 0.02, y: 0.02, w: 0.96, h: 0.9 });
    expect(from.x).toBeGreaterThanOrEqual(0);
    expect(from.y).toBeLessThanOrEqual(1);
  });
});

describe("callouts", () => {
  it("goes below a box at the top of the slide", () => {
    expect(calloutBelow({ x: 0.2, y: 0.03, w: 0.3, h: 0.2 })).toBe(true);
    expect(calloutBelow({ x: 0.2, y: 0.5, w: 0.3, h: 0.2 })).toBe(false);
  });
});
