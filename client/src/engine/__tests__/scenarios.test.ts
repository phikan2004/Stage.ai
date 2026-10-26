import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import { ZoomDirector } from "../director";
import { REVENUE_SLIDE, USERS_SLIDE } from "./fixtures";

type Line = [t: number, text: string, isFinal?: boolean];

/**
 * End-to-end: scripted transcript → director ticking every 100ms.
 * Returns a compact log like ["1200:in:gross-margin", "6400:out"].
 */
function play(lines: Line[], until: number, opts: { slideChanges?: [number, typeof USERS_SLIDE][] } = {}) {
  const d = new ZoomDirector(DEFAULT_CONFIG);
  d.setSlide(REVENUE_SLIDE, 0);
  const log: string[] = [];
  const queue = [...lines];
  const slides = [...(opts.slideChanges ?? [])];
  for (let now = 0; now <= until; now += 100) {
    while (slides.length && slides[0][0] <= now) {
      const [, regions] = slides.shift()!;
      const a = d.setSlide(regions, now);
      if (a.type === "zoomOut") log.push(`${now}:out:slide`);
    }
    while (queue.length && queue[0][0] <= now) {
      const [t, text, isFinal = true] = queue.shift()!;
      d.hear(text, isFinal, t);
    }
    const { action } = d.tick(now);
    if (action.type === "zoomTo") log.push(`${now}:in:${action.regionId}`);
    if (action.type === "zoomOut") log.push(`${now}:out`);
  }
  return log;
}

describe("scenarios", () => {
  it("clear talk about one region zooms in, then out after silence", () => {
    const log = play(
      [
        [500, "let's talk about gross margin", false],
        [1200, "let's talk about gross margin profitability is way up"],
      ],
      14000,
    );
    expect(log[0]).toMatch(/^\d+:in:gross-margin$/);
    const inAt = Number(log[0].split(":")[0]);
    expect(inAt).toBeLessThanOrEqual(1200);
    // sustained while the words stay in the window, then a 4s timeout
    expect(log[1]).toMatch(/:out$/);
    expect(log).toHaveLength(2);
  });

  it("only a shared word does not zoom (ambiguous)", () => {
    expect(play([[1000, "and revenue, revenue, revenue"]], 5000)).toEqual([]);
  });

  it("small talk never zooms", () => {
    expect(
      play(
        [
          [500, "thanks everyone for joining"],
          [2500, "before we start a quick note on logistics"],
          [4500, "okay let's get into it"],
        ],
        8000,
      ),
    ).toEqual([]);
  });

  it("moving to another region switches only after dwell", () => {
    const log = play(
      [
        [500, "the fourth quarter was a record quarter thanks to holiday"],
        [1500, "and that drove 38 percent growth year over year"],
        [2500, "growth year over year is the headline"],
      ],
      6000,
    );
    expect(log[0]).toMatch(/:in:q4-bar$/);
    const [inAt] = log[0].split(":").map(Number);
    const second = log[1];
    expect(second).toMatch(/:in:yoy-callout$/);
    expect(Number(second.split(":")[0]) - inAt).toBeGreaterThanOrEqual(DEFAULT_CONFIG.minDwellMs);
  });

  it("slide change zooms out immediately and clears the transcript", () => {
    const log = play(
      [[500, "gross margin profitability gross margin"]],
      3000,
      { slideChanges: [[2000, USERS_SLIDE]] },
    );
    expect(log[0]).toMatch(/:in:gross-margin$/);
    expect(log[1]).toBe("2000:out:slide");
    expect(log).toHaveLength(2); // nothing on the new slide was said
  });

  it("stemming and fuzzy matches can drive a zoom", () => {
    const log = play([[500, "our margns and profitabilities improved, lower costs"]], 2000);
    expect(log[0]).toMatch(/:in:gross-margin$/);
  });
});
