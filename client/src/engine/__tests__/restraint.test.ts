import { describe, expect, it } from "vitest";
import type { RegionScore } from "../matcher";
import { decisiveWinner, forceZoomOut, initialRestraint, step, type RestraintState } from "../restraint";
import { cfg } from "./fixtures";

const c = cfg();
const S = (...pairs: [string, number][]): RegionScore[] =>
  pairs.map(([id, score]) => ({ id, score, raw: score })).sort((a, b) => b.score - a.score);

/** Run scripted [t, scores] frames; returns the actions that weren't "none". */
function run(frames: [number, RegionScore[]][], state: RestraintState = initialRestraint()) {
  const log: string[] = [];
  for (const [t, scores] of frames) {
    const r = step(state, scores, t, c);
    state = r.state;
    if (r.action.type === "zoomTo") log.push(`${t}:in:${r.action.regionId}`);
    if (r.action.type === "zoomOut") log.push(`${t}:out`);
  }
  return { log, state };
}

describe("decisiveWinner", () => {
  it("needs both confidence and margin", () => {
    expect(decisiveWinner(S(["a", 0.7], ["b", 0.2]), c)).toBe("a");
    expect(decisiveWinner(S(["a", 0.3], ["b", 0.0]), c)).toBeNull(); // not confident
    expect(decisiveWinner(S(["a", 0.7], ["b", 0.62]), c)).toBeNull(); // ambiguous
  });
});

describe("restraint", () => {
  it("zooms on a clear match", () => {
    expect(run([[0, S(["a", 0.7], ["b", 0.1])]]).log).toEqual(["0:in:a"]);
  });

  it("does not zoom on an ambiguous match", () => {
    const { log, state } = run([
      [0, S(["a", 0.6], ["b", 0.55])],
      [100, S(["a", 0.62], ["b", 0.58])],
    ]);
    expect(log).toEqual([]);
    expect(state.phase).toBe("idle");
  });

  it("blocks switching during dwell, then allows it sooner for a high-confidence competitor", () => {
    // score 0.8 → effectiveDwell ≈ 3000 * (1 - (0.8-0.45)/0.55) ≈ 1091ms
    const { log } = run([
      [0, S(["a", 0.7], ["b", 0.1])],
      [1000, S(["b", 0.8], ["a", 0.2])], // 1000 < 1091ms effective dwell — still blocked
      [1100, S(["b", 0.8], ["a", 0.2])], // 1100 >= 1091ms — switches
      [3000, S(["b", 0.8], ["a", 0.2])],
    ]);
    expect(log).toEqual(["0:in:a", "1100:in:b"]);
  });

  it("bypasses dwell entirely on a trigger phrase", () => {
    const withTrigger: RegionScore[] = [
      { id: "b", score: 0.8, raw: 0.8, trigger: true },
      { id: "a", score: 0.2, raw: 0.2 },
    ];
    const { log } = run([
      [0, S(["a", 0.7], ["b", 0.1])],
      [500, withTrigger], // trigger phrase → effectiveDwell 0ms, switches immediately
    ]);
    expect(log).toEqual(["0:in:a", "500:in:b"]);
  });

  it("stays zoomed while the region keeps being discussed", () => {
    const frames: [number, RegionScore[]][] = [[0, S(["a", 0.7])]];
    for (let t = 500; t <= 10000; t += 500) frames.push([t, S(["a", 0.3])]);
    expect(run(frames).log).toEqual(["0:in:a"]);
  });

  it("zooms out after silence", () => {
    const frames: [number, RegionScore[]][] = [[0, S(["a", 0.7])]];
    for (let t = 100; t <= 5000; t += 100) frames.push([t, S(["a", 0])]);
    expect(run(frames).log).toEqual(["0:in:a", "4000:out"]);
  });

  it("never zooms out before the minimum dwell, even with a short timeout", () => {
    const short = cfg({ noMatchTimeoutMs: 1000 });
    let st = step(initialRestraint(), S(["a", 0.7]), 0, short).state;
    st = step(st, S(["a", 0]), 1500, short).state;
    expect(st.phase).toBe("dwell");
    const r = step(st, S(["a", 0]), 3000, short);
    expect(r.action.type).toBe("zoomOut");
  });

  it("cools down after zooming out, so it doesn't flap", () => {
    const frames: [number, RegionScore[]][] = [[0, S(["a", 0.7])]];
    frames.push([4000, S(["a", 0])]); // out
    frames.push([4400, S(["a", 0.7])]); // in cooldown: ignored
    frames.push([4900, S(["a", 0.7])]); // cooldown over
    expect(run(frames).log).toEqual(["0:in:a", "4000:out", "4900:in:a"]);
  });

  it("zooms out immediately on slide change", () => {
    const zoomed = step(initialRestraint(), S(["a", 0.7]), 0, c).state;
    const r = forceZoomOut(zoomed, "slideChange", 200, c);
    expect(r.action).toEqual({ type: "zoomOut", reason: "slideChange" });
    expect(r.state.phase).toBe("idle");
  });

  it("Esc zooms out and briefly holds off re-zooming", () => {
    const zoomed = step(initialRestraint(), S(["a", 0.7]), 0, c).state;
    const r = forceZoomOut(zoomed, "manual", 1000, c);
    expect(r.action.type).toBe("zoomOut");
    expect(step(r.state, S(["a", 0.9]), 1500, c).action.type).toBe("none");
    expect(step(r.state, S(["a", 0.9]), 2600, c).action.type).toBe("zoomTo");
  });
});
