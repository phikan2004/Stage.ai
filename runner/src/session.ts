import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Beat, type BeatResult, type Show } from "../../shared/schema.ts";
import { runBeat, type ContentParam } from "./agent.ts";
import { DesktopDriver } from "./desktopDriver.ts";
import type { Display, Helper } from "./helper.ts";
import { learn } from "./learn.ts";
import { claudeModel } from "./model.ts";
import { actionGapMs, beatGapMs } from "./pace.ts";
import { Recorder } from "./recorder.ts";
import { presenterActed } from "./timeline.ts";
import type { Limits } from "./safety.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const SAFE_PATH = /^[A-Za-z0-9_-]+\/f\d+\.jpg$/;

export const toLimits = (show: Show): Limits => ({ apps: show.limits.apps, origins: show.limits.origins, taughtCommands: show.limits.commands });

/** The whole demo, for the operator's cached prefix: it should know the story, not only the current beat. */
export function showBrief(show: Show): string {
  const beats = show.beats.map((b, i) => `${i + 1}. ${b.label}: ${b.goal}`).join("\n");
  return `The demo is "${show.name}". Its beats, in order:\n${beats}`;
}

export function beatGoal(beat: Beat): string {
  return `${beat.goal}\nDone when: ${beat.success}${beat.notes ? `\nThe presenter's corrections: ${beat.notes}` : ""}`;
}

/** What's going on between the console and this Mac: one recording or one dry run at a time. */
export class StageSession {
  private recorder: Recorder | null = null;
  private recordingId: string | null = null;
  private showName = "";
  private stop: AbortController | null = null;
  private busy: "recording" | "learning" | "dry-run" | null = null;
  private approvals = new Map<string, (yes: boolean) => void>();
  /** The presenter's go, while the screen is black. */
  private begin: (() => void) | null = null;

  constructor(
    private helper: Helper,
    private display: Display,
    private recordingsDir: string,
    private send: (msg: unknown) => void,
  ) {}

  status() {
    this.send({ type: "status", busy: this.busy, display: this.display.name });
  }

  private setBusy(busy: StageSession["busy"]) {
    this.busy = busy;
    this.status();
  }

  frame(path: string): Promise<Buffer | null> {
    if (!SAFE_PATH.test(path)) return Promise.resolve(null);
    return readFile(join(this.recordingsDir, path)).catch(() => null);
  }

  hotkey(name: string) {
    if (name === "stop") this.halt();
    const [first] = this.approvals.keys();
    if (first && (name === "advance" || name === "back")) return this.answer(first, name === "advance");
    if (name === "advance") this.begin?.();
  }

  halt() {
    this.stop?.abort();
  }

  private answer(id: string, yes: boolean) {
    this.approvals.get(id)?.(yes);
    this.approvals.delete(id);
  }

  private async guarded(work: () => Promise<void>) {
    try {
      await work();
    } catch (e) {
      this.send({ type: "error", message: e instanceof Error ? e.message : String(e) });
      this.setBusy(null);
    }
  }

  handle(msg: any) {
    switch (msg.type) {
      case "status":
        return this.status();
      case "stop":
        return this.halt();
      case "begin":
        return this.begin?.();
      case "approve":
        return this.answer(String(msg.id), msg.yes === true);
      case "said":
        return this.recorder?.said(String(msg.text), Number(msg.t));
      case "record:start":
        return void this.guarded(() => this.startRecording(String(msg.name)));
      case "record:stop":
        return void this.guarded(() => this.finishRecording());
      case "dry-run":
        return void this.guarded(() => this.dryRun(msg.show as Show));
    }
  }

  private async startRecording(name: string) {
    if (this.busy) throw new Error(`Stage is busy: ${this.busy}.`);
    this.recordingId = `${Date.now()}-${randomBytes(3).toString("hex")}`;
    this.showName = name;
    this.recorder = new Recorder(this.helper, this.display, join(this.recordingsDir, this.recordingId));
    await this.recorder.start();
    this.setBusy("recording");
  }

  private async finishRecording() {
    const recorder = this.recorder;
    if (!recorder || !this.recordingId) return;
    this.recorder = null;
    this.setBusy("learning");
    const moments = await recorder.stop();
    if (!presenterActed(moments)) throw new Error(`Nothing happened on ${this.display.name} during that recording, so there's nothing to learn. Do the demo on that display and record again.`);
    const playbook = await learn(recorder.dir, moments, recorder.startedAt, { showName: this.showName });
    this.send({ type: "learned", recordingId: this.recordingId, ...playbook });
    this.setBusy(null);
  }

  private async landmarks(show: Show, beat: Beat): Promise<ContentParam[]> {
    const images = await Promise.all(beat.landmarks.map((f) => this.frame(`${show.recordingId}/${f}`)));
    const found = images.filter((b): b is Buffer => !!b);
    if (!found.length) return [];
    return [
      { type: "text", text: "Reference screenshots from when the presenter showed this. The live screen comes next and may differ; go by the live screen." },
      ...found.map((b): ContentParam => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b.toString("base64") } })),
    ];
  }

  private curtain(on: boolean) {
    return this.helper.call("curtain", { on, display: this.display.id });
  }

  /** The operator performs the show live, beat by beat, and stops at the first beat it can't finish. */
  private async dryRun(show: Show) {
    if (this.busy) throw new Error(`Stage is busy: ${this.busy}.`);
    this.setBusy("dry-run");
    const stop = new AbortController();
    this.stop = stop;
    const driver = new DesktopDriver(this.helper, this.display, stop.signal);
    const model = claudeModel({ brief: showBrief(show) });
    const results: BeatResult[] = [];
    // The screen starts black, and the operator gets its first move ready behind it. Nothing runs until the presenter goes.
    await this.curtain(true);
    const begun = new Promise<void>((resolve) => {
      this.begin = () => {
        this.begin = null;
        this.send({ type: "begun" });
        resolve(this.curtain(false));
      };
    });
    this.send({ type: "waiting" });
    try {
      for (const [i, beat] of show.beats.entries()) {
        if (i > 0) await sleep(beatGapMs());
        this.send({ type: "beat", beatId: beat.id });
        const report = await runBeat({
          goal: beatGoal(beat),
          context: await this.landmarks(show, beat),
          driver,
          model,
          limits: toLimits(show),
          hold: true,
          release: i === 0 ? begun : Promise.resolve(),
          signal: stop.signal,
          actionGapMs,
          onEvent: (event) => this.send({ type: "agent", beatId: beat.id, event }),
          approve: async (question) => {
            // The presenter has to be able to read it.
            await this.curtain(false);
            return new Promise((resolve) => {
              const id = randomBytes(4).toString("hex");
              this.approvals.set(id, resolve);
              this.send({ type: "approval", id, question });
            });
          },
        });
        results.push({ beatId: beat.id, outcome: report.outcome, summary: report.summary, ms: report.totalMs, cueToActionMs: report.cueToActionMs });
        if (report.outcome !== "done") break;
      }
    } finally {
      this.stop = null;
      this.begin = null;
      this.approvals.clear();
      await this.curtain(false).catch(() => {});
      this.send({ type: "dry-run:done", run: { at: Date.now(), results } });
      this.setBusy(null);
    }
  }
}

