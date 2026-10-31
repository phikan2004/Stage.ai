import { describe, expect, it } from "vitest";
import type { Region } from "../../../../shared/schema";
import { costUsd, PLANS, planFor } from "../../../../shared/plans";
import { DEFAULT_CONFIG } from "../config";
import { ZoomDirector } from "../director";
import { hasLeadIn } from "../guidance";
import { tuneForSlide } from "../tune";

const box = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 };
const SLIDE: Region[] = [
  {
    id: "q4-bar",
    label: "Q4 record quarter",
    description: "",
    keywords: ["record quarter", "seven million", "fourth quarter"],
    phrases: ["our best quarter ever", "biggest quarter we have had"],
    cue: "outline",
    box,
  },
  {
    id: "margin",
    label: "Gross margin",
    description: "",
    keywords: ["gross margin", "profitability", "sixty one percent"],
    phrases: ["margins improved a lot this year"],
    cue: "zoom",
    box,
  },
];

type Line = [t: number, text: string];

/** Plays lines through the director, returning "t:regionId" for each cue that fires. */
function play(lines: Line[], until: number, regions = SLIDE) {
  const d = new ZoomDirector(DEFAULT_CONFIG);
  d.setSlide(regions, 0);
  const cues: string[] = [];
  const queue = [...lines];
  for (let now = 0; now <= until; now += 100) {
    while (queue.length && queue[0][0] <= now) {
      const [t, text] = queue.shift()!;
      d.hear(text, true, t);
    }
    const { action } = d.tick(now);
    if (action.type === "zoomTo") cues.push(`${now}:${action.regionId}`);
  }
  return cues;
}

describe("guided slides", () => {
  it("doesn't fire while the presenter introduces the slide, even on a planned phrase", () => {
    expect(play([[1000, "this was our best quarter ever and profitability is up"]], 4900)).toEqual([]);
  });

  it("doesn't count what was said during the overview once it ends", () => {
    expect(play([[4500, "our best quarter ever, gross margin profitability"]], 11000)).toEqual([]);
  });

  it("a single keyword isn't enough", () => {
    expect(play([[7000, "and profitability matters here"]], 11000)).toEqual([]);
  });

  it("fires the next step on real evidence", () => {
    expect(play([[7000, "the fourth quarter was a record"]], 9000)[0]).toMatch(/:q4-bar$/);
  });

  it("a lead-in lowers the evidence needed", () => {
    expect(play([[7000, "if you look at the record"]], 9000)[0]).toMatch(/:q4-bar$/);
  });

  it("ignores words for a later step until the presenter gets there", () => {
    expect(play([[7000, "gross margin and profitability"]], 11000)).toEqual([]);
  });

  it("saying a later step's own phrase jumps to it", () => {
    expect(play([[7000, "so margins improved a lot this year"]], 9000)[0]).toMatch(/:margin$/);
  });

  it("moves through the steps in order", () => {
    const cues = play(
      [
        [7000, "the fourth quarter was a record"],
        [16000, "gross margin and profitability improved"],
      ],
      20000,
    );
    expect(cues.map((c) => c.split(":")[1])).toEqual(["q4-bar", "margin"]);
  });

  it("slides with no regions stay quiet", () => {
    expect(play([[7000, "our best quarter ever"]], 9000, [])).toEqual([]);
  });
});

describe("slide timings", () => {
  const region = (w: number, h: number, keywords = ["a", "b", "c"]): Region => ({
    id: "r",
    label: "R",
    description: "",
    keywords,
    cue: "outline",
    box: { x: 0, y: 0, w, h },
  });

  it("gives fuller slides a longer overview, within limits", () => {
    const hold = (n: number) => tuneForSlide(DEFAULT_CONFIG, Array.from({ length: n }, () => region(0.1, 0.1)), null).overviewMs;
    expect(hold(1)).toBe(4000);
    expect(hold(3)).toBe(6000);
    expect(hold(9)).toBe(8000);
  });

  it("keeps big regions up longer", () => {
    const up = (w: number, h: number) => tuneForSlide(DEFAULT_CONFIG, [region(w, h)], null).noMatchTimeoutMs;
    expect(up(0.8, 0.8)).toBeGreaterThan(up(0.1, 0.1));
    expect(up(1, 1)).toBeLessThanOrEqual(8000);
  });

  it("asks for less evidence from a region with little to go on", () => {
    expect(tuneForSlide(DEFAULT_CONFIG, [region(0.2, 0.2)], null).minHits).toBe(2);
    expect(tuneForSlide(DEFAULT_CONFIG, [region(0.2, 0.2, [])], null).minHits).toBe(1);
  });

  it("widens the transcript window for slower speakers", () => {
    const window = (wpm: number | null) => tuneForSlide(DEFAULT_CONFIG, [region(0.2, 0.2)], wpm).windowMs;
    expect(window(100)).toBeGreaterThan(window(null));
    expect(window(200)).toBeLessThan(window(null));
    expect(window(10)).toBeLessThanOrEqual(10000);
  });
});

describe("lead-ins", () => {
  it("recognizes phrases that point the audience somewhere", () => {
    expect(hasLeadIn("so if you look at this chart")).toBe(true);
    expect(hasLeadIn("here you can see the trend")).toBe(true);
    expect(hasLeadIn("thanks everyone for joining")).toBe(false);
  });
});

describe("plans", () => {
  it("premium is the highest quality, and anything unknown gets premium", () => {
    expect(PLANS.premium).toMatchObject({ model: "claude-opus-5-5", director: true });
    expect(PLANS.free).toMatchObject({ model: "claude-sonnet-5-5", director: false });
    expect(planFor("anything").id).toBe("premium");
  });

  it("prices a call from its real token counts", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costUsd("claude-opus-5-5", usage)).toBeCloseTo(6);
    expect(costUsd("claude-sonnet-5-5", usage)).toBeCloseTo(3);
    expect(costUsd("some-future-model", usage)).toBeNull();
  });
});
