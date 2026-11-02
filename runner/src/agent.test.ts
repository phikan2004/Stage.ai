import { describe, expect, it } from "vitest";
import { runBeat, type BeatOptions, type Model } from "./agent.ts";
import type { Driver, Element, View } from "./driver.ts";

const SAVE: Element = { ref: "e1", role: "button", name: "Save", frame: { x: 10, y: 10, width: 100, height: 40 } };
const DELETE: Element = { ref: "e2", role: "button", name: "Delete account", frame: { x: 10, y: 60, width: 100, height: 40 } };

class FakeDriver implements Driver {
  readonly kind = "browser";
  log: string[] = [];
  screen = "screen-1";
  async where() {
    return { app: "Chrome", bundleId: "com.google.Chrome", place: "http://localhost:5173/" };
  }
  async look(): Promise<View> {
    return { ...(await this.where()), shot: { data: "", width: 800, height: 600 }, elements: [SAVE, DELETE], fingerprint: { key: this.screen } };
  }
  async fingerprint() {
    return { key: this.screen };
  }
  async click(_k: string, x: number, y: number) {
    this.log.push(`click ${x},${y}`);
  }
  async drag() {}
  async move() {}
  async scroll() {}
  async type(t: string) {
    this.log.push(`type ${t}`);
  }
  async key(combo: string) {
    this.log.push(`key ${combo}`);
  }
  async open(t: string) {
    this.log.push(`open ${t}`);
  }
  async close() {}
}

const fakeDriver = () => new FakeDriver();

