import { describe, expect, it } from "vitest";
import { similarity, stem, tokenize } from "../text";

describe("text", () => {
  it("drops stopwords and filler", () => {
    expect(tokenize("So, um, if we look at the revenue")).toEqual(["revenu"]);
  });

  it("stems plurals to the same root", () => {
    expect(stem("revenues")).toBe(stem("revenue"));
    expect(stem("margins")).toBe(stem("margin"));
  });

  it("keeps numbers and percentages", () => {
    expect(tokenize("Q4 was up 38% to 2.4M")).toEqual(["q4", "38", "2.4m"]);
  });

  it("fuzzy-matches small misspellings", () => {
    expect(similarity(stem("margn"), stem("margin"))).toBeGreaterThanOrEqual(0.8);
    expect(similarity("recieve", "receive")).toBeGreaterThanOrEqual(0.8);
  });

  it("does not fuzzy-match short words or numbers", () => {
    expect(similarity("cat", "car")).toBe(0);
    expect(similarity("2023", "2024")).toBe(0);
    expect(similarity("churn", "chart")).toBeLessThan(0.8);
  });
});
