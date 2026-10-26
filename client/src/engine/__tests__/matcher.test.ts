import { describe, expect, it } from "vitest";
import { compileRegions, scoreRegions } from "../matcher";
import { TranscriptWindow } from "../transcriptWindow";
import { cfg, REVENUE_SLIDE } from "./fixtures";

const c = cfg();
const compiled = compileRegions(REVENUE_SLIDE, c.labelWeight);

function scoreOf(lines: [number, string, boolean?][], now: number) {
  const w = new TranscriptWindow();
  for (const [t, text, isFinal = true] of lines) w.push(text, isFinal, t);
  const scores = scoreRegions(w.tokens(now, c.windowMs, c.interimWeight), compiled, now, c);
  return Object.fromEntries(scores.map((s) => [s.id, s.score]));
}

describe("matcher", () => {
  it("ranks the region whose keywords were said", () => {
    const s = scoreOf([[1000, "our gross margin improved and profitability is up"]], 1000);
    expect(s["gross-margin"]).toBeGreaterThan(0.45);
    expect(s["gross-margin"]).toBeGreaterThan(s["q4-bar"] + 0.3);
  });

  it("discounts words shared by several regions", () => {
    const shared = scoreOf([[1000, "revenue"]], 1000);
    const unique = scoreOf([[1000, "holiday"]], 1000);
    expect(shared["q4-bar"]).toBeCloseTo(shared["yoy-callout"], 5);
    expect(unique["q4-bar"]).toBeGreaterThan(shared["q4-bar"]);
  });

  it("gives an in-order phrase a bonus over the same words scattered", () => {
    const phrase = scoreOf([[1000, "the fourth quarter"]], 1000);
    const scattered = scoreOf([[1000, "quarter by quarter we're fourth"]], 1000);
    expect(phrase["q4-bar"]).toBeGreaterThan(scattered["q4-bar"]);
  });

  it("weights recent words above old ones", () => {
    const fresh = scoreOf([[5000, "profitability"]], 5000);
    const stale = scoreOf([[0, "profitability"]], 5000);
    expect(fresh["gross-margin"]).toBeGreaterThan(stale["gross-margin"]);
  });

  it("forgets words outside the window", () => {
    const s = scoreOf([[0, "gross margin profitability"]], c.windowMs + 1);
    expect(s["gross-margin"]).toBe(0);
  });

  it("weights interim results below finals", () => {
    const fin = scoreOf([[1000, "profitability", true]], 1000);
    const interim = scoreOf([[1000, "profitability", false]], 1000);
    expect(interim["gross-margin"]).toBeLessThan(fin["gross-margin"]);
    expect(interim["gross-margin"]).toBeGreaterThan(0);
  });

  it("replaces interim text rather than accumulating it", () => {
    const w = new TranscriptWindow();
    w.push("gross", false, 100);
    w.push("gross margin", false, 200);
    w.push("gross margin is up", true, 300);
    expect(w.tokens(300, c.windowMs, c.interimWeight).map((t) => t.stem)).toEqual(["gross", "margin"]);
  });

  it("matches stemmed and misspelled words", () => {
    const s = scoreOf([[1000, "margns and profitabilities"]], 1000);
    expect(s["gross-margin"]).toBeGreaterThan(0.3);
  });
});
