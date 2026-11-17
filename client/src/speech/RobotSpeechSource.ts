import { Emitter, type SpeechResult, type SpeechSource, type SpeechStatus } from "./SpeechSource";

/** The parts of the browser's speech synthesis this uses, so tests can stand in for it. */
export interface Synth {
  speak(u: Utterance): void;
  cancel(): void;
  getVoices(): { name: string; lang: string; localService: boolean; default: boolean }[];
}
export interface Utterance {
  text: string;
  rate: number;
  pitch: number;
  voice: any;
  onstart: (() => void) | null;
  onboundary: ((e: { name: string; charIndex: number; charLength?: number }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

/** Spoken words per second at rate 1, for voices that don't report where they are. */
const WORDS_PER_SEC = 2.6;
/** A voice that hasn't reported a word by now never will. */
const BOUNDARY_GRACE_MS = 700;
/** Chrome sometimes never fires `end`; give a line this much past its expected length. */
const WATCHDOG_SLACK_MS = 4000;

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** The English voices this browser can speak with, by name, voices on this Mac first. */
export function englishVoices(synth: Synth = window.speechSynthesis as unknown as Synth): string[] {
  const voices = synth.getVoices().filter((v) => v.lang.toLowerCase().startsWith("en"));
  return [...voices.filter((v) => v.localService), ...voices.filter((v) => !v.localService)].map((v) => v.name);
}

/** The chosen voice if there is one; otherwise one on this Mac, since they report each word as it's spoken and network voices often don't. */
function pickVoice(synth: Synth, name: string | null) {
  const chosen = name ? synth.getVoices().find((v) => v.name === name) : undefined;
  if (chosen) return chosen;
  const voices = synth.getVoices().filter((v) => v.lang.toLowerCase().startsWith("en"));
  return voices.find((v) => v.localService && v.default) ?? voices.find((v) => v.localService && v.lang === "en-US") ?? voices.find((v) => v.localService) ?? voices[0] ?? null;
}

/**
 * A robot presenter. It speaks lines aloud and feeds each word to the cue engine as it's said, exactly like a speech
 * engine hearing a person would: growing interim results, then a final one per line. The mic stays off, so the robot
 * is never heard twice.
 */
export class RobotSpeechSource implements SpeechSource {
  private results = new Emitter<[SpeechResult]>();
  private status = new Emitter<[SpeechStatus, string?]>();
  private logs = new Emitter<[string]>();
  /** bumped by cancel(), so lines queued before it stop */
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private stopLine: (() => void) | null = null;

  constructor(
    private synth: Synth = window.speechSynthesis as unknown as Synth,
    private makeUtterance: (text: string) => Utterance = (text) => new SpeechSynthesisUtterance(text) as unknown as Utterance,
    private clock: () => number = () => performance.now(),
    public rate = 1,
    public pitch = 1,
    /** a voice by name, or null for the default */
    public voiceName: string | null = null,
  ) {}

  onResult(cb: (r: SpeechResult) => void) {
    return this.results.on(cb);
  }
  onStatus(cb: (s: SpeechStatus, detail?: string) => void) {
    return this.status.on(cb);
  }
  onLog(cb: (line: string) => void) {
    return this.logs.on(cb);
  }

  start(): void {
    this.status.emit("listening");
  }

  stop(): void {
    this.cancel();
    this.status.emit("idle");
  }

  /** Stops talking now and drops everything queued. */
  cancel(): void {
    this.generation++;
    this.stopLine?.();
    this.stopLine = null;
    this.synth.cancel();
    this.queue = Promise.resolve();
  }

  /**
   * Speaks the lines after anything already queued. Resolves true once they've all been said, or false if cancel()
   * cut them off.
   */
  say(lines: string[]): Promise<boolean> {
    const gen = this.generation;
    const run = this.queue.then(async () => {
      for (const line of lines) {
        if (gen !== this.generation) return false;
        if (!(await this.speakLine(line, gen))) return false;
      }
      return gen === this.generation;
    });
    this.queue = run;
    return run;
  }

  private speakLine(text: string, gen: number): Promise<boolean> {
    return new Promise((resolve) => {
      const u = this.makeUtterance(text);
      // Read per line, so a change to the voice is heard from the next line on.
      u.rate = this.rate;
      u.pitch = this.pitch;
      u.voice = pickVoice(this.synth, this.voiceName);
      let spoken = 0;
      let reported = false;
      let finished = false;
      const timers: ReturnType<typeof setTimeout>[] = [];
      const words = text.split(/\s+/).filter(Boolean);
      const interim = (upTo: string) => {
        if (gen === this.generation && upTo.trim()) this.results.emit({ text: upTo.trim(), isFinal: false, timestamp: this.clock() });
      };
      const finish = (completed: boolean) => {
        if (finished) return;
        finished = true;
        timers.forEach(clearTimeout);
        if (this.stopLine === stop) this.stopLine = null;
        if (completed && gen === this.generation) {
          this.results.emit({ text, isFinal: true, timestamp: this.clock() });
          this.logs.emit(`robot: "${text}"`);
        }
        resolve(completed && gen === this.generation);
      };
      const stop = () => finish(false);
      this.stopLine = stop;

      u.onboundary = (e) => {
        if (e.name !== "word") return;
        reported = true;
        const end = e.charIndex + (e.charLength || /^\S*/.exec(text.slice(e.charIndex))![0].length);
        if (end > spoken) {
          spoken = end;
          interim(text.slice(0, end));
        }
      };
      u.onstart = () => {
        // No word reports from this voice: release the words at speaking pace instead.
        timers.push(
          setTimeout(() => {
            if (reported || finished) return;
            const gap = 1000 / (WORDS_PER_SEC * this.rate);
            words.forEach((_, i) => timers.push(setTimeout(() => !reported && interim(words.slice(0, i + 1).join(" ")), i * gap)));
          }, BOUNDARY_GRACE_MS),
        );
      };
      u.onend = () => finish(true);
      u.onerror = (e) => {
        if (e.error === "interrupted" || e.error === "canceled") return finish(false);
        this.logs.emit(`robot voice error: ${e.error}`);
        finish(true);
      };
      timers.push(setTimeout(() => finish(true), (wordCount(text) / (WORDS_PER_SEC * this.rate)) * 1000 + WATCHDOG_SLACK_MS));
      this.synth.speak(u);
    });
  }
}

export const robotVoiceSupported = () => typeof window !== "undefined" && "speechSynthesis" in window;
