import { describe, expect, it } from "vitest";
import { sameFingerprint } from "./driver.ts";
import { appAllowed, commandTaught, connectionAllowed, insideBounds, keyBlocked, normalizeCombo, originAllowed, riskyName, toScreen, type Limits } from "./safety.ts";

const limits: Limits = { apps: ["TextEdit", "com.apple.Terminal"], origins: ["http://localhost:5173"], taughtCommands: ["npm test"] };
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

  it("knows taught commands", () => {
    expect(commandTaught(limits, " npm test\n")).toBe(true);
    expect(commandTaught(limits, "rm -rf ~")).toBe(false);
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

describe("local connection", () => {
  const expected = { origins: ["http://localhost:5173"], token: "t" };

  it("takes only the console with the right token", () => {
    expect(connectionAllowed("http://localhost:5173", "t", expected)).toBe(true);
    expect(connectionAllowed("https://evil.example", "t", expected)).toBe(false);
    expect(connectionAllowed("http://localhost:5173", "nope", expected)).toBe(false);
    expect(connectionAllowed(undefined, "t", expected)).toBe(false);
  });
});

describe("fingerprints", () => {
  it("ignores small brightness changes, not real ones", () => {
    const grid = Array(144).fill(100);
    expect(sameFingerprint({ key: "a", grid }, { key: "a", grid: grid.map((v) => v + 2) })).toBe(true);
    expect(sameFingerprint({ key: "a", grid }, { key: "a", grid: grid.map((v) => v + 40) })).toBe(false);
    expect(sameFingerprint({ key: "a" }, { key: "b" })).toBe(false);
  });
});
