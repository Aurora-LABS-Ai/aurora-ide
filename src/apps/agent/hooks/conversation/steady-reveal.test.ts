import { describe, expect, it } from "vitest";

import {
  STEADY_DELAY_MS,
  createSteadyTrack,
  recordArrival,
  steadyDone,
  steadyLength,
} from "@/apps/agent/hooks/conversation/steady-reveal";

const D = STEADY_DELAY_MS;

describe("steady reveal", () => {
  it("shows text that was already there immediately", () => {
    const track = createSteadyTrack(1000, 120);
    expect(steadyLength(track, 1000)).toBe(120);
    expect(steadyDone(track, 1000)).toBe(true);
  });

  it("spreads a burst evenly over the gap before it", () => {
    const track = createSteadyTrack(0, 0);
    recordArrival(track, 250, 10);
    recordArrival(track, 350, 110); // 100 more chars, 100ms later
    // Played back D late, at the rate it arrived: 1 char per ms.
    expect(steadyLength(track, 350 + D - 100)).toBe(10);
    expect(steadyLength(track, 350 + D - 75)).toBe(35);
    expect(steadyLength(track, 350 + D - 50)).toBe(60);
    expect(steadyLength(track, 350 + D)).toBe(110);
    expect(steadyDone(track, 350 + D)).toBe(true);
  });

  it("moves at one speed through bursts of different sizes", () => {
    // A provider that sends 10 chars, then 90, then 20, every 50ms.
    const track = createSteadyTrack(0, 0);
    recordArrival(track, 50, 10);
    recordArrival(track, 100, 100);
    recordArrival(track, 150, 120);
    const at = (t: number) => steadyLength(track, t + D);
    // Within each interval the step per ms is constant: no surge-then-crawl.
    expect(at(75) - at(60)).toBe(at(90) - at(75));
  });

  it("does not jump after a pause longer than the delay", () => {
    const track = createSteadyTrack(0, 50);
    // Nothing for a full second, then 200 chars at once.
    recordArrival(track, 1000, 250);
    // The moment it lands the screen is still where the pause left it…
    expect(steadyLength(track, 1000)).toBe(50);
    // …and the burst plays out over the delay, not in one frame.
    expect(steadyLength(track, 1000 + D / 2)).toBe(150);
    expect(steadyLength(track, 1000 + D)).toBe(250);
  });

  it("never goes backwards and keeps the track short", () => {
    const track = createSteadyTrack(0, 0);
    let last = 0;
    for (let t = 10; t <= 2000; t += 10) {
      recordArrival(track, t, t * 3);
      const len = steadyLength(track, t);
      expect(len).toBeGreaterThanOrEqual(last);
      last = len;
    }
    expect(track.samples.length).toBeLessThan(40);
  });

  it("ignores an arrival that adds nothing", () => {
    const track = createSteadyTrack(0, 10);
    recordArrival(track, 50, 10);
    expect(track.samples).toHaveLength(1);
  });
});
