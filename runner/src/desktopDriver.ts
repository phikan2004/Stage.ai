import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ClickKind, Direction, Driver, Element, Fingerprint, Frame, Shot, View, Where } from "./driver.ts";
import type { Display, Helper } from "./helper.ts";
import { insideBounds, toScreen } from "./safety.ts";

const MAX_SIDE = 2000;
const GRID_SIDE = 160;
const COUNTS: Record<ClickKind, number> = { left: 1, right: 1, double: 2, triple: 3 };

interface RawElement extends Frame {
  role: string;
  name: string;
  value?: string;
}

interface Front {
  app?: string;
  bundleId?: string;
  title?: string;
  frame?: Frame;
}

const elementKey = (e: Pick<RawElement, "role" | "name">) => `${e.role}:${e.name}`;

/** The whole stage display, through the Swift helper. Nothing here can reach another display. */
export class DesktopDriver implements Driver {
  readonly kind = "desktop";
  private shotSize = { width: 1, height: 1 };

  constructor(
    private helper: Helper,
    private display: Display,
  ) {}

  private async front(): Promise<Front> {
    return this.helper.call<Front>("frontmost");
  }

  private toWhere(f: Front): Where {
    return { app: f.app ?? "", bundleId: f.bundleId ?? "", place: f.title ?? "" };
  }

  async where(): Promise<Where> {
    return this.toWhere(await this.front());
  }

  private async capture(maxSide: number): Promise<Shot & { grid: number[] }> {
    return this.helper.call("capture", { display: this.display.id, maxSide });
  }

  private async tree(): Promise<RawElement[]> {
    return (await this.helper.call<{ elements: RawElement[] }>("tree")).elements.filter((e) =>
      insideBounds(this.display, e.x + e.width / 2, e.y + e.height / 2),
    );
  }

  private key_(f: Front, raw: RawElement[]) {
    return [f.app, f.title, ...raw.map(elementKey)].join("|");
  }

  async look(): Promise<View> {
    const [shot, f, raw] = await Promise.all([this.capture(MAX_SIDE), this.front(), this.tree()]);
    const { grid, ...image } = shot;
    this.shotSize = { width: image.width, height: image.height };
    const sx = image.width / this.display.width;
    const sy = image.height / this.display.height;
    const elements: Element[] = raw.map((e, i) => ({
      ref: `e${i + 1}`,
      role: e.role,
      name: e.name,
      value: e.value,
      frame: { x: (e.x - this.display.x) * sx, y: (e.y - this.display.y) * sy, width: e.width * sx, height: e.height * sy },
    }));
    return { ...this.toWhere(f), shot: image, elements, fingerprint: { key: this.key_(f, raw), grid } };
  }

  async fingerprint(): Promise<Fingerprint> {
    const [{ grid }, f, raw] = await Promise.all([this.capture(GRID_SIDE), this.front(), this.tree()]);
    return { key: this.key_(f, raw), grid };
  }

  private point(x: number, y: number) {
    return toScreen(this.display, this.shotSize.width, this.shotSize.height, x, y);
  }

  /** Keys go to the focused window, so that window must be on the stage display. */
  private async requireFocusOnStage() {
    const { frame, app } = await this.front();
    if (!frame) throw new Error(`${app ?? "The front app"} has no focused window.`);
    if (!insideBounds(this.display, frame.x + frame.width / 2, frame.y + frame.height / 2)) {
      throw new Error(`${app}'s focused window isn't on the stage display.`);
    }
  }

  async click(kind: ClickKind, x: number, y: number, modifiers?: string) {
    await this.helper.call("click", { ...this.point(x, y), button: kind === "right" ? "right" : "left", count: COUNTS[kind], modifiers });
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number) {
    const from = this.point(fromX, fromY);
    await this.helper.call("drag", { fromX: from.x, fromY: from.y, ...this.point(toX, toY) });
  }

  async move(x: number, y: number) {
    await this.helper.call("move", this.point(x, y));
  }

  async scroll(direction: Direction, amount: number, x?: number, y?: number) {
    const at = x !== undefined && y !== undefined ? this.point(x, y) : {};
    const step = (d: Direction) => (direction === d ? amount : 0);
    await this.helper.call("scroll", { ...at, dy: step("up") - step("down"), dx: step("left") - step("right") });
  }

  async type(text: string) {
    await this.requireFocusOnStage();
    await this.helper.call("type", { text });
  }

  async key(combo: string, repeat = 1) {
    await this.requireFocusOnStage();
    await this.helper.call("key", { combo, repeat });
  }

  async open(target: string) {
    await promisify(execFile)("open", /^https?:/.test(target) ? [target] : ["-a", target]);
    await new Promise((r) => setTimeout(r, 500));
    const inset = 40;
    await this.helper.call("place", {
      x: this.display.x + inset,
      y: this.display.y + inset,
      width: this.display.width - inset * 2,
      height: this.display.height - inset * 2,
    });
  }

  async close() {}
}
