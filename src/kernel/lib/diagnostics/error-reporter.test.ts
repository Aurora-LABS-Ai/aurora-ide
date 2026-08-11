import { describe, expect, it } from "vitest";

import {
  DEDUPE_MS,
  MAX_PER_MINUTE,
  admit,
  createGate,
  formatLogArgs,
} from "@/kernel/lib/diagnostics/error-reporter";

describe("error reporter — what gets written", () => {
  it("carries the stack, not just the message", () => {
    // "Cannot read properties of undefined" names a symptom that could come
    // from anywhere. An entry that cannot be traced to a line is not worth
    // the disk it costs.
    const error = new Error("boom");
    const line = formatLogArgs(["render failed:", error]);
    expect(line).toContain("render failed:");
    expect(line).toContain("Error: boom");
    expect(line).toContain("error-reporter.test");
  });

  it("survives a value that cannot be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatLogArgs([circular])).not.toThrow();
    expect(formatLogArgs([circular])).toContain("Object");
  });

  it("keeps null and undefined legible instead of dropping them", () => {
    expect(formatLogArgs(["value was", null, undefined])).toBe("value was null undefined");
  });

  it("clamps a huge payload and says that it did", () => {
    const line = formatLogArgs(["x".repeat(20_000)]);
    expect(line.length).toBeLessThan(9_000);
    expect(line).toContain("truncated");
  });
});

describe("error reporter — the rate gate", () => {
  it("collapses the same failure repeating inside the dedupe window", () => {
    const gate = createGate(0);
    expect(admit(gate, "same", 0)).toBe("send");
    expect(admit(gate, "same", DEDUPE_MS - 1)).toBe("drop");
    expect(admit(gate, "different", DEDUPE_MS - 1)).toBe("send");
    expect(admit(gate, "same", DEDUPE_MS + 1)).toBe("send");
  });

  it("caps a flood, but says so before going quiet", () => {
    // A render loop emits thousands of errors a second and would rotate the
    // real cause out of a 5 MB file in seconds. Silence without explanation is
    // the failure mode that makes a log lie, so the cap announces itself once.
    const gate = createGate(0);
    for (let i = 0; i < MAX_PER_MINUTE; i += 1) {
      expect(admit(gate, `failure ${i}`, i)).toBe("send");
    }
    expect(admit(gate, "one too many", MAX_PER_MINUTE)).toBe("announce-throttle");
    expect(admit(gate, "and another", MAX_PER_MINUTE + 1)).toBe("drop");
  });

  it("starts listening again on the next minute", () => {
    const gate = createGate(0);
    for (let i = 0; i < MAX_PER_MINUTE; i += 1) admit(gate, `failure ${i}`, i);
    expect(admit(gate, "capped", 1_000)).toBe("announce-throttle");
    expect(admit(gate, "still capped", 60_000)).toBe("send");
  });
});
