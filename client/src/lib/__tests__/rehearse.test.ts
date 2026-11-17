import { describe, expect, it } from "vitest";
import { applyDeckChanges, applyShowChanges, applyVoice, DEFAULT_VOICE, describeDeckRun, describeVoiceChange, staleHighlights, MAX_REGION_PHRASES, type DeckScript, type ShowScript } from "../../../../shared/rehearse";
import { MAX_BEAT_CUES, MAX_LESSONS, type Beat, type Region, type Slide } from "../../../../shared/schema";

const region = (id: string, extra: Partial<Region> = {}): Region => ({
  id,
  label: id,
  description: "",
  keywords: ["revenue", "growth"],
  box: { x: 0, y: 0, w: 0.5, h: 0.5 },
  cue: "zoom",
  phrases: ["look at revenue growth"],
  ...extra,
});
const slides: Slide[] = [
  { index: 0, regions: [region("chart"), region("table")] },
  { index: 1, regions: [region("quote")] },
];
const script: DeckScript = { slides: [{ slide: 1, lines: ["Hello"] }, { slide: 2, lines: ["Bye"] }] };

describe("applyDeckChanges", () => {
  it("adds phrases without repeats and up to the cap", () => {
    const many = Array.from({ length: 20 }, (_, i) => `distinct phrase number ${i}`);
    const { slides: out, applied } = applyDeckChanges(slides, script, [
      { op: "addPhrases", slide: 1, regionId: "chart", items: ["Look at revenue growth", "the big jump here"] },
      { op: "addPhrases", slide: 1, regionId: "table", items: many },
    ]);
    expect(out[0].regions[0].phrases).toEqual(["look at revenue growth", "the big jump here"]);
    expect(out[0].regions[1].phrases).toHaveLength(MAX_REGION_PHRASES);
    expect(applied).toHaveLength(2);
  });

  it("removes phrases and keywords that matched too early", () => {
    const { slides: out } = applyDeckChanges(slides, script, [{ op: "removePhrases", slide: 1, regionId: "chart", items: ["revenue", "LOOK AT REVENUE GROWTH"] }]);
    expect(out[0].regions[0]).toMatchObject({ keywords: ["growth"], phrases: [] });
  });

  it("changes cues, removes regions and rewrites the robot's lines", () => {
    const { slides: out, script: s } = applyDeckChanges(slides, script, [
      { op: "setCue", slide: 1, regionId: "chart", cue: "spotlight" },
      { op: "removeRegion", slide: 2, regionId: "quote" },
      { op: "setScript", slide: 2, items: ["  A new line.  ", ""] },
    ]);
    expect(out[0].regions[0].cue).toBe("spotlight");
    expect(out[1].regions).toEqual([]);
    expect(s.slides[1]).toEqual({ slide: 2, lines: ["A new line."] });
  });

  it("skips changes to slides or regions that don't exist", () => {
    const { slides: out, applied } = applyDeckChanges(slides, script, [
      { op: "removeRegion", slide: 1, regionId: "nope" },
      { op: "setCue", slide: 9, regionId: "chart", cue: "zoom" },
      { op: "setScript", slide: 9, items: ["x"] },
    ]);
    expect(out).toBe(slides);
    expect(applied).toEqual([]);
  });
});

describe("describeDeckRun", () => {
  it("shows what was said before each cue fired", () => {
    const text = describeDeckRun(
      [
        { t: 0, type: "slide", slide: 0 },
        { t: 1200, type: "heard", slide: 0, text: "revenue is up", simulated: true },
        { t: 1500, type: "zoom", slide: 0, regionId: "chart", label: "Chart", cue: "zoom", latencyMs: 300 },
      ],
      () => "Revenue chart",
    );
    expect(text).toContain('robot said: "revenue is up"');
    expect(text).toContain("cue fired: Revenue chart [chart] (zoom), 300 ms after the last words");
  });
});

const beat = (id: string): Beat => ({ id, label: id, goal: "Open it", success: "It's open", cues: ["open the report"], landmarks: [], notes: "Use Acme", lessons: [] });
const beats = [beat("open"), beat("filter")];
const showScript: ShowScript = { beats: [{ beatId: "open", lines: ["Let's open the report"] }, { beatId: "filter", lines: ["Now Europe"] }] };

