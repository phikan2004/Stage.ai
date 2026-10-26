import { describe, expect, it } from "vitest";
import { ProducerFileSchema, type Region } from "../../../../shared/schema";
import { DEFAULT_CONFIG } from "../config";
import { ZoomDirector } from "../director";
import { normalizeSpoken, tokenize } from "../text";
import sample from "../../../public/sample/sample.regions.json";

/** Natural phrases against the real sample deck, the way a presenter would say them. */
const deck = ProducerFileSchema.parse(sample);
const slide = (i: number): Region[] => deck.slides[i].regions;

/** Say one phrase (final result) on a slide; return the region it zooms to within 1s, or null. */
function zoomFor(regions: Region[], phrase: string): string | null {
  const d = new ZoomDirector(DEFAULT_CONFIG);
  d.setSlide(regions, 0);
  d.hear(phrase, true, 100);
  for (let now = 100; now <= 1100; now += 100) {
    const { action } = d.tick(now);
    if (action.type === "zoomTo") return action.regionId;
  }
  return null;
}

describe("spoken-form normalization", () => {
  it.each([
    ["let's look at Q1", "q1"],
    ["let's look at Q 1", "q1"],
    ["let's look at queue one", "q1"],
    ["cue four was huge", "q4"],
    ["quarter four", "q4"],
    ["seven point three million", "7.3"],
    ["thirty eight percent", "38"],
    ["twenty-four percent", "24"],
  ])("%s → contains %s", (spoken, token) => {
    expect(tokenize(spoken)).toContain(token);
  });

  it("leaves ordinary words alone", () => {
    expect(normalizeSpoken("the cue cards are queued")).toBe("the cue cards are queued");
  });
});

describe("sample deck: one clear reference is enough to zoom", () => {
  it.each([
    [0, "let's look at Q1", "q1-bar"],
    [0, "let's look at queue one", "q1-bar"],
    [0, "now Q4", "q4-bar"],
    [0, "the holiday quarter", "q4-bar"],
    [0, "we grew 38 percent year over year", "yoy-growth"],
    [0, "gross margin is up", "gross-margin"],
    [1, "notice the churn dip in March", "churn-dip"],
    [1, "we peaked at 2.4 million", "peak-users"],
    [1, "retention held at 87 percent", "retention"],
    [2, "Europe grew thirty one percent", "europe"],
    [2, "APAC was the fastest growing region", "apac-growth"],
  ])("slide %i: %s → %s", (i, phrase, expected) => {
    expect(zoomFor(slide(i), phrase)).toBe(expected);
  });
});

describe("sample deck: restraint still holds", () => {
  it.each([
    [0, "thanks everyone for joining today"],
    [0, "okay so let's get into it"],
    [0, "revenue"], // shared by several regions: ambiguous
    [1, "let's move on"],
  ])("slide %i: %s → no zoom", (i, phrase) => {
    expect(zoomFor(slide(i), phrase)).toBeNull();
  });
});

describe("sample deck: reacts to draft (interim) results, before the sentence ends", () => {
  /** Ms from hearing an interim-only phrase to the zoom, or null if it never zooms. */
  function interimLatency(regions: Region[], phrase: string): number | null {
    const d = new ZoomDirector(DEFAULT_CONFIG);
    d.setSlide(regions, 0);
    d.hear(phrase, false, 100);
    for (let now = 100; now <= 2100; now += 100) {
      if (d.tick(now).action.type === "zoomTo") return now - 100;
    }
    return null;
  }

  it.each([
    [0, "let's look at Q1"],
    [0, "and Q4 was"],
    [1, "the churn dip"],
  ])("slide %i: interim %s zooms on the next tick", (i, phrase) => {
    expect(interimLatency(slide(i), phrase)).toBe(0);
  });

  it("an interim shared word still doesn't zoom", () => {
    expect(interimLatency(slide(0), "revenue")).toBeNull();
  });
});
