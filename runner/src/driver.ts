/** What the agent can see on one surface. Frames and coordinates are in screenshot pixels. */
export interface Element {
  ref: string;
  role: string;
  name: string;
  value?: string;
  frame: Frame;
  /** What this element looks like in a fingerprint, so a held action can check its own target. */
  print?: string;
}

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Shot {
  /** base64 JPEG */
  data: string;
  width: number;
  height: number;
}

export interface Where {
  app: string;
  bundleId: string;
  /** url in a browser, window title elsewhere */
  place: string;
}

/** A cheap summary of the screen, for telling whether a held action is still valid. */
export interface Fingerprint {
  /** where the screen is: the app and window, or the page */
  key: string;
  /** what's on it, from elementPrint */
  elements?: string[];
  /** coarse grayscale thumbnail, for surfaces without structure */
  grid?: number[];
}

export interface View extends Where {
  shot: Shot;
  elements: Element[];
  fingerprint: Fingerprint;
}

export type ClickKind = "left" | "right" | "double" | "triple";
export type Direction = "up" | "down" | "left" | "right";

/** One surface the agent can see and act on. */
export interface Driver {
  readonly kind: "browser" | "desktop";
  look(): Promise<View>;
  /** Quick skips anything slow to read, such as a native app's accessibility tree, and compares on what's left. */
  fingerprint(quick?: boolean): Promise<Fingerprint>;
  where(): Promise<Where>;
  click(kind: ClickKind, x: number, y: number, modifiers?: string): Promise<void>;
  drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void>;
  move(x: number, y: number): Promise<void>;
  scroll(direction: Direction, amount: number, x?: number, y?: number): Promise<void>;
  type(text: string): Promise<void>;
  key(combo: string, repeat?: number): Promise<void>;
  /** A url, or an app name. */
  open(target: string): Promise<void>;
  close(): Promise<void>;
}

const GRID_TOLERANCE = 6;
/** Screens have things that flicker, like rotating hints and timers. Changing this few elements isn't a new screen. */
const MIN_ELEMENT_TOLERANCE = 4;
const ELEMENT_TOLERANCE_SHARE = 0.1;
const POSITION_STEP = 16;

/** An element and roughly where it is, in the driver's own coordinates: if it moves, a held click would miss. */
export const elementPrint = (e: { role: string; name: string; x: number; y: number }) => `${e.role}:${e.name}@${Math.round(e.x / POSITION_STEP)},${Math.round(e.y / POSITION_STEP)}`;

/** How many elements are on one screen but not the other. */
function elementChanges(a: string[], b: string[]): number {
  const counts = new Map<string, number>();
  for (const e of a) counts.set(e, (counts.get(e) ?? 0) + 1);
  let added = 0;
  for (const e of b) {
    const left = counts.get(e) ?? 0;
    if (left) counts.set(e, left - 1);
    else added++;
  }
  return added + [...counts.values()].reduce((sum, n) => sum + n, 0);
}

/**
 * Whether a held action still fits the screen: same place, every element it targets still where it was, little else
 * changed, and no more than a small average brightness change across the thumbnail.
 */
export function sameFingerprint(a: Fingerprint, b: Fingerprint, targets: string[] = []): boolean {
  if (a.key !== b.key) return false;
  if (a.elements && b.elements) {
    if (targets.some((t) => !b.elements!.includes(t))) return false;
    const tolerance = Math.max(MIN_ELEMENT_TOLERANCE, Math.ceil(Math.max(a.elements.length, b.elements.length) * ELEMENT_TOLERANCE_SHARE));
    if (elementChanges(a.elements, b.elements) > tolerance) return false;
  }
  if (!a.grid || !b.grid || a.grid.length !== b.grid.length) return true;
  const diff = a.grid.reduce((sum, v, i) => sum + Math.abs(v - b.grid![i]), 0) / a.grid.length;
  return diff < GRID_TOLERANCE;
}

export const center = (f: Frame) => ({ x: f.x + f.width / 2, y: f.y + f.height / 2 });

export function elementAt(elements: Element[], x: number, y: number): Element | undefined {
  return elements
    .filter((e) => x >= e.frame.x && x < e.frame.x + e.frame.width && y >= e.frame.y && y < e.frame.y + e.frame.height)
    .sort((a, b) => a.frame.width * a.frame.height - b.frame.width * b.frame.height)[0];
}
