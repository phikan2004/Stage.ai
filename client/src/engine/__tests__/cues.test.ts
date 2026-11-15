import { describe, expect, it } from "vitest";
import { CueDirector, type CueBeat } from "../cues";

const BEATS: CueBeat[] = [
  { id: "open", label: "Open the dashboard", cues: ["open the dashboard", "revenue overview"] },
  { id: "filter", label: "Filter to Europe", cues: ["filter down to Europe", "just the European numbers"] },
  { id: "report", label: "Growth report", cues: ["growth report", "quarter over quarter"] },
];

/** Something said, or a beat finishing on the runner. */
type Line = [t: number, text: string, isFinal?: boolean] | [t: number, event: { done: string }];

/** Scripted speech with the director ticking every 100 ms. Returns "time:beat" for each release. */
function play(lines: Line[], until: number, beats = BEATS) {
  const d = new CueDirector(beats);
  const queue = [...lines];
  const fired: string[] = [];
  for (let now = 0; now <= until; now += 100) {
    while (queue.length && queue[0][0] <= now) {
      const [t, what, isFinal = true] = queue.shift()!;
      if (typeof what === "string") d.hear(what, isFinal, t);
      else d.done(what.done, t);
    }
    const beat = d.tick(now);
    if (beat) fired.push(`${now}:${beat}`);
  }
  return fired;
}

const ids = (fired: string[]) => fired.map((f) => f.split(":")[1]);

describe("CueDirector", () => {
  it("fires each beat in order as the presenter reaches it", () => {
    const fired = play(
      [
        [500, "let's open the dashboard"],
        [8000, "now we can filter down to Europe"],
        [16000, "and here's the growth report"],
      ],
      20000,
    );
    expect(ids(fired)).toEqual(["open", "filter", "report"]);
  });

  it("stays quiet through normal talk", () => {
    expect(play([[500, "thanks for having me today, I'll walk you through what we built this year"]], 8000)).toEqual([]);
  });

  it("doesn't jump ahead when a later beat's words come first", () => {
    expect(play([[500, "the growth report is what most customers ask about"]], 8000)).toEqual([]);
  });

  it("isn't set off by one word of a cue", () => {
    expect(play([[500, "the dashboard is new this year"]], 8000)).toEqual([]);
  });

  it("fires on two of the beat's own words without the full phrase", () => {
    const beats: CueBeat[] = [{ id: "a", label: "Run", cues: ["kubernetes", "rollout"] }];
    expect(ids(play([[500, "this kubernetes rollout is the interesting part"]], 3000, beats))).toEqual(["a"]);
  });

  it("can still fire a beat with a single cue word", () => {
    const beats: CueBeat[] = [{ id: "a", label: "Run", cues: ["kubernetes"] }];
    expect(ids(play([[500, "kubernetes"]], 3000, beats))).toEqual(["a"]);
  });

  it("listens for the label when a beat has no cues", () => {
    const beats: CueBeat[] = [{ id: "a", label: "Open billing page", cues: [] }];
    expect(ids(play([[500, "let's open the billing page"]], 3000, beats))).toEqual(["a"]);
  });

  it("fires from interim words, before the sentence ends", () => {
    const fired = play([[500, "let's open the dashboard", false]], 2000);
    expect(ids(fired)).toEqual(["open"]);
    expect(Number(fired[0].split(":")[0])).toBeLessThanOrEqual(700);
  });

  it("fires once when the engine resends the same words", () => {
    const fired = play(
      [
        [500, "let's open the dashboard", false],
        [800, "let's open the dashboard and", false],
        [1100, "let's open the dashboard and look", true],
      ],
      5000,
    );
    expect(ids(fired)).toEqual(["open"]);
  });

  it("doesn't carry the words that fired one beat into the next", () => {
    const beats: CueBeat[] = [
      { id: "a", label: "A", cues: ["open the dashboard"] },
      { id: "b", label: "B", cues: ["open the dashboard again"] },
    ];
    expect(ids(play([[500, "let's open the dashboard", false], [900, "let's open the dashboard", true]], 5000, beats))).toEqual(["a"]);
  });

  it("hears the very next sentence after a cue that ended cleanly", () => {
    expect(ids(play([[500, "let's open the dashboard"], [3000, "now filter down to Europe"]], 6000))).toEqual(["open", "filter"]);
  });

  it("forgets words after the window passes", () => {
    const fired = play(
      [
        [500, "kubernetes"],
        [15000, "rollout"],
      ],
      20000,
      [{ id: "a", label: "A", cues: ["kubernetes", "rollout"] }],
    );
    expect(fired).toEqual([]);
  });

  it("moves on when the presenter reaches a beat another way", () => {
    const d = new CueDirector(BEATS);
    d.passed("open");
    expect(d.next?.id).toBe("filter");
    d.passed("open");
    expect(d.next?.id).toBe("filter");
    d.hear("filter down to Europe", true, 0);
    expect(d.tick(100)).toBe("filter");
  });

  it("is done after the last beat", () => {
    const d = new CueDirector(BEATS.slice(0, 1));
    d.passed("open");
    expect(d.next).toBeNull();
    d.hear("open the dashboard", true, 0);
    expect(d.tick(100)).toBeNull();
  });

  describe("once the demo is flowing", () => {
    const at = (fired: string[], beat: string) => Number(fired.find((f) => f.endsWith(`:${beat}`))?.split(":")[0]);
    const opened: Line[] = [
      [500, "let's open the dashboard"],
      [2000, { done: "open" }],
    ];

    it("runs the next step when the presenter finishes their thought", () => {
      const fired = play([...opened, [2500, "so this is what everyone sees first thing in the morning"]], 8000);
      expect(ids(fired)).toEqual(["open", "filter"]);
      expect(at(fired, "filter")).toBe(2500 + 1500);
    });

    it("waits while the presenter is still talking", () => {
      const talking: Line[] = [2500, 3000, 3500, 4000, 4500, 5000].map((t) => [t, "so this is what everyone sees first", false]);
      const fired = play([...opened, ...talking, [5500, "so this is what everyone sees first thing", true]], 10000);
      expect(at(fired, "filter")).toBe(5500 + 1500);
    });

    it("carries on by itself when the presenter says nothing", () => {
      expect(at(play(opened, 8000), "filter")).toBe(2000 + 3000);
    });

    it("holds when asked, until told to go on", () => {
      const fired = play([...opened, [2200, "hold on"], [10000, "okay go ahead"]], 12000);
      expect(at(fired, "filter")).toBe(10000);
    });

    it("isn't held by the word wait inside a sentence", () => {
      expect(at(play([...opened, [2200, "I can't wait to show you this part of the product"]], 8000), "filter")).toBe(2200 + 1500);
    });

    it("moves on as soon as the presenter mentions the next step", () => {
      expect(at(play([...opened, [2300, "and now Europe"]], 8000), "filter")).toBe(2300);
    });

    it("moves on right away on next", () => {
      expect(at(play([...opened, [2300, "next"]], 8000), "filter")).toBe(2300);
    });

    it("never moves on while the step before is still running", () => {
      expect(ids(play([[500, "let's open the dashboard"]], 12000))).toEqual(["open"]);
    });
  });
});
