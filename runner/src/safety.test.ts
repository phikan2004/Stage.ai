import { describe, expect, it } from "vitest";
import { elementPrint, sameFingerprint } from "./driver.ts";
import { actionTaught, appAllowed, commandTaught, consoleOnStage, openTarget, connectionAllowed, insideBounds, keyBlocked, normalizeCombo, originAllowed, pairAllowed, riskyName, toScreen, type Limits } from "./safety.ts";

const limits: Limits = { apps: ["TextEdit", "com.apple.Terminal"], origins: ["http://localhost:5173"], taughtCommands: ["npm test"], taughtActions: ["Send invoice"] };
const stage = { x: 1920, y: 0, width: 1920, height: 1080 };

describe("allowlist", () => {
  it("matches apps by name or bundle id", () => {
    expect(appAllowed(limits, "textedit", "x")).toBe(true);
    expect(appAllowed(limits, "Terminal", "com.apple.Terminal")).toBe(true);
    expect(appAllowed(limits, "Mail", "com.apple.mail")).toBe(false);
  });

  it("never allows Claude or system apps, even if a show lists them", () => {
    const listed: Limits = { ...limits, apps: ["Claude", "System Settings", "com.anthropic.claudefordesktop"] };
    expect(appAllowed(listed, "Claude", "com.anthropic.claudefordesktop")).toBe(false);
    expect(appAllowed(listed, "System Settings", "com.apple.systempreferences")).toBe(false);
  });

  it("matches whole origins, not lookalikes", () => {
    expect(originAllowed(limits, "http://localhost:5173/#/m/1")).toBe(true);
    expect(originAllowed(limits, "about:blank")).toBe(true);
    expect(originAllowed(limits, "http://localhost:5173.evil.example/")).toBe(false);
    expect(originAllowed(limits, "not a url")).toBe(false);
  });

  it("treats www and the bare address as one site", () => {
    const apple: Limits = { ...limits, origins: ["https://www.apple.com"] };
    expect(originAllowed(apple, "https://apple.com/macbook-pro/")).toBe(true);
    expect(originAllowed({ ...limits, origins: ["https://apple.com"] }, "https://www.apple.com/")).toBe(true);
    expect(originAllowed(apple, "https://store.apple.com/")).toBe(false);
    expect(originAllowed(apple, "http://www.apple.com/")).toBe(false);
  });

  it("reads a bare address as a website and a name as an app", () => {
    expect(openTarget("apple.com")).toBe("https://apple.com");
    expect(openTarget("platform.claude.com/dashboard")).toBe("https://platform.claude.com/dashboard");
    expect(openTarget("https://apple.com")).toBe("https://apple.com");
    expect(openTarget("Google Chrome")).toBe("Google Chrome");
    expect(openTarget("Visual Studio Code.app")).toBe("Visual Studio Code.app");
  });

  it("knows taught commands", () => {
    expect(commandTaught(limits, " npm test\n")).toBe(true);
    expect(commandTaught(limits, "rm -rf ~")).toBe(false);
  });

  it("knows taught actions, whatever the case", () => {
    expect(actionTaught(limits, " send invoice")).toBe(true);
    expect(actionTaught(limits, "Delete account")).toBe(false);
  });
});

describe("shortcuts", () => {
  it("normalizes spelling and order", () => {
    expect(normalizeCombo("Shift+Super+A")).toBe("cmd+shift+a");
    expect(normalizeCombo("control+Up")).toBe("ctrl+up");
  });

  it("blocks ways out of the app", () => {
    for (const k of ["cmd+space", "super+space", "cmd+tab", "ctrl+right", "option+command+esc"]) expect(keyBlocked(k), k).toBe(true);
    for (const k of ["cmd+s", "Return", "cmd+n"]) expect(keyBlocked(k), k).toBe(false);
  });
});

describe("risky names", () => {
  it("catches whole words only", () => {
    expect(riskyName("Delete account")).toBe(true);
    expect(riskyName("Sign out")).toBe(true);
    expect(riskyName("Send invoice")).toBe(true);
    expect(riskyName("Sender details")).toBe(false);
    expect(riskyName("Repost")).toBe(false);
  });
});

