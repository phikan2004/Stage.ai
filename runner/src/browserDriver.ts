import { chromium, type BrowserContext, type Page } from "playwright-core";
import type { ClickKind, Direction, Driver, Element, Fingerprint, View, Where } from "./driver.ts";
import { originAllowed, type Limits } from "./safety.ts";

const JPEG_QUALITY = 70;
const CURSOR_GLIDE_MS = 250;

/** Playwright clicks are invisible, so the audience gets a cursor that glides to each target. */
function installCursor() {
  const add = () => {
    if (document.getElementById("__stage_cursor")) return;
    const c = document.createElement("div");
    c.id = "__stage_cursor";
    c.innerHTML =
      '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M4 2l16 10-7 2-3 7z" fill="#111" stroke="#fff" stroke-width="1.5"/></svg>';
    c.style.cssText =
      "position:fixed;left:0;top:0;width:24px;height:24px;z-index:2147483647;pointer-events:none;transition:transform 250ms cubic-bezier(.22,.61,.36,1);transform:translate(40px,40px)";
    document.documentElement.appendChild(c);
  };
  if (document.documentElement) add();
  document.addEventListener("DOMContentLoaded", add);
}

/** Visible interactive elements. Password values are never read. */
function collect(tag: boolean) {
  const sel = 'a[href],button,input,select,textarea,summary,[role],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])';
  const roles = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option", "combobox", "textbox", "searchbox"]);
  const out: { ref: string; role: string; name: string; value?: string; frame: { x: number; y: number; width: number; height: number } }[] = [];
  document.querySelectorAll<HTMLElement>("[data-stage-ref]").forEach((e) => tag && e.removeAttribute("data-stage-ref"));
  for (const el of document.querySelectorAll<HTMLElement>(sel)) {
    if (out.length >= 150) break;
    const role = el.getAttribute("role") ?? (el.tagName === "A" ? "link" : el.tagName === "INPUT" ? ((el as HTMLInputElement).type || "text") : el.tagName.toLowerCase());
    if (el.hasAttribute("role") && !roles.has(role)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || s.opacity === "0") continue;
    const input = el as HTMLInputElement;
    const label = el.getAttribute("aria-label") ?? el.innerText?.trim() ?? "";
    const name = (label || input.placeholder || el.title || (el as HTMLImageElement).alt || "").replace(/\s+/g, " ").slice(0, 80);
    const ref = `e${out.length + 1}`;
    if (tag) el.setAttribute("data-stage-ref", ref);
    const value = input.type !== "password" && typeof input.value === "string" && input.value ? input.value.slice(0, 80) : undefined;
    out.push({ ref, role, name, value, frame: { x: r.x, y: r.y, width: r.width, height: r.height } });
  }
  return out;
}

const elementKey = (url: string, elements: Pick<Element, "role" | "name">[]) => [url, ...elements.map((e) => `${e.role}:${e.name}`)].join("|");

/** Real Chrome with its own profile, on the stage display. Pages outside the allowlist don't load. */
export class BrowserDriver implements Driver {
  readonly kind = "browser";

  private constructor(
    private context: BrowserContext,
    private page: Page,
  ) {}

  static async start(opts: { profileDir: string; limits: Limits; window?: { x: number; y: number; width: number; height: number } }): Promise<BrowserDriver> {
    const w = opts.window;
    const context = await chromium.launchPersistentContext(opts.profileDir, {
      channel: "chrome",
      headless: false,
      viewport: null,
      args: w ? [`--window-position=${w.x},${w.y}`, `--window-size=${w.width},${w.height}`] : [],
    });
    await context.addInitScript(installCursor);
    await context.route("**/*", (route) => {
      const req = route.request();
      if (req.isNavigationRequest() && req.frame().parentFrame() === null && !originAllowed(opts.limits, req.url())) return route.abort("blockedbyclient");
      return route.fallback();
    });
    const page = context.pages()[0] ?? (await context.newPage());
    return new BrowserDriver(context, page);
  }

  private async active(): Promise<Page> {
    const pages = this.context.pages();
    this.page = pages[pages.length - 1] ?? this.page;
    return this.page;
  }

  async where(): Promise<Where> {
    const page = await this.active();
    return { app: "Google Chrome", bundleId: "com.google.Chrome", place: page.url() };
  }

  async fingerprint(): Promise<Fingerprint> {
    const page = await this.active();
    return { key: elementKey(page.url(), await page.evaluate(collect, false)) };
  }

  async look(): Promise<View> {
    const page = await this.active();
    const buf = await page.screenshot({ type: "jpeg", quality: JPEG_QUALITY, scale: "css" });
    // After the screenshot, so the refs are never older than the picture.
    const elements = await page.evaluate(collect, true);
    const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    return {
      ...(await this.where()),
      shot: { data: buf.toString("base64"), ...size },
      elements,
      fingerprint: { key: elementKey(page.url(), elements) },
    };
  }

  private async cursorTo(x: number, y: number) {
    const page = await this.active();
    await page.evaluate(
      ([cx, cy]) => {
        const c = document.getElementById("__stage_cursor");
        if (c) c.style.transform = `translate(${cx}px,${cy}px)`;
      },
      [x, y],
    );
    await page.waitForTimeout(CURSOR_GLIDE_MS);
    await page.mouse.move(x, y);
  }

  async click(kind: ClickKind, x: number, y: number) {
    await this.cursorTo(x, y);
    const page = await this.active();
    await page.mouse.click(x, y, { button: kind === "right" ? "right" : "left", clickCount: kind === "double" ? 2 : kind === "triple" ? 3 : 1 });
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number) {
    await this.cursorTo(fromX, fromY);
    const page = await this.active();
    await page.mouse.down();
    await this.cursorTo(toX, toY);
    await page.mouse.up();
  }

  async move(x: number, y: number) {
    await this.cursorTo(x, y);
  }

  async scroll(direction: Direction, amount: number, x?: number, y?: number) {
    if (x !== undefined && y !== undefined) await this.cursorTo(x, y);
    const px = amount * 100;
    const page = await this.active();
    await page.mouse.wheel(direction === "left" ? -px : direction === "right" ? px : 0, direction === "up" ? -px : direction === "down" ? px : 0);
  }

  async type(text: string) {
    const page = await this.active();
    await page.keyboard.type(text, { delay: 18 });
  }

  async key(combo: string, repeat = 1) {
    const page = await this.active();
    const names: Record<string, string> = { cmd: "Meta", super: "Meta", command: "Meta", ctrl: "Control", alt: "Alt", option: "Alt", shift: "Shift", return: "Enter", enter: "Enter", esc: "Escape", escape: "Escape", space: "Space", tab: "Tab", backspace: "Backspace", delete: "Delete", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", pageup: "PageUp", pagedown: "PageDown" };
    const keys = combo.split("+").map((k) => k.trim()).map((k) => names[k.toLowerCase()] ?? k);
    for (let i = 0; i < repeat; i++) await page.keyboard.press(keys.join("+"));
  }

  async open(target: string) {
    const page = await this.active();
    await page.goto(target, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => {});
  }

  async close() {
    await this.context.close();
  }
}
