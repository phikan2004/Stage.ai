import { describe, expect, it } from "vitest";
import { computeZoom } from "../zoom";

/** The viewport [0,1] maps back to slide coords [(-t)/s, (1-t)/s]; it must stay inside [0,1]. */
function visible(z: ReturnType<typeof computeZoom>) {
  return {
    x0: -z.tx / z.scale,
    x1: (1 - z.tx) / z.scale,
    y0: -z.ty / z.scale,
    y1: (1 - z.ty) / z.scale,
  };
}

function expectInsideSlide(z: ReturnType<typeof computeZoom>) {
  const v = visible(z);
  expect(v.x0).toBeGreaterThanOrEqual(-1e-9);
  expect(v.y0).toBeGreaterThanOrEqual(-1e-9);
  expect(v.x1).toBeLessThanOrEqual(1 + 1e-9);
  expect(v.y1).toBeLessThanOrEqual(1 + 1e-9);
}

function expectContains(z: ReturnType<typeof computeZoom>, b: { x: number; y: number; w: number; h: number }) {
  const v = visible(z);
  expect(v.x0).toBeLessThanOrEqual(b.x + 1e-9);
  expect(v.y0).toBeLessThanOrEqual(b.y + 1e-9);
  expect(v.x1).toBeGreaterThanOrEqual(b.x + b.w - 1e-9);
  expect(v.y1).toBeGreaterThanOrEqual(b.y + b.h - 1e-9);
}

describe("computeZoom", () => {
  it("centers a central region", () => {
    const b = { x: 0.35, y: 0.35, w: 0.3, h: 0.3 };
    const z = computeZoom(b, 0.05, 3);
    expect(z.scale).toBeCloseTo(1 / 0.4);
    const v = visible(z);
    expect((v.x0 + v.x1) / 2).toBeCloseTo(0.5);
    expect((v.y0 + v.y1) / 2).toBeCloseTo(0.5);
    expectContains(z, b);
  });

  it("caps zoom at maxZoom", () => {
    const z = computeZoom({ x: 0.5, y: 0.5, w: 0.01, h: 0.01 }, 0, 3);
    expect(z.scale).toBe(3);
  });

  it("returns identity for a full-slide region", () => {
    const z = computeZoom({ x: 0, y: 0, w: 1, h: 1 }, 0.04, 3);
    expect(z).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  const corners = [
    ["top-left", { x: 0, y: 0, w: 0.2, h: 0.2 }],
    ["top-right", { x: 0.8, y: 0, w: 0.2, h: 0.2 }],
    ["bottom-left", { x: 0, y: 0.8, w: 0.2, h: 0.2 }],
    ["bottom-right", { x: 0.8, y: 0.8, w: 0.2, h: 0.2 }],
    ["left edge", { x: 0, y: 0.4, w: 0.1, h: 0.2 }],
    ["right edge", { x: 0.9, y: 0.4, w: 0.1, h: 0.2 }],
    ["top edge", { x: 0.4, y: 0, w: 0.2, h: 0.1 }],
    ["bottom edge", { x: 0.4, y: 0.9, w: 0.2, h: 0.1 }],
    ["wide strip", { x: 0, y: 0.95, w: 1, h: 0.05 }],
  ] as const;

  for (const [name, b] of corners) {
    it(`never shows area outside the slide: ${name}`, () => {
      const z = computeZoom(b, 0.05, 3);
      expect(z.scale).toBeGreaterThan(1 - 1e-9);
      expectInsideSlide(z);
      expectContains(z, b);
    });
  }

  it("handles out-of-range input boxes without leaving the slide", () => {
    const z = computeZoom({ x: -0.2, y: 1.1, w: 0.1, h: 0.1 }, 0.02, 3);
    expectInsideSlide(z);
  });
});
