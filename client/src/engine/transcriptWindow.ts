import { tokenize } from "./text";

export interface WindowToken {
  stem: string;
  /** ms timestamp when the word was heard */
  t: number;
  /** 1 for final results, < 1 for interim */
  weight: number;
  /** index within the window, for phrase adjacency */
  seq: number;
}

interface Segment {
  text: string;
  stems: string[];
  t: number;
  isFinal: boolean;
}

/**
 * Rolling transcript buffer. Pure: time is always passed in.
 * Speech engines resend the in-progress (interim) utterance repeatedly, so the
 * interim segment is replaced on every push and dropped when its final arrives.
 */
export class TranscriptWindow {
  private finals: Segment[] = [];
  private interim: Segment | null = null;

  push(text: string, isFinal: boolean, t: number): void {
    const seg: Segment = { text: text.trim(), stems: tokenize(text), t, isFinal };
    if (isFinal) {
      this.interim = null;
      if (seg.text) this.finals.push(seg);
    } else {
      this.interim = seg.text ? seg : null;
    }
  }

  clear(): void {
    this.finals = [];
    this.interim = null;
  }

  prune(now: number, windowMs: number): void {
    const cutoff = now - windowMs;
    this.finals = this.finals.filter((s) => s.t >= cutoff);
    if (this.interim && this.interim.t < cutoff) this.interim = null;
  }

  tokens(now: number, windowMs: number, interimWeight: number): WindowToken[] {
    this.prune(now, windowMs);
    const out: WindowToken[] = [];
    let seq = 0;
    for (const s of this.finals) for (const stem of s.stems) out.push({ stem, t: s.t, weight: 1, seq: seq++ });
    if (this.interim) {
      for (const stem of this.interim.stems) out.push({ stem, t: this.interim.t, weight: interimWeight, seq: seq++ });
    }
    return out;
  }

  /** Raw text currently in the window, for the debug panel. */
  text(now: number, windowMs: number): { finals: string; interim: string } {
    this.prune(now, windowMs);
    return {
      finals: this.finals.map((s) => s.text).join(" "),
      interim: this.interim?.text ?? "",
    };
  }
}
