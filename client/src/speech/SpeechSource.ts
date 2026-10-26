export interface SpeechResult {
  text: string;
  isFinal: boolean;
  /** ms, same clock as performance.now() */
  timestamp: number;
}

export type SpeechStatus = "idle" | "listening" | "restarting" | "error" | "unsupported";

/**
 * Anything that produces a live transcript. Web Speech today; a streaming
 * STT provider (Deepgram, AssemblyAI, Whisper server…) can implement this later.
 */
export interface SpeechSource {
  start(): void;
  stop(): void;
  onResult(cb: (r: SpeechResult) => void): () => void;
  onStatus(cb: (s: SpeechStatus, detail?: string) => void): () => void;
  /** Words to listen for (the current slide's keywords). Optional: not every engine supports boosting. */
  setKeyterms?(terms: string[]): void;
  /** Raw lifecycle events for the debug panel. */
  onLog?(cb: (line: string) => void): () => void;
}

/** Small helper so implementations share listener bookkeeping. */
export class Emitter<T extends unknown[]> {
  private subs = new Set<(...args: T) => void>();
  on(cb: (...args: T) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
  emit(...args: T): void {
    for (const s of this.subs) s(...args);
  }
}
