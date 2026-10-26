import { normalizeSpoken } from "./text";

export type Command =
  | { type: "next" }
  | { type: "prev" }
  | { type: "goto"; slide: number } // 1-based, as spoken
  | { type: "first" }
  | { type: "last" }
  | { type: "zoomOut" };

// Optional lead-ins and tails people wrap commands in: "okay, next slide please".
const LEAD = String.raw`(?:(?:ok|okay|alright|all right|so|and|now|right|um|uh|let's|lets|let us|can we|could we|please)\s+)*`;
const TAIL = String.raw`(?:\s+(?:please|now|then|thanks|thank you))*`;

const PATTERNS: [RegExp, (m: RegExpMatchArray) => Command][] = [
  [/^(?:(?:go|move|skip|jump)\s+)?(?:on\s+)?(?:to\s+)?(?:the\s+)?next(?:\s+(?:slide|1|page))?$|^(?:advance|move on|forward)$/, () => ({ type: "next" })],
  [/^(?:go\s+)?back(?:\s+(?:a|1)\s+slide)?$|^(?:go\s+)?(?:to\s+)?(?:the\s+)?previous(?:\s+(?:slide|1|page))?$|^(?:go\s+)?back\s+to\s+(?:the\s+)?(?:previous|last)(?:\s+(?:slide|1))?$/, () => ({ type: "prev" })],
  [/^(?:(?:go|jump|skip|move|back)\s+)?(?:to\s+)?(?:the\s+)?slide\s+(?:number\s+)?(\d{1,3})$/, (m) => ({ type: "goto", slide: Number(m[1]) })],
  [/^(?:(?:go|jump|skip|back)\s+)?(?:back\s+)?(?:to\s+)?(?:the\s+)?(?:first\s+slide|beginning|start)$/, () => ({ type: "first" })],
  [/^(?:(?:go|jump|skip)\s+)?(?:to\s+)?(?:the\s+)?(?:final\s+slide|last\s+slide|end)$/, () => ({ type: "last" })],
  [/^(?:zoom\s+(?:back\s+)?out|full\s+slide|show\s+(?:me\s+)?(?:the\s+)?(?:whole|full|entire)\s+slide)$/, () => ({ type: "zoomOut" })],
];

const WRAPPED = new RegExp(`^${LEAD}(.+?)${TAIL}$`);

/** Match one short phrase against the command list. Whole-phrase only. */
function matchPhrase(phrase: string): Command | null {
  const core = WRAPPED.exec(phrase)?.[1] ?? phrase;
  // Commands are short; anything longer is normal talk.
  if (core.split(" ").length > 7) return null;
  for (const [re, make] of PATTERNS) {
    const m = core.match(re);
    if (m) return make(m);
  }
  return null;
}

/**
 * Find a voice command in a finalized transcript. A command must be its own
 * sentence ("Next slide." or "...that's Q4. Next slide."), never words inside a
 * longer sentence ("on the next slide you'll see"), so normal talk can't trigger it.
 */
export function parseCommand(transcript: string): Command | null {
  const sentences = transcript.split(/[.!?]+/).map((s) =>
    normalizeSpoken(s)
      .replace(/[^a-z0-9' ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  // The most recent sentence wins: "go back. no, next slide" → next.
  for (let i = sentences.length - 1; i >= 0; i--) {
    const s = sentences[i];
    if (!s) continue;
    const cmd = matchPhrase(s);
    if (cmd) return cmd;
  }
  return null;
}

/** Phrases worth boosting in speech recognition so commands are heard reliably. */
export const COMMAND_KEYTERMS = ["next slide", "previous slide", "go back", "zoom out", "first slide", "last slide"];
