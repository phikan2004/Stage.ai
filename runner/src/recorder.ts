import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sameFingerprint } from "./driver.ts";
import type { Display, Helper, Input } from "./helper.ts";
import { insideBounds } from "./safety.ts";
import { maskMoments } from "./secrets.ts";
import { addKey, type Moment } from "./timeline.ts";

const MAX_SIDE = 1568;
const FRAME_EVERY_MS = 1000;
const AFTER_CLICK_MS = 600;

interface Capture {
  data: string;
  grid: number[];
}

/** Records one Teach: keyframes of the stage display, what the presenter did there, and what they said. */
export class Recorder {
  readonly moments: Moment[] = [];
  readonly startedAt = Date.now();
  private frames = 0;
  private lastFile: string | undefined;
  private lastGrid: number[] | undefined;
  private timer?: ReturnType<typeof setInterval>;
  private capturing = false;
  private pendingAfter = new Set<Promise<void>>();
  private endRecording?: () => Promise<void>;
  /** Keys only count while the presenter is working on the stage display. */
  private onStage = false;

  constructor(
    private helper: Helper,
    private display: Display,
    readonly dir: string,
  ) {}

  async start() {
    await mkdir(this.dir, { recursive: true });
    await this.tick();
    this.endRecording = await this.helper.record((i) => this.input(i));
    this.timer = setInterval(() => this.tick().catch(() => {}), FRAME_EVERY_MS);
  }

  /** The presenter's words, sent from the console. */
  said(text: string, t: number) {
    this.moments.push({ t, kind: "said", text });
  }

  private async grab(force: boolean): Promise<string | undefined> {
    const c = await this.helper.call<Capture>("capture", { display: this.display.id, maxSide: MAX_SIDE });
    if (!force && this.lastGrid && sameFingerprint({ key: "", grid: this.lastGrid }, { key: "", grid: c.grid })) return this.lastFile;
    const file = `f${String(++this.frames).padStart(4, "0")}.jpg`;
    await writeFile(join(this.dir, file), Buffer.from(c.data, "base64"));
    this.lastGrid = c.grid;
    this.lastFile = file;
    this.moments.push({ t: Date.now(), kind: "frame", file });
    return file;
  }

  private async tick() {
    if (this.capturing) return;
    this.capturing = true;
    try {
      const { frame } = await this.helper.call<{ frame?: { x: number; y: number; width: number; height: number } }>("frontmost");
      this.onStage = !!frame && insideBounds(this.display, frame.x + frame.width / 2, frame.y + frame.height / 2);
      await this.grab(false);
    } finally {
      this.capturing = false;
    }
  }

  private input(i: Input) {
    if (i.kind !== "click") {
      if (this.onStage || i.kind === "secure") addKey(this.moments, i);
      return;
    }
    this.onStage = insideBounds(this.display, i.x, i.y);
    if (!this.onStage) return;
    const click: Extract<Moment, { kind: "click" }> = { t: i.t, kind: "click", button: i.button, app: i.app, role: i.role, name: i.name, before: this.lastFile };
    this.moments.push(click);
    const after = new Promise<void>((resolve) => {
      setTimeout(async () => {
        click.after = await this.grab(true).catch(() => undefined);
        resolve();
      }, AFTER_CLICK_MS);
    }).finally(() => this.pendingAfter.delete(after));
    this.pendingAfter.add(after);
  }

  async stop(): Promise<Moment[]> {
    clearInterval(this.timer);
    await this.endRecording?.();
    await Promise.all(this.pendingAfter);
    const moments = maskMoments(this.moments.sort((a, b) => a.t - b.t));
    await writeFile(join(this.dir, "timeline.json"), JSON.stringify({ startedAt: this.startedAt, moments }, null, 1));
    return moments;
  }
}
