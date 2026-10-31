import { describe, expect, it } from "vitest";
import { deckFormat, deckTitle } from "../format";

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe("deckFormat", () => {
  it("identifies files by their contents, not their names", () => {
    expect(deckFormat(bytes("%PDF-1.7 ..."))).toBe("pdf");
    expect(deckFormat(bytes("PK\x03\x04..."))).toBe("pptx");
  });

  it("rejects anything else", () => {
    expect(deckFormat(bytes("hello world"))).toBeNull();
    expect(deckFormat(bytes(""))).toBeNull();
  });
});

describe("deckTitle", () => {
  it("drops PDF and PowerPoint extensions in any case", () => {
    expect(deckTitle("Q3 review.pdf")).toBe("Q3 review");
    expect(deckTitle("Q3 review.PPTX")).toBe("Q3 review");
    expect(deckTitle("v2.1 plan")).toBe("v2.1 plan");
  });
});
