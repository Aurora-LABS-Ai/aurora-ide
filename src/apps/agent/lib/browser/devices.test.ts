import { describe, expect, it } from "vitest";

import { DEVICE_PRESETS, deviceSpec, layoutDevice, stepZoom } from "./devices";

describe("layoutDevice", () => {
  const iphone = DEVICE_PRESETS.iphone;

  it("fits the frame to the panel height and centres it", () => {
    const l = layoutDevice(iphone, 560, 700);
    // (700 - 32) / 868 limits it before the width does.
    expect(l.frameScale).toBeCloseTo(668 / 868, 6);
    expect(l.frame.x + l.frame.width / 2).toBeCloseTo(280, 6);
    expect(l.frame.y + l.frame.height / 2).toBeCloseTo(350, 6);
  });

  it("puts the page in the screen, under the status bar", () => {
    const l = layoutDevice(iphone, 560, 700);
    const s = l.frameScale;
    expect(l.page.x).toBeCloseTo(l.frame.x + 20 * s, 6);
    expect(l.page.y).toBeCloseTo(l.frame.y + (20 + 54) * s, 6);
    expect(l.page.width).toBeCloseTo(390 * s, 6);
    expect(l.page.height).toBeCloseTo((830 - 54) * s, 6);
    expect(l.statusBar.y + l.statusBar.height).toBeCloseTo(l.page.y, 6);
  });

  it("gives the page the device's real width, whatever the panel size", () => {
    for (const [w, h] of [[560, 700], [900, 1200], [420, 520]]) {
      const l = layoutDevice(iphone, w, h);
      expect(l.emulation.width).toBe(393);
      // The page's CSS height follows the screen's shape, not the panel's.
      expect(l.emulation.height).toBe(Math.round(((830 - 54) * 393) / 390));
      // Painted size = CSS size × scale lands exactly on the page window.
      expect(l.emulation.width * l.emulation.scale).toBeCloseTo(l.page.width, 6);
    }
  });

  it("never enlarges past actual size", () => {
    expect(layoutDevice(iphone, 3000, 3000).frameScale).toBe(1);
  });

  it("rounds the page's bottom corners by the screen radius at the same scale", () => {
    const l = layoutDevice(DEVICE_PRESETS.android, 560, 700);
    expect(l.bottomRadius).toBeCloseTo(27 * l.frameScale, 6);
  });

  it("builds the payload Rust validates", () => {
    const l = layoutDevice(DEVICE_PRESETS.tablet, 560, 700);
    expect(deviceSpec(DEVICE_PRESETS.tablet, l)).toEqual({
      width: 834,
      height: l.emulation.height,
      deviceScaleFactor: 2,
      mobile: true,
      userAgent: DEVICE_PRESETS.tablet.userAgent,
      scale: l.emulation.scale,
    });
  });
});

describe("stepZoom", () => {
  it("steps through the browser's zoom levels and stops at the ends", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(2, 1)).toBe(2);
    expect(stepZoom(0.5, -1)).toBe(0.5);
    // From an off-step value, to the nearest step in that direction.
    expect(stepZoom(1.05, 1)).toBe(1.1);
  });
});
