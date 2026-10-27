import { describe, expect, it } from "vitest";

import {
  followStep,
  rowsTransform,
  stiffnessFor,
  toDevicePixels,
} from "@/apps/agent/components/conversation/work-log/pin";

/** Run the follow at 60fps until it settles or `maxFrames` pass. */
function run(target: number, start = 0, frames = 240, stiffness = stiffnessFor(340)) {
  let y = start;
  let v = 0;
  const ys: number[] = [];
  for (let i = 0; i < frames; i++) {
    ({ y, velocity: v } = followStep(y, v, target, 1 / 60, stiffness));
    ys.push(y);
  }
  return ys;
}

describe("pin", () => {
  it("puts a resting position on the device pixel grid", () => {
    for (const dpr of [1, 1.25, 1.5, 2]) {
      for (const px of [0.1, 0.4, 1.7, 12.33, 97.9]) {
        const device = toDevicePixels(px, dpr) * dpr;
        expect(Math.abs(device - Math.round(device))).toBeLessThan(1e-9);
      }
    }
    expect(toDevicePixels(2.6, 0)).toBe(3);
  });

  /** Never `""` or `none`: the rows keep one layer for the card's whole life. */
  it("always returns a transform, zero included, moving the rows up", () => {
    expect(rowsTransform(0)).toBe("translate3d(0, 0px, 0)");
    expect(rowsTransform(-4)).toBe("translate3d(0, 0px, 0)");
    expect(rowsTransform(10.5)).toBe("translate3d(0, -10.5px, 0)");
  });

  it("reaches the newest row without overshooting, and stops there", () => {
    const ys = run(120);
    for (const y of ys) expect(y).toBeLessThanOrEqual(120);
    expect(ys.at(-1)).toBe(120);
    // Monotonic: never moves back down.
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1]);
  });

  /** A step arriving raises the speed over a few frames, never in one: the
   *  kick of the spring before this was the surge-and-stop between arrivals. */
  it("eases into a new arrival instead of jumping to speed", () => {
    let y = 0;
    let v = 0;
    const speeds: number[] = [];
    for (let i = 0; i < 6; i++) {
      ({ y, velocity: v } = followStep(y, v, 30, 1 / 60, stiffnessFor(340)));
      speeds.push(v);
    }
    expect(speeds[0]).toBeLessThan(speeds[1]);
    expect(speeds[1]).toBeLessThan(speeds[2]);
  });

  /** A stream of steps: the rows only ever climb, never dip back. */
  it("only climbs through a stream of steps", () => {
    let y = 0;
    let v = 0;
    let target = 0;
    let prev = 0;
    for (let frame = 0; frame < 600; frame++) {
      if (frame % 12 === 0) target += 30; // a 30px step every 200ms at 60fps
      ({ y, velocity: v } = followStep(y, v, target, 1 / 60, stiffnessFor(340)));
      expect(y).toBeGreaterThanOrEqual(prev);
      expect(y).toBeLessThanOrEqual(target);
      prev = y;
    }
  });

  it("follows a longer glide length more slowly", () => {
    expect(stiffnessFor(900)).toBeLessThan(stiffnessFor(340));
    expect(stiffnessFor(150)).toBeGreaterThan(stiffnessFor(340));
  });
});
