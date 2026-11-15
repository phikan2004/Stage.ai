import type { Beat } from "../../../shared/schema";
import { DEFAULT_CONFIG, type ProducerConfig } from "./config";
import { compileRegions, scoreRegions, type CompiledRegion, type RegionScore } from "./matcher";
import { decisiveWinner } from "./restraint";
import { TranscriptWindow } from "./transcriptWindow";

export type CueBeat = Pick<Beat, "id" | "label" | "cues">;

/** Before the demo is under way, a single word comes up in normal talk, so a cue needs a phrase or this many words. */
const MIN_WORDS = 2;
/** The presenter finished a thought: they spoke after the last beat, then went quiet this long. */
export const PAUSE_MS = 1500;
/** The presenter said nothing at all after the last beat, so carry on. */
export const IDLE_MS = 3000;
/** Hold and go only count as a short sentence of their own, so "I can't wait to show you" doesn't hold the demo. */
const MAX_COMMAND_WORDS = 5;

const HOLD = /\b(hold on|hang on|wait|stop|pause|not yet|one sec(ond)?|give me a (sec(ond)?|moment))\b/i;
const GO = /\b(go ahead|carry on|keep going|continue|let'?s go|go on|next|ready|okay go|resume)\b/i;

export type FlowState = "listening" | "running" | "waiting" | "held" | "done";

/**
 * Follows the presenter through a demo the way a person helping them would. Pure: time is always passed in.
 * The first beat needs a cue. After that, each beat starts once the one before it is done and the presenter either
 * starts talking about it, finishes their thought, or says nothing for a while, unless they've asked to hold.
 */
export class CueDirector {
  private window = new TranscriptWindow();
  private index = 0;
  private candidates: CompiledRegion[] = [];
  /** Engines resend the utterance in progress, so the words that fired a cue stay out until it ends. */
  private muted = false;
  private midUtterance = false;
  /** When the beat before the next one finished, or null while it hasn't. */
  private readySince: number | null = null;
  private lastSpeech = -Infinity;
  private spokeSinceReady = false;
  private held = false;
  /** The presenter said to go on. */
  private goNow = false;

  constructor(
    private beats: CueBeat[],
    private cfg: ProducerConfig = DEFAULT_CONFIG,
  ) {
    this.compile();
  }

  get next(): CueBeat | null {
    return this.beats[this.index] ?? null;
  }

  get state(): FlowState {
    if (!this.next) return "done";
    if (this.held) return "held";
    if (this.readySince !== null) return "waiting";
    return this.index === 0 ? "listening" : "running";
  }

  private compile() {
    const regions = this.beats.slice(this.index, this.index + 2).map((b) => {
      const cues = b.cues.length ? b.cues : [b.label];
      return { id: b.id, label: "", keywords: cues, phrases: cues };
    });
    this.candidates = compileRegions(regions, 0);
  }

  hear(text: string, isFinal: boolean, t: number) {
    this.midUtterance = !isFinal;
    if (text.trim()) this.lastSpeech = t;
    if (isFinal) this.command(text, t);
    if (this.muted) {
      if (isFinal) this.muted = false;
      return;
    }
    this.window.push(text, isFinal, t);
  }

  private command(text: string, t: number) {
    const short = text.trim().split(/\s+/).length <= MAX_COMMAND_WORDS;
    if (short && HOLD.test(text)) {
      this.held = true;
      this.goNow = false;
    } else if (short && GO.test(text)) {
      this.held = false;
      this.goNow = true;
    } else if (this.readySince !== null && t >= this.readySince) {
      this.spokeSinceReady = true;
    }
  }

  /** The beat that was running has finished, so the next one may follow. */
  done(beatId: string, now: number) {
    if (this.beats[this.index - 1]?.id !== beatId) return;
    this.readySince = now;
    this.spokeSinceReady = false;
  }

  /** The presenter reached this beat some other way. */
  passed(beatId: string) {
    const at = this.beats.findIndex((b) => b.id === beatId);
    if (at < this.index) return;
    this.index = at + 1;
    this.readySince = null;
    this.spokeSinceReady = false;
    this.held = false;
    this.goNow = false;
    this.window.clear();
    this.compile();
  }

  private enoughWords(score: RegionScore): boolean {
    const own = [...this.candidates[0].df.values()].filter((n) => n === 1).length;
    return (score.hits ?? 0) >= Math.max(1, Math.min(MIN_WORDS, own));
  }

  private heardNext(now: number): boolean {
    const next = this.next!;
    const tokens = this.window.tokens(now, this.cfg.windowMs, this.cfg.interimWeight);
    const scores = scoreRegions(tokens, this.candidates, now, this.cfg);
    const mine = scores.find((s) => s.id === next.id)!;
    // A phrase is enough even if the following beat shares it: the next beat always comes first.
    if (mine.trigger) return true;
    // Once the demo is flowing, a single word of the next beat's own is enough, as long as it points there and not further.
    if (this.readySince !== null) return (mine.hits ?? 0) >= 1 && mine.score > (scores.find((s) => s.id !== next.id)?.score ?? 0);
    return decisiveWinner(scores, this.cfg) === next.id && this.enoughWords(mine);
  }

  private flowsOn(now: number): boolean {
    if (this.goNow) return true;
    if (this.readySince === null || this.held) return false;
    const quiet = now - Math.max(this.lastSpeech, this.readySince);
    return this.spokeSinceReady ? quiet >= PAUSE_MS : quiet >= IDLE_MS;
  }

  /** The beat to release now, if any. */
  tick(now: number): string | null {
    const next = this.next;
    if (!next) return null;
    const heard = !this.held && this.heardNext(now);
    if (!heard && !this.flowsOn(now)) return null;
    this.passed(next.id);
    this.muted = heard && this.midUtterance;
    return next.id;
  }
}
