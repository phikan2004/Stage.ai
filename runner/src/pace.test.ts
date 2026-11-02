import { describe, expect, it } from "vitest";
import { actionGapMs, glideMs, keyDelayMs } from "./pace.ts";

describe("pace", () => {
  it("takes longer over longer distances, within limits", () => {
    expect(glideMs(100)).toBeLessThan(glideMs(800));
    expect(glideMs(0)).toBe(320);
    expect(glideMs(50_000)).toBe(1100);
  });

  it("types unevenly, and pauses after punctuation", () => {
    const fixed = () => 0.5;
    expect(keyDelayMs("a", () => 0)).toBeLessThan(keyDelayMs("a", () => 1));
    expect(keyDelayMs(".", fixed)).toBeGreaterThan(keyDelayMs(" ", fixed));
    expect(keyDelayMs(" ", fixed)).toBeGreaterThan(keyDelayMs("a", fixed));
  });

  it("leaves a noticeable gap between actions", () => {
    expect(actionGapMs(() => 0)).toBeGreaterThanOrEqual(450);
  });

  it("scales with STAGE_PACE", () => {
    process.env.STAGE_PACE = "2";
    expect(glideMs(0)).toBe(640);
    delete process.env.STAGE_PACE;
  });
});
