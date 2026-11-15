import type { Moment } from "./timeline.ts";

const HIDDEN = "[hidden]";

/** Credentials with a recognizable shape. Ordinary long strings like commit hashes are left alone. */
const SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_\w{20,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
];

/** The label stays, so the text still reads: PASSWORD=[hidden]. */
const LABELLED = [
  /\b([\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[\w-]*["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;&]+)/gi,
  /(--?(?:password|passwd|pwd|secret|token|api-key)\s+)(\S+)/gi,
  /(\b(?:bearer|token)\s+(?:is\s+)?)([A-Za-z0-9._~+/=-]{16,})/gi,
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(?=@)/gi,
];

/** Removes credentials from text on its way to Claude. Screenshots can't be masked this way. */
export function maskSecrets(text: string): string {
  const shaped = SHAPES.reduce((t, shape) => t.replace(shape, HIDDEN), text);
  return LABELLED.reduce((t, labelled) => t.replace(labelled, `$1${HIDDEN}`), shaped);
}

export function maskMoments(moments: Moment[]): Moment[] {
  return moments.map((m) => {
    if (m.kind === "typed" || m.kind === "said") return { ...m, text: maskSecrets(m.text) };
    if (m.kind === "click" && m.name) return { ...m, name: maskSecrets(m.name) };
    return m;
  });
}
