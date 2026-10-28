import { describe, expect, it } from "vitest";

import { fraction, memorySize, meterTone, percent, uptime, usedOf } from "./machine-format";

describe("machine card wording", () => {
  it("states memory as used of total, one decimal below 100 GB", () => {
    expect(usedOf(3.1e9, 25.1e9)).toBe("3.1 of 25.1 GB");
    expect(usedOf(37e9, 47e9)).toBe("37.0 of 47.0 GB");
    expect(usedOf(412e9, 1000e9)).toBe("412 of 1000 GB");
  });

  it("sizes a process in MB until it reaches a gigabyte", () => {
    expect(memorySize(663_784 * 1024)).toBe("680 MB");
    expect(memorySize(24e6)).toBe("24 MB");
    expect(memorySize(1.24e9)).toBe("1.2 GB");
  });

  it("rounds percentages", () => {
    expect(percent(2.37)).toBe("2%");
    expect(percent(99.6)).toBe("100%");
  });

  it("names uptime in the longest whole unit", () => {
    expect(uptime(6 * 7 * 86400 + 3000)).toBe("6 weeks");
    expect(uptime(86400)).toBe("1 day");
    expect(uptime(5 * 3600 + 100)).toBe("5 hours");
    expect(uptime(30)).toBe("1 min");
  });

  it("turns a meter orange past 75% and red past 90%", () => {
    expect(meterTone(0.74)).toBe("ok");
    expect(meterTone(0.79)).toBe("warn");
    expect(meterTone(0.95)).toBe("bad");
    expect(fraction(5, 0)).toBe(0);
    expect(fraction(50, 10)).toBe(1);
  });
});
