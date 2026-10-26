import { Emitter, type SpeechResult, type SpeechSource, type SpeechStatus } from "./SpeechSource";

export interface ScriptLine {
  /** ms offset from start() */
  t: number;
  text: string;
  isFinal?: boolean;
}

/**
 * Replays a timestamped transcript, or lets you push text by hand (the debug
 * panel's "simulate" box). Uses the same SpeechSource interface as the mic.
 */
export class ScriptedSpeechSource implements SpeechSource {
  private results = new Emitter<[SpeechResult]>();
  private status = new Emitter<[SpeechStatus, string?]>();
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    private script: ScriptLine[] = [],
    private clock: () => number = () => performance.now(),
  ) {}

  onResult(cb: (r: SpeechResult) => void) {
    return this.results.on(cb);
  }
  onStatus(cb: (s: SpeechStatus, detail?: string) => void) {
    return this.status.on(cb);
  }

  start(): void {
    this.status.emit("listening");
    for (const line of this.script) {
      this.timers.push(setTimeout(() => this.push(line.text, line.isFinal ?? true), line.t));
    }
  }

  stop(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.status.emit("idle");
  }

  push(text: string, isFinal = true): void {
    this.results.emit({ text, isFinal, timestamp: this.clock() });
  }
}
