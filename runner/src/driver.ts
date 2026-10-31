/** What the agent can see on one surface. Frames and coordinates are in screenshot pixels. */
export interface Element {
  ref: string;
  role: string;
  name: string;
  value?: string;
  frame: Frame;
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
  key: string;
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
  fingerprint(): Promise<Fingerprint>;
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

/** Same structure, and no more than a small average brightness change across the thumbnail. */
export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  if (a.key !== b.key) return false;
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
