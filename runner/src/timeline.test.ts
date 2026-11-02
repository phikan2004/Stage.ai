import { describe, expect, it } from "vitest";
import { addKey, describeMoment, pickFrames, presenterActed, type Moment } from "./timeline.ts";
import { toPlaybook } from "./learn.ts";
import { beatGoal, showBrief } from "./session.ts";

const key = (text: string, t = 1, app = "Terminal") => ({ kind: "key" as const, t, app, text });
const combo = (c: string, t = 1, app = "Terminal") => ({ kind: "key" as const, t, app, combo: c });

describe("addKey", () => {
  it("joins keystrokes into text, and applies backspace", () => {
    const m: Moment[] = [];
    for (const ch of "npm tesz") addKey(m, key(ch));
    addKey(m, combo("backspace"));
    addKey(m, key("t"));
    expect(m).toEqual([{ t: 1, kind: "typed", app: "Terminal", text: "npm test" }]);
  });

  it("starts a new run after a named key", () => {
    const m: Moment[] = [];
    addKey(m, key("a"));
    addKey(m, combo("enter"));
    addKey(m, key("b"));
    expect(m.map((x) => x.kind)).toEqual(["typed", "key", "typed"]);
  });

  it("records a password field once, and with no content", () => {
    const m: Moment[] = [];
    addKey(m, { kind: "secure", t: 1 });
    addKey(m, { kind: "secure", t: 2 });
    expect(m).toEqual([{ t: 1, kind: "secure" }]);
    expect(describeMoment(m[0], 0)).toContain("not captured");
  });
});

describe("presenterActed", () => {
  it("is false when only a voice and a still screen were recorded", () => {
    expect(presenterActed([{ t: 1, kind: "frame", file: "f.jpg" }, { t: 2, kind: "said", text: "hi" }])).toBe(false);
    expect(presenterActed([{ t: 1, kind: "click", button: "left", app: "Chrome" }])).toBe(true);
  });
});

describe("pickFrames", () => {
  const frames = (n: number): Moment[] => Array.from({ length: n }, (_, i) => ({ t: i, kind: "frame", file: `f${i}.jpg` }));

  it("keeps click frames first, and spreads the rest", () => {
    const moments: Moment[] = [...frames(100), { t: 200, kind: "click", button: "left", app: "A", before: "f50.jpg", after: "f51.jpg" }];
    const kept = pickFrames(moments, 10);
    expect(kept.size).toBe(10);
    expect(kept.has("f50.jpg")).toBe(true);
    expect(kept.has("f51.jpg")).toBe(true);
  });

  it("never goes over the limit", () => {
    const clicks: Moment[] = Array.from({ length: 100 }, (_, i) => ({ t: i, kind: "click", button: "left", app: "A", before: `b${i}.jpg`, after: `a${i}.jpg` }));
    expect(pickFrames(clicks, 10).size).toBeLessThanOrEqual(10);
  });
});

describe("toPlaybook", () => {
  const beat = { label: "Open billing", goal: "g", success: "s", cues: ["billing", "billing"], landmarks: ["f1.jpg", "made-up.jpg"] };

  it("gives unique ids, and drops landmarks that don't exist", () => {
    const { beats } = toPlaybook({ beats: [beat, beat], apps: ["Chrome", "Chrome"], origins: [], commands: [] }, new Set(["f1.jpg"]));
    expect(beats.map((b) => b.id)).toEqual(["open-billing", "open-billing-2"]);
    expect(beats[0].landmarks).toEqual(["f1.jpg"]);
    expect(beats[0].cues).toEqual(["billing"]);
  });

  it("cleans origins", () => {
    const { limits } = toPlaybook({ beats: [beat], apps: [], origins: ["app.example.com/x", "https://a.example/b", "not a url"], commands: [] }, new Set());
    expect(limits.origins).toEqual(["https://app.example.com", "https://a.example"]);
  });
});

describe("what the operator is told", () => {
  const b = { id: "a", label: "Open", goal: "Open it", success: "It's open", cues: [], landmarks: [], notes: "Use Acme" };

  it("includes corrections", () => {
    expect(beatGoal(b)).toContain("Use Acme");
    expect(beatGoal({ ...b, notes: "" })).not.toContain("corrections");
  });

  it("tells the whole story", () => {
    expect(showBrief({ name: "Launch", beats: [b] } as any)).toContain('1. Open: Open it');
  });
});
