import { describe, expect, it } from "vitest";
import { placePopup } from "../popupPosition";

const popup = { w: 200, h: 120 };
const area = { w: 1000, h: 600 };
const inside = (p: { x: number; y: number }) => p.x >= 0 && p.y >= 0 && p.x + popup.w <= area.w && p.y + popup.h <= area.h;

describe("placePopup", () => {
  it("sits off the top-right corner when there's room", () => {
    expect(placePopup({ x: 100, y: 100, w: 200, h: 100 }, popup, area)).toEqual({ x: 310, y: 100 });
  });

  it("moves to the left near the right edge", () => {
    expect(placePopup({ x: 700, y: 100, w: 280, h: 100 }, popup, area)).toEqual({ x: 490, y: 100 });
  });

  it("stays on screen near the bottom right", () => {
    const p = placePopup({ x: 600, y: 520, w: 380, h: 70 }, popup, area);
    expect(inside(p)).toBe(true);
  });

  it("falls back to sitting inside a box that fills the area", () => {
    expect(inside(placePopup({ x: 10, y: 10, w: 980, h: 580 }, popup, area))).toBe(true);
  });
});
