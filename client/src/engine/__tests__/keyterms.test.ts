import { describe, expect, it } from "vitest";
import { keytermsFor } from "../keyterms";
import { REVENUE_SLIDE } from "./fixtures";

describe("keytermsFor", () => {
  it("collects keywords then labels, de-duplicated case-insensitively", () => {
    const terms = keytermsFor(REVENUE_SLIDE);
    expect(terms[0]).toBe("Q4");
    expect(terms.filter((t) => t.toLowerCase() === "revenue")).toHaveLength(1);
    expect(terms).toContain("gross margin");
    expect(terms).toContain("Q4 revenue bar");
  });

  it("respects the term and length caps", () => {
    expect(keytermsFor(REVENUE_SLIDE, 3)).toHaveLength(3);
    expect(keytermsFor(REVENUE_SLIDE, 50, 10).join("").length).toBeLessThanOrEqual(10);
  });
});
