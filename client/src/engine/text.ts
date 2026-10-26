import { stemmer } from "stemmer";

const STOPWORDS = new Set(
  `a about above after again against all am an and any are as at be because been before being below between both but by
  can could did do does doing down during each few for from further had has have having he her here hers herself him himself
  his how i if in into is it its itself just let me more most my myself no nor not now of off on once only or other our ours
  ourselves out over own same she should so some such than that the their theirs them themselves then there these they this
  those through to too under until up very was we were what when where which while who whom why will with would you your
  yours yourself yourselves um uh like okay ok yeah so right really actually basically going gonna get got see look looking
  here's there's let's we're we've we'll you'll you're it's that's thing things kind sort`
    .split(/\s+/)
    .filter(Boolean),
);

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const NUMBER_RE = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b`, "g");

/**
 * Bring the different ways speech engines write the same thing to one form,
 * applied to both transcripts and keywords:
 * "queue one" / "Q 1" / "quarter one" → "q1", "seven point three" → "7.3", "thirty eight" → "38".
 */
export function normalizeSpoken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(NUMBER_RE, (w) => String(NUMBER_WORDS[w]))
    .replace(/\b([2-9])0[\s-]+([1-9])\b/g, (_, t, u) => `${t}${u}`)
    .replace(/\b(\d+)\s+point\s+(\d+)\b/g, "$1.$2")
    .replace(/\b(?:q|queue|cue|kew|quarter)\s*-?\s*([1-4])\b/g, "q$1");
}

/** Lowercase words, keeping digits, %, and decimals ("2.4m", "38%"). */
export function words(text: string): string[] {
  return normalizeSpoken(text).match(/[a-z0-9]+(?:[.'][a-z0-9]+)*%?/g) ?? [];
}

export function isStopword(w: string): boolean {
  return STOPWORDS.has(w);
}

export function stem(w: string): string {
  // Numbers and tokens like "q4" / "38%" pass through untouched.
  if (/\d/.test(w)) return w.replace(/%$/, "");
  return stemmer(w.replace(/'s$/, ""));
}

/** Words → stems with stopwords removed. */
export function tokenize(text: string): string[] {
  return words(text)
    .filter((w) => !isStopword(w))
    .map(stem)
    .filter(Boolean);
}

/** Optimal string alignment distance (Damerau-Levenshtein with adjacent transpositions). */
export function editDistance(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (!n) return m;
  if (!m) return n;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => {
    const row = new Array<number>(m + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2][j - 2] + 1);
      }
      d[i][j] = v;
    }
  }
  return d[n][m];
}

/** 0..1 similarity between two stems. Exact = 1. Short tokens and numbers must match exactly. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 4 || b.length < 4) return 0;
  if (/\d/.test(a) || /\d/.test(b)) return 0;
  const dist = editDistance(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}
