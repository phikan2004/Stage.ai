import { Emitter, type SpeechResult, type SpeechSource, type SpeechStatus } from "./SpeechSource";

// Minimal typings; the Web Speech API isn't in lib.dom for all TS versions.
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onsoundstart: (() => void) | null;
  onspeechstart: (() => void) | null;
}

const Ctor: (new () => Recognition) | undefined =
  (globalThis as any).SpeechRecognition ?? (globalThis as any).webkitSpeechRecognition;

export const webSpeechSupported = () => Boolean(Ctor);

/** What each Web Speech error code usually means, in plain words. */
const ERROR_HELP: Record<string, string> = {
  "not-allowed": "Microphone blocked. Allow it in Chrome's address bar, and for Chrome in macOS System Settings → Privacy & Security → Microphone.",
  "service-not-allowed": "Speech service unavailable in this browser. Use Google Chrome (Brave, Arc and some Chromium builds don't include it).",
  network: "Couldn't reach Google's speech service. Check your connection, VPN or firewall. Brave and Arc also report this.",
  "audio-capture": "No microphone input. Check the input device in macOS Sound settings and Chrome's microphone setting.",
  "language-not-supported": "Speech language not supported.",
};

/**
 * Chrome's recognizer streams audio to Google and ends itself every so often
 * (silence, network hiccups, ~60s caps). While active we restart on every end.
 */
export class WebSpeechSource implements SpeechSource {
  private rec: Recognition | null = null;
  private active = false;
  private results = new Emitter<[SpeechResult]>();
  private status = new Emitter<[SpeechStatus, string?]>();
  private log = new Emitter<[string]>();
  private restartDelay = 50;
  private failing = false;

  constructor(private lang = "en-US") {}

  onResult(cb: (r: SpeechResult) => void) {
    return this.results.on(cb);
  }
  onStatus(cb: (s: SpeechStatus, detail?: string) => void) {
    return this.status.on(cb);
  }
  /** Raw lifecycle events (start, audiostart, error:network, …) for the debug panel. */
  onLog(cb: (line: string) => void) {
    return this.log.on(cb);
  }

  start(): void {
    if (!Ctor) {
      this.status.emit("unsupported", "Web Speech API not available. Use Google Chrome.");
      this.log.emit("unsupported: no SpeechRecognition in this browser");
      return;
    }
    this.active = true;
    this.spawn();
  }

  stop(): void {
    this.active = false;
    this.rec?.abort();
    this.rec = null;
    this.status.emit("idle");
  }

  private spawn(): void {
    if (!this.active || !Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.lang;
    rec.onstart = () => {
      this.log.emit("start");
      // Don't flip back to "listening" while a session keeps failing; it would hide the error.
      if (!this.failing) this.status.emit("listening");
    };
    rec.onaudiostart = () => this.log.emit("audiostart (mic is capturing)");
    rec.onsoundstart = () => this.log.emit("soundstart");
    rec.onspeechstart = () => this.log.emit("speechstart");
    rec.onresult = (e) => {
      const now = performance.now();
      this.failing = false;
      this.restartDelay = 50;
      // Finals are emitted once each. Chrome may split the in-progress tail into
      // several interim results, so join them into one interim string.
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.results.emit({ text: r[0].transcript, isFinal: true, timestamp: now });
        else interim += r[0].transcript;
      }
      if (interim.trim()) this.results.emit({ text: interim, isFinal: false, timestamp: now });
      this.status.emit("listening");
    };
    rec.onerror = (e) => {
      this.log.emit(`error: ${e.error}${e.message ? ` (${e.message})` : ""}`);
      if (e.error === "no-speech" || e.error === "aborted") return;
      const help = ERROR_HELP[e.error] ?? e.error;
      this.failing = true;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") this.active = false;
      else this.restartDelay = Math.min(this.restartDelay * 2, 4000);
      this.status.emit("error", help);
    };
    rec.onend = () => {
      this.log.emit("end");
      if (this.rec !== rec) return;
      this.rec = null;
      if (!this.active) return;
      if (!this.failing) this.status.emit("restarting");
      setTimeout(() => this.spawn(), this.restartDelay);
    };
    this.rec = rec;
    try {
      rec.start();
    } catch (err) {
      this.log.emit(`start threw: ${err}`);
      this.status.emit("error", String(err));
    }
  }
}