describe("applyShowChanges", () => {
  it("edits trigger words, notes and lessons within their caps", () => {
    const lessons = Array.from({ length: 8 }, (_, i) => ({ op: "addLesson" as const, beatId: "open", text: `lesson ${i}` }));
    const { beats: out, applied } = applyShowChanges(beats, showScript, [
      { op: "addCues", beatId: "open", items: ["Open The Report", "pull up the numbers", ...Array.from({ length: 20 }, (_, i) => `cue ${i}`)] },
      { op: "removeCues", beatId: "filter", items: ["open the report"] },
      { op: "setNotes", beatId: "filter", text: " Use Acme, Europe only " },
      ...lessons,
    ]);
    expect(out[0].cues[0]).toBe("open the report");
    expect(out[0].cues[1]).toBe("pull up the numbers");
    expect(out[0].cues).toHaveLength(MAX_BEAT_CUES);
    expect(out[0].lessons).toHaveLength(MAX_LESSONS);
    expect(out[0].lessons!.at(-1)).toBe("lesson 7");
    expect(out[1]).toMatchObject({ cues: [], notes: "Use Acme, Europe only" });
    expect(applied).toHaveLength(3 + lessons.length);
  });

  it("rewrites the robot's lines in beat order, and ignores unknown beats", () => {
    const { script: s, applied } = applyShowChanges(beats, { beats: [showScript.beats[1]] }, [
      { op: "setScript", beatId: "open", items: ["Fresh opener"] },
      { op: "setGoal", beatId: "ghost", text: "anything" },
    ]);
    expect(s.beats.map((b) => b.beatId)).toEqual(["open", "filter"]);
    expect(applied).toHaveLength(1);
  });

  it("has no way to touch the demo's limits", () => {
    const { beats: out } = applyShowChanges(beats, showScript, [{ op: "limits" as any, beatId: "open", items: ["Terminal"] } as any]);
    expect(out).toEqual(beats);
  });
});

describe("applyVoice", () => {
  const voices = ["Samantha", "Daniel"];
  it("keeps speed and pitch in range, rounded", () => {
    expect(applyVoice(DEFAULT_VOICE, { rate: 0.8333, pitch: 9 }, voices)).toEqual({ rate: 0.83, pitch: 1.5, voice: null });
    expect(applyVoice(DEFAULT_VOICE, { rate: 0.1 }, voices).rate).toBe(0.6);
  });
  it("switches only to a voice this browser has", () => {
    expect(applyVoice(DEFAULT_VOICE, { voice: "Daniel" }, voices).voice).toBe("Daniel");
    expect(applyVoice({ ...DEFAULT_VOICE, voice: "Daniel" }, { voice: "Made Up" }, voices).voice).toBe("Daniel");
  });
  it("leaves the voice alone when there's no change, and says what changed when there is", () => {
    expect(applyVoice(DEFAULT_VOICE, null, voices)).toBe(DEFAULT_VOICE);
    expect(describeVoiceChange(DEFAULT_VOICE, DEFAULT_VOICE)).toBeNull();
    expect(describeVoiceChange(DEFAULT_VOICE, { rate: 0.9, pitch: 1, voice: "Daniel" })).toBe("Robot's voice: speed 1× → 0.9×, voice Daniel");
  });
});

describe("cue chat edits", () => {
  const box = { x: 0.6, y: 0.2, w: 0.3, h: 0.2 };
  it("adds a region with a unique id and its own words", () => {
    const { slides: out, applied } = applyDeckChanges(slides, script, [
      { op: "addRegion", slide: 1, label: "Chart", cue: "spotlight", box, description: "The margin box", keywords: ["61 percent", " "], phrases: ["look at margin"] },
    ]);
    const added = out[0].regions.at(-1)!;
    expect(added).toMatchObject({ id: "chart-2", label: "Chart", cue: "spotlight", keywords: ["61 percent"], phrases: ["look at margin"], box });
    expect(applied).toHaveLength(1);
  });

  it("refuses a box that isn't on the slide", () => {
    const { applied } = applyDeckChanges(slides, script, [
      { op: "addRegion", slide: 1, label: "Ghost", cue: "zoom", box: { x: 1.4, y: 0, w: 0.2, h: 0.2 }, description: "", keywords: [], phrases: [] },
      { op: "setBox", slide: 1, regionId: "chart", box: { x: 0, y: 0, w: 0, h: 0 } },
    ]);
    expect(applied).toEqual([]);
  });

  it("moves, renames and reorders", () => {
    const { slides: out } = applyDeckChanges(slides, script, [
      { op: "setBox", slide: 1, regionId: "table", box },
      { op: "setLabel", slide: 1, regionId: "table", text: " Regional table " },
      { op: "setOrder", slide: 1, items: ["table", "chart"] },
    ]);
    expect(out[0].regions.map((r) => r.id)).toEqual(["table", "chart"]);
    expect(out[0].regions[0]).toMatchObject({ label: "Regional table", box });
  });

  it("places a cue added in the same answer", () => {
    const { slides: out } = applyDeckChanges(slides, script, [
      { op: "setOrder", slide: 1, items: ["chart", "q3-revenue", "table"] },
      { op: "addRegion", slide: 1, label: "Q3 revenue", cue: "outline", box, description: "", keywords: [], phrases: [] },
    ]);
    expect(out[0].regions.map((r) => r.id)).toEqual(["chart", "q3-revenue", "table"]);
  });

  it("finds highlights whose lines need working out again", () => {
    const { slides: out } = applyDeckChanges(slides, script, [
      { op: "setCue", slide: 1, regionId: "chart", cue: "highlight" },
      { op: "addRegion", slide: 2, label: "Quote line", cue: "highlight", box, description: "", keywords: [], phrases: [] },
    ]);
    expect(staleHighlights(slides, out)).toEqual([
      { slide: 0, regionId: "chart" },
      { slide: 1, regionId: "quote-line" },
    ]);
    expect(staleHighlights(out, out)).toEqual([]);
  });
});
