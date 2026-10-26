import { describe, expect, it } from "vitest";
import { parseCommand } from "../commands";

describe("parseCommand", () => {
  it.each([
    ["Next slide.", { type: "next" }],
    ["next slide please", { type: "next" }],
    ["Okay, next slide.", { type: "next" }],
    ["Let's go to the next slide.", { type: "next" }],
    ["Move on.", { type: "next" }],
    ["Next.", { type: "next" }],
    ["Next one.", { type: "next" }],
    ["Previous one, please.", { type: "prev" }],
    ["Go back.", { type: "prev" }],
    ["Previous slide.", { type: "prev" }],
    ["Back one slide.", { type: "prev" }],
    ["Can we go back to the previous slide?", { type: "prev" }],
    ["Go back to the last slide.", { type: "prev" }],
    ["Go to slide 3.", { type: "goto", slide: 3 }],
    ["Go to slide three.", { type: "goto", slide: 3 }],
    ["slide number two", { type: "goto", slide: 2 }],
    ["Jump to slide 12", { type: "goto", slide: 12 }],
    ["Back to the beginning.", { type: "first" }],
    ["First slide.", { type: "first" }],
    ["Last slide.", { type: "last" }],
    ["Zoom out.", { type: "zoomOut" }],
    ["Show the whole slide.", { type: "zoomOut" }],
  ])("%s", (said, expected) => {
    expect(parseCommand(said)).toEqual(expected);
  });

  it("finds a command spoken as its own sentence after other talk", () => {
    expect(parseCommand("And that's where Q4 landed. Next slide.")).toEqual({ type: "next" });
  });

  it("the latest command wins", () => {
    expect(parseCommand("Go back. Actually no. Next slide.")).toEqual({ type: "next" });
  });

  it.each([
    "On the next slide you'll see our margins.",
    "We'll come back to this later.",
    "The previous quarter was weaker.",
    "Our next big launch is in March.",
    "This slide shows revenue by quarter.",
    "Going back to what I said about churn",
    "The first slide covered revenue",
    "and next quarter we expect more growth",
  ])("ignores normal talk: %s", (said) => {
    expect(parseCommand(said)).toBeNull();
  });
});
