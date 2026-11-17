import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RobotSpeechSource, type Synth, type Utterance } from "../RobotSpeechSource";
import type { SpeechResult } from "../SpeechSource";

/** A stand-in for speechSynthesis that keeps what it was asked to say, for the test to play out. */
function fakeSynth() {
  const spoken: Utterance[] = [];
  const synth: Synth & { spoken: Utterance[] } = {
    spoken,
    speak: (u) => void spoken.push(u),
    cancel: vi.fn(),
    getVoices: () => [
      { name: "Samantha", lang: "en-US", localService: true, default: true },
      { name: "Daniel", lang: "en-GB", localService: true, default: false },
    ],
  };
  const make = (text: string): Utterance => ({ text, rate: 1, pitch: 1, voice: null, onstart: null, onboundary: null, onend: null, onerror: null });
  return { synth, make };
}

function setup() {
  const { synth, make } = fakeSynth();
  const robot = new RobotSpeechSource(synth, make, () => Date.now());
  const heard: SpeechResult[] = [];
  robot.onResult((r) => heard.push(r));
  return { synth, robot, heard };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("RobotSpeechSource", () => {
  it("feeds words as they're spoken, then the whole line as final", async () => {
    const { synth, robot, heard } = setup();
    const done = robot.say(["Revenue grew forty percent"]);
    await vi.advanceTimersByTimeAsync(0);
    const u = synth.spoken[0];
    expect(u.voice?.name).toBe("Samantha");
    u.onstart!();
    u.onboundary!({ name: "word", charIndex: 0, charLength: 7 });
    u.onboundary!({ name: "word", charIndex: 8, charLength: 4 });
    u.onend!();
    expect(await done).toBe(true);
    expect(heard.map((r) => [r.text, r.isFinal])).toEqual([
      ["Revenue", false],
      ["Revenue grew", false],
      ["Revenue grew forty percent", true],
    ]);
  });

  it("speaks lines one after another", async () => {
    const { synth, robot, heard } = setup();
    const done = robot.say(["First line here", "Second line here"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(synth.spoken).toHaveLength(1);
    synth.spoken[0].onend!();
    await vi.advanceTimersByTimeAsync(0);
    expect(synth.spoken).toHaveLength(2);
    synth.spoken[1].onend!();
    expect(await done).toBe(true);
    expect(heard.filter((r) => r.isFinal).map((r) => r.text)).toEqual(["First line here", "Second line here"]);
  });

  it("paces words itself when the voice doesn't report them", async () => {
    const { synth, robot, heard } = setup();
    robot.say(["one two three"]);
    await vi.advanceTimersByTimeAsync(0);
    synth.spoken[0].onstart!();
    await vi.advanceTimersByTimeAsync(2000);
    expect(heard.map((r) => r.text)).toEqual(["one", "one two", "one two three"]);
  });

  it("finishes a line whose end never comes", async () => {
    const { synth, robot, heard } = setup();
    const done = robot.say(["a short line"]);
    await vi.advanceTimersByTimeAsync(0);
    synth.spoken[0].onstart!();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await done).toBe(true);
    expect(heard.at(-1)).toMatchObject({ text: "a short line", isFinal: true });
  });

  it("cancel stops the line and drops what's queued", async () => {
    const { synth, robot, heard } = setup();
    const done = robot.say(["first line", "second line"]);
    await vi.advanceTimersByTimeAsync(0);
    robot.cancel();
    synth.spoken[0].onend!();
    expect(await done).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(synth.spoken).toHaveLength(1);
    expect(heard.filter((r) => r.isFinal)).toEqual([]);
    expect(synth.cancel).toHaveBeenCalled();
  });

  it("speaks again after a cancel", async () => {
    const { synth, robot } = setup();
    robot.say(["old line"]);
    robot.cancel();
    const done = robot.say(["new line"]);
    await vi.advanceTimersByTimeAsync(0);
    synth.spoken.at(-1)!.onend!();
    expect(await done).toBe(true);
    expect(synth.spoken.at(-1)!.text).toBe("new line");
  });

  it("uses the chosen speed, pitch and voice from the next line on", async () => {
    const { synth, robot } = setup();
    robot.say(["first", "second"]);
    await vi.advanceTimersByTimeAsync(0);
    robot.rate = 0.8;
    robot.pitch = 0.9;
    robot.voiceName = "Daniel";
    expect(synth.spoken[0]).toMatchObject({ rate: 1, pitch: 1, voice: { name: "Samantha" } });
    synth.spoken[0].onend!();
    await vi.advanceTimersByTimeAsync(0);
    expect(synth.spoken[1]).toMatchObject({ rate: 0.8, pitch: 0.9, voice: { name: "Daniel" } });
  });
});
