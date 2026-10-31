import { Emitter, type SpeechResult, type SpeechSource, type SpeechStatus } from "./SpeechSource";

const TARGET_RATE = 16000;
/** ~40 ms of 16 kHz audio per WebSocket frame: small enough to keep latency low. */
const FRAME_SAMPLES = 640;

/**
 * AudioWorklet that downsamples mic input to 16 kHz mono and posts Int16 PCM
 * frames. Inlined so there's no extra file to serve.
 */
const WORKLET = `
class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${TARGET_RATE};
    this.acc = 0; this.accN = 0; this.pos = 0;
    this.out = new Int16Array(${FRAME_SAMPLES}); this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]; this.accN++; this.pos++;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.accN));
        this.acc = 0; this.accN = 0;
        this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === this.out.length) {
          this.port.postMessage(this.out.buffer, [this.out.buffer]);
          this.out = new Int16Array(${FRAME_SAMPLES}); this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("pcm-downsampler", PcmDownsampler);
`;

interface DeepgramResults {
  type: "Results";
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: { transcript?: string }[] };
}

/**
 * Streams the mic straight to Deepgram, using a short-lived token from the
 * server, and emits interim + final transcripts. Reconnects automatically
 * while active.
 */
export class DeepgramSpeechSource implements SpeechSource {
  private results = new Emitter<[SpeechResult]>();
  private status = new Emitter<[SpeechStatus, string?]>();
  private log = new Emitter<[string]>();
  private active = false;
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private keyterms: string[] = [];
  private retryDelay = 250;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  onResult(cb: (r: SpeechResult) => void) {
    return this.results.on(cb);
  }
  onStatus(cb: (s: SpeechStatus, detail?: string) => void) {
    return this.status.on(cb);
  }
  onLog(cb: (line: string) => void) {
    return this.log.on(cb);
  }

  setKeyterms(terms: string[]): void {
    this.keyterms = terms;
    // Nova-3 accepts new keyterms mid-stream; each Configure replaces the whole list.
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "Configure", keyterms: terms }));
      this.log.emit(`keyterms updated (${terms.length})`);
    }
  }

  async start(): Promise<void> {
    this.active = true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.ctx = new AudioContext();
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(this.ctx, "pcm-downsampler");
      node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(e.data);
      };
      this.ctx.createMediaStreamSource(this.stream).connect(node);
      // Keep the worklet in the rendered graph (muted) so the browser keeps calling process().
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(this.ctx.destination);
      this.log.emit(`mic: ${this.stream.getAudioTracks()[0]?.label ?? "default"} @ ${this.ctx.sampleRate} Hz`);
    } catch (e) {
      const err = e as Error;
      this.active = false;
      this.log.emit(`mic failed: ${err.name}: ${err.message}`);
      this.status.emit(
        "error",
        err.name === "NotAllowedError"
          ? "Microphone blocked. Allow it in Chrome's address bar, and for Chrome in macOS System Settings → Privacy & Security → Microphone."
          : `Microphone unavailable: ${err.message}`,
      );
      return;
    }
    if (!this.active) return this.teardownAudio(); // stopped while we were awaiting permission
    this.connect();
  }

  stop(): void {
    this.active = false;
    clearTimeout(this.retryTimer);
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "CloseStream" }));
      this.ws.close();
      this.ws = null;
    }
    this.teardownAudio();
    this.status.emit("idle");
  }

  /** Configuration problems won't fix themselves by retrying. */
  private fail(reason: string): void {
    this.active = false;
    this.teardownAudio();
    this.status.emit("error", reason);
  }

  private retry(): void {
    this.status.emit("restarting");
    this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 5000);
  }

  private teardownAudio(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  private async connect(): Promise<void> {
    if (!this.active) return;
    let session: { url: string; token: string };
    try {
      const res = await fetch("/api/stt/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keyterms: this.keyterms }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 503) return this.fail(body.error ?? "Deepgram is not configured");
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      session = body;
    } catch (e) {
      this.log.emit(`token request failed: ${e instanceof Error ? e.message : e}`);
      if (this.active) this.retry();
      return;
    }
    if (!this.active) return; // stopped while we were waiting for the token
    // Browsers can't set headers on a WebSocket, so the token goes in the subprotocol.
    const ws = new WebSocket(session.url, ["bearer", session.token]);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.log.emit("connected to Deepgram");
      this.status.emit("listening");
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      let msg: DeepgramResults | { type: string; description?: string };
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "Results") {
        this.retryDelay = 250;
        const r = msg as DeepgramResults;
        const text = r.channel?.alternatives?.[0]?.transcript ?? "";
        if (!text.trim()) return;
        this.results.emit({ text, isFinal: Boolean(r.is_final), timestamp: performance.now() });
      } else if (msg.type !== "Metadata" && msg.type !== "SpeechStarted" && msg.type !== "UtteranceEnd") {
        this.log.emit(`${msg.type}${"description" in msg && msg.description ? `: ${msg.description}` : ""}`);
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.log.emit(`closed ${e.code}${e.reason ? `: ${e.reason}` : ""}`);
      if (this.active) this.retry();
    };
  }
}
