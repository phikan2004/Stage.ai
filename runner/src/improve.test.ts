import { mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Beat } from "../../shared/schema.ts";
import { applyImprovements, cleanImprovements, expireLogs, keepTrace, recentTraces, worthLearning, type DryRunTrace } from "./improve.ts";
import { beatGoal, speechByBeat, traceLine } from "./session.ts";

const beat = (id: string, extra: Partial<Beat> = {}): Beat => ({ id, label: id, goal: `do ${id}`, success: "done", cues: ["open the site"], landmarks: [], notes: "", ...extra });

const trace = (beats: Partial<DryRunTrace["beats"][number]>[], at = 1): DryRunTrace => ({
  showId: "show1",
  at,
  beats: beats.map((b) => ({ beatId: "a", said: [], cued: true, outcome: "done", summary: "", cueToActionMs: null, events: [], ...b })),
});

describe("speechByBeat", () => {
  it("gives each beat what was said since the previous cue", () => {
    const said = [
      { text: "first we open the site", t: 10 },
      { text: "now let's search for shoes", t: 30 },
      { text: "too late", t: 99 },
    ];
    const cued = new Map([
      ["a", 20],
      ["b", 40],
    ]);
    const out = speechByBeat(["a", "b", "c"], said, cued, 0);
    expect(out.get("a")).toEqual(["first we open the site"]);
    expect(out.get("b")).toEqual(["now let's search for shoes"]);
    expect(out.get("c")).toEqual([]);
  });
});

describe("cleanImprovements", () => {
  const beats = [beat("a"), beat("b")];

  it("keeps only cues the presenter actually said, and not ones already known", () => {
    const t = trace([{ beatId: "a", said: ["So let's open the pricing page, shall we"] }]);
    const out = cleanImprovements(beats, [{ id: "a", cues: ["open the pricing page", "invented words here", "Open the site"], lesson: "" }], [t]);
    expect(out).toEqual([{ id: "a", cues: ["open the pricing page"], lesson: null }]);
  });

  it("only takes a lesson for a beat that struggled", () => {
    const passed = trace([{ beatId: "a", outcome: "done" }]);
    expect(cleanImprovements(beats, [{ id: "a", cues: [], lesson: "Use the search box" }], [passed])).toEqual([]);
    const stuck = trace([{ beatId: "a", outcome: "stuck" }]);
    expect(cleanImprovements(beats, [{ id: "a", cues: [], lesson: "Use the search box" }], [stuck])).toEqual([{ id: "a", cues: [], lesson: "Use the search box" }]);
    const replanned = trace([{ beatId: "a", events: ["Replanned: popup"] }]);
    expect(cleanImprovements(beats, [{ id: "a", cues: [], lesson: "Close the cookie popup first" }], [replanned])).toHaveLength(1);
  });

  it("skips repeated lessons and unknown beats", () => {
    const stuck = trace([{ beatId: "a", outcome: "stuck" }]);
    const known = [beat("a", { lessons: ["Use the search box."] })];
    expect(cleanImprovements(known, [{ id: "a", cues: [], lesson: "use the search box" }, { id: "zzz", cues: [], lesson: "x" }], [stuck])).toEqual([]);
  });
});

describe("applyImprovements", () => {
  it("adds cues and lessons without touching the presenter's notes", () => {
    const beats = [beat("a", { notes: "Use Acme", lessons: ["one", "two", "three", "four", "five"] }), beat("b")];
    const out = applyImprovements(beats, [{ id: "a", cues: ["open pricing"], lesson: "six" }]);
    expect(out[0].cues).toEqual(["open the site", "open pricing"]);
    expect(out[0].lessons).toEqual(["two", "three", "four", "five", "six"]);
    expect(out[0].notes).toBe("Use Acme");
    expect(out[1]).toBe(beats[1]);
  });
});

describe("dry-run logs", () => {
  it("are kept, read back newest last, and expire", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stage-logs-"));
    await keepTrace(dir, trace([{}], 1000), 60_000);
    await keepTrace(dir, trace([{}], 2000), 60_000);
    expect((await recentTraces(dir, "show1")).map((t) => t.at)).toEqual([1000, 2000]);

    const old = join(dir, "dry-run-show1-1.json");
    await writeFile(old, "{}");
    const longAgo = new Date(Date.now() - 120_000);
    await utimes(old, longAgo, longAgo);
    expect(await expireLogs(dir, 60_000)).toBe(1);
    expect(await readdir(dir)).toHaveLength(2);
  });

  it("are only worth learning from when something was said or went wrong", () => {
    expect(worthLearning(trace([{ outcome: "done" }]))).toBe(false);
    expect(worthLearning(trace([{ outcome: "stopped" }]))).toBe(false);
    expect(worthLearning(trace([{ said: ["hello"] }]))).toBe(true);
    expect(worthLearning(trace([{ outcome: "stuck" }]))).toBe(true);
  });
});

describe("the operator sees what it learned", () => {
  it("puts lessons in the beat goal and logs moves readably", () => {
    expect(beatGoal(beat("a", { lessons: ["Close the popup first."] }))).toContain("Learned from earlier dry runs: Close the popup first.");
    expect(beatGoal(beat("a"))).not.toContain("Learned");
    expect(traceLine({ type: "replanned", reason: "popup" })).toBe("Replanned: popup");
    expect(traceLine({ type: "looking" })).toBeNull();
  });
});
