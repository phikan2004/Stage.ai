import { describe, expect, it } from "vitest";
import { CueGate } from "./cueGate.ts";

const isOpen = (p: Promise<void>) => Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false)))]);

describe("CueGate", () => {
  it("keeps every beat closed until its cue", async () => {
    const gate = new CueGate(["a", "b"], () => {});
    expect(await isOpen(gate.released("a"))).toBe(false);
    gate.release("a");
    expect(await isOpen(gate.released("a"))).toBe(true);
    expect(await isOpen(gate.released("b"))).toBe(false);
  });

  it("releases in order and ignores a beat out of turn", async () => {
    const heard: string[] = [];
    const gate = new CueGate(["a", "b"], (id) => heard.push(id));
    gate.release("b");
    expect(heard).toEqual([]);
    expect(await isOpen(gate.released("b"))).toBe(false);
  });

  it("releases each beat once", () => {
    const heard: string[] = [];
    const gate = new CueGate(["a", "b"], (id) => heard.push(id));
    gate.release("a");
    gate.release("a");
    expect(heard).toEqual(["a"]);
  });

  it("keeps a cue that arrives before the beat starts waiting", async () => {
    const gate = new CueGate(["a", "b"], () => {});
    gate.release();
    gate.release();
    expect(await isOpen(gate.released("b"))).toBe(true);
  });

  it("does nothing once every beat is released", () => {
    const heard: string[] = [];
    const gate = new CueGate(["a"], (id) => heard.push(id));
    gate.release();
    gate.release();
    expect(heard).toEqual(["a"]);
  });
});