describe("display fence", () => {
  it("maps screenshot pixels onto the stage display", () => {
    expect(toScreen(stage, 960, 540, 480, 270)).toEqual({ x: 2880, y: 540 });
  });

  it("refuses points outside the screenshot", () => {
    expect(() => toScreen(stage, 960, 540, -1, 10)).toThrow();
    expect(() => toScreen(stage, 960, 540, 960, 10)).toThrow();
    expect(() => toScreen(stage, 960, 540, Number.NaN, 10)).toThrow();
  });

  it("every mapped point stays on the stage display", () => {
    const p = toScreen(stage, 960, 540, 959, 539);
    expect(insideBounds(stage, p.x, p.y)).toBe(true);
    expect(insideBounds(stage, 100, 100)).toBe(false);
  });
});

describe("console placement", () => {
  const onStage = { x: 2000, y: 100, width: 800, height: 600 };

  it("spots the Stage page on the stage display", () => {
    expect(consoleOnStage({ title: "Stage - Google Chrome", frame: onStage }, stage)).toBe(true);
  });

  it("is fine with it on another display, or with any other window", () => {
    expect(consoleOnStage({ title: "Stage - Google Chrome", frame: { ...onStage, x: 100 } }, stage)).toBe(false);
    expect(consoleOnStage({ title: "Acme dashboard", frame: onStage }, stage)).toBe(false);
    expect(consoleOnStage({ title: "Stage" }, stage)).toBe(false);
  });
});

describe("local connection", () => {
  const expected = { origins: ["http://localhost:5173"], token: "t" };

  it("takes only the console with the right token", () => {
    expect(connectionAllowed("http://localhost:5173", "t", expected)).toBe(true);
    expect(connectionAllowed("https://evil.example", "t", expected)).toBe(false);
    expect(connectionAllowed("http://localhost:5173", "nope", expected)).toBe(false);
    expect(connectionAllowed(undefined, "t", expected)).toBe(false);
  });

  it("hands the token only to the console's own origin", () => {
    expect(pairAllowed("http://localhost:5173", expected.origins)).toBe(true);
    expect(pairAllowed("https://evil.example", expected.origins)).toBe(false);
    expect(pairAllowed("http://localhost:5173.evil.example", expected.origins)).toBe(false);
    expect(pairAllowed(undefined, expected.origins)).toBe(false);
  });
});

describe("fingerprints", () => {
  it("ignores small brightness changes, not real ones", () => {
    const grid = Array(144).fill(100);
    expect(sameFingerprint({ key: "a", grid }, { key: "a", grid: grid.map((v) => v + 2) })).toBe(true);
    expect(sameFingerprint({ key: "a", grid }, { key: "a", grid: grid.map((v) => v + 40) })).toBe(false);
    expect(sameFingerprint({ key: "a" }, { key: "b" })).toBe(false);
  });

  const screen = Array.from({ length: 30 }, (_, i) => elementPrint({ role: "button", name: `Item ${i}`, x: 0, y: i * 40 }));

  it("ignores a hint that flickers", () => {
    const flicker = screen.with(29, elementPrint({ role: "textbox", name: "Type / for commands", x: 0, y: 1160 }));
    expect(sameFingerprint({ key: "a", elements: screen }, { key: "a", elements: flicker })).toBe(true);
  });

  it("notices when the held action's own target changes, however small the change", () => {
    const flicker = screen.with(3, elementPrint({ role: "button", name: "Other", x: 0, y: 120 }));
    expect(sameFingerprint({ key: "a", elements: screen }, { key: "a", elements: flicker }, [screen[3]])).toBe(false);
    expect(sameFingerprint({ key: "a", elements: screen }, { key: "a", elements: flicker }, [screen[4]])).toBe(true);
  });

  it("notices when its target moves", () => {
    const moved = screen.with(3, elementPrint({ role: "button", name: "Item 3", x: 0, y: 200 }));
    expect(sameFingerprint({ key: "a", elements: screen }, { key: "a", elements: moved }, [screen[3]])).toBe(false);
  });

  it("treats a scroll or a new page as a new screen", () => {
    const scrolled = screen.map((_, i) => elementPrint({ role: "button", name: `Item ${i}`, x: 0, y: i * 40 + 200 }));
    expect(sameFingerprint({ key: "a", elements: screen }, { key: "a", elements: scrolled })).toBe(false);
  });

  it("notices a different window", () => {
    expect(sameFingerprint({ key: "a", elements: screen }, { key: "b", elements: screen })).toBe(false);
  });
});