const call = (id: string, name: string, input: unknown, toolset?: string) => ({ type: "tool_use", id, name, input, ...(toolset ? { toolset_name: toolset } : {}) });
const reply = (content: unknown[]) => ({ content, stop_reason: content.some((c: any) => c.type === "tool_use") ? "tool_use" : "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }) as any;
const done = reply([{ type: "text", text: "DONE saved" }]);

function script(...turns: any[]) {
  const seen: any[][] = [];
  const model: Model = {
    async turn(messages) {
      seen.push(structuredClone(messages));
      return turns.shift() ?? done;
    },
  };
  return { model, seen };
}

const options = (driver: Driver, model: Model, over: Partial<BeatOptions> = {}): BeatOptions => ({
  goal: "Save it",
  driver,
  model,
  limits: { apps: ["Chrome"], origins: ["http://localhost:5173"], taughtCommands: [] },
  hold: true,
  release: Promise.resolve(),
  approve: async () => true,
  signal: new AbortController().signal,
  pollMs: 5,
  settleMs: 0,
  ...over,
});

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("prepare and hold", () => {
  it("decides first, and runs nothing until the cue", async () => {
    const d = fakeDriver();
    const { model } = script(reply([call("a", "click_element", { ref: "e1" })]));
    let release = () => {};
    const events: string[] = [];
    const beat = runBeat(options(d, model, { release: new Promise((r) => (release = r)), onEvent: (e) => events.push(e.type) }));
    await tick();
    expect(events).toContain("armed");
    expect(d.log).toEqual([]);
    release();
    const r = await beat;
    expect(d.log).toEqual(["click 60,30"]);
    expect(r.outcome).toBe("done");
    expect(r.prepareMs).not.toBeNull();
    expect(r.cueToActionMs).not.toBeNull();
  });

  it("refuses a held action when the screen changed, and decides again", async () => {
    const d = fakeDriver();
    const { model, seen } = script(reply([call("a", "click_element", { ref: "e1" })]), reply([call("b", "click_element", { ref: "e2" })]));
    let release = () => {};
    const events: string[] = [];
    const beat = runBeat(options(d, model, { release: new Promise((r) => (release = r)), onEvent: (e) => events.push(e.type) }));
    await tick();
    d.screen = "screen-2";
    await tick();
    expect(d.log).toEqual([]);
    expect(events).toContain("replanned");
    release();
    const r = await beat;
    expect(r.replans).toBe(1);
    expect(d.log).toEqual(["click 60,80"]);
    const refused = seen[1].at(-1).content[0];
    expect(refused).toMatchObject({ type: "tool_result", tool_use_id: "a", is_error: true });
  });

  it("re-checks at the cue itself", async () => {
    const d = fakeDriver();
    const { model } = script(reply([call("a", "click_element", { ref: "e1" })]));
    let release = () => {};
    const beat = runBeat(options(d, model, { pollMs: 10_000, release: new Promise((r) => (release = r)) }));
    await tick();
    d.screen = "screen-2";
    release();
    const r = await beat;
    expect(r.replans).toBe(1);
    expect(d.log).toEqual([]);
  });

  it("with hold off, nothing starts until the cue", async () => {
    const d = fakeDriver();
    const { model, seen } = script(reply([call("a", "click_element", { ref: "e1" })]));
    let release = () => {};
    const beat = runBeat(options(d, model, { hold: false, release: new Promise((r) => (release = r)) }));
    await tick();
    expect(seen).toEqual([]);
    release();
    expect((await beat).outcome).toBe("done");
    expect(d.log).toEqual(["click 60,30"]);
  });

  it("stops while holding, and nothing runs", async () => {
    const d = fakeDriver();
    const { model } = script(reply([call("a", "click_element", { ref: "e1" })]));
    const stop = new AbortController();
    const beat = runBeat(options(d, model, { release: new Promise(() => {}), signal: stop.signal }));
    await tick();
    stop.abort();
    expect((await beat).outcome).toBe("stopped");
    expect(d.log).toEqual([]);
  });
});

describe("computer toolset results", () => {
  it("echoes toolset_name, and skips the rest of a batch after a failure", async () => {
    const d = fakeDriver();
    d.click = async () => {
      throw new Error("boom");
    };
    const { model, seen } = script(reply([call("a", "left_click", { coordinate: [5, 5] }, "computer"), call("b", "type", { text: "hi" }, "computer")]));
    await runBeat(options(d, model));
    const [first, second] = seen[1].at(-1).content;
    expect(first).toMatchObject({ toolset_name: "computer", is_error: true, content: "boom" });
    expect(second).toMatchObject({ toolset_name: "computer", is_error: true, content: "Not executed: an earlier computer action in this turn failed." });
    expect(d.log).toEqual([]);
  });
});

describe("limits", () => {
  it("asks before a risky click, at hold time, and a no leaves it undone", async () => {
    const d = fakeDriver();
    const asked: string[] = [];
    const { model } = script(reply([call("a", "click_element", { ref: "e2" })]));
    await runBeat(options(d, model, { approve: async (q) => (asked.push(q), false) }));
    expect(asked).toEqual(['Click "Delete account" in Chrome']);
    expect(d.log).toEqual([]);
  });

  it("stops while waiting for an approval", async () => {
    const d = fakeDriver();
    const stop = new AbortController();
    const { model } = script(reply([call("a", "click_element", { ref: "e2" })]));
    const beat = runBeat(options(d, model, { approve: () => new Promise(() => {}), signal: stop.signal }));
    await tick();
    stop.abort();
    expect((await beat).outcome).toBe("stopped");
    expect(d.log).toEqual([]);
  });

  it("asks about a pixel click that lands on a risky element", async () => {
    const d = fakeDriver();
    const asked: string[] = [];
    const { model } = script(reply([call("a", "left_click", { coordinate: [20, 70] }, "computer")]));
    await runBeat(options(d, model, { approve: async (q) => (asked.push(q), false) }));
    expect(asked).toHaveLength(1);
    expect(d.log).toEqual([]);
  });

  it("refuses a shortcut that leaves the allowed apps", async () => {
    const d = fakeDriver();
    const { model, seen } = script(reply([call("a", "key", { text: "cmd+space" }, "computer")]));
    await runBeat(options(d, model));
    expect(seen[1].at(-1).content[0]).toMatchObject({ is_error: true });
    expect(d.log).toEqual([]);
  });

  it("refuses a url outside the show", async () => {
    const d = fakeDriver();
    const { model } = script(reply([call("a", "open", { target: "https://evil.example" })]));
    await runBeat(options(d, model));
    expect(d.log).toEqual([]);
  });

  it("stops acting on a surface outside the show", async () => {
    const d = fakeDriver();
    d.where = async () => ({ app: "Chrome", bundleId: "com.google.Chrome", place: "https://elsewhere.example/" });
    const { model } = script(reply([call("a", "left_click", { coordinate: [5, 5] }, "computer")]));
    await runBeat(options(d, model));
    expect(d.log).toEqual([]);
  });

  it("gives up at the action limit", async () => {
    const d = fakeDriver();
    const many = reply(Array.from({ length: 3 }, (_, i) => call(`c${i}`, "click_element", { ref: "e1" })));
    const { model } = script(many, many);
    const r = await runBeat(options(d, model, { maxActions: 4 }));
    expect(r.outcome).toBe("stuck");
    expect(d.log).toHaveLength(3);
  });

  it("reports a STUCK reply as stuck", async () => {
    const { model } = script(reply([{ type: "text", text: "STUCK no such button" }]));
    expect((await runBeat(options(fakeDriver(), model))).outcome).toBe("stuck");
  });
});
