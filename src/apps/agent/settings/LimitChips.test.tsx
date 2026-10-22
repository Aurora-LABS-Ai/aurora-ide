import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LimitChips } from "./LimitChips";
import { CONTEXT_WINDOW_CHIPS, formatTokenChip } from "./limit-chips";

describe("formatTokenChip", () => {
  it("writes thousands as K and millions as M", () => {
    expect(formatTokenChip(128_000)).toBe("128K");
    expect(formatTokenChip(262_000)).toBe("262K");
    expect(formatTokenChip(1_000_000)).toBe("1M");
    expect(formatTokenChip(1_500_000)).toBe("1.5M");
    expect(formatTokenChip(5_000_000)).toBe("5M");
  });
});

describe("LimitChips", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const chip = (label: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;

  it("sets the exact token count and marks the chip matching the field", async () => {
    const onPick = vi.fn();
    await act(async () =>
      root.render(
        <LimitChips
          label="context window"
          values={CONTEXT_WINDOW_CHIPS}
          current={262_000}
          onPick={onPick}
        />,
      ),
    );
    expect(chip("262K").getAttribute("aria-pressed")).toBe("true");
    expect(chip("1M").getAttribute("aria-pressed")).toBe("false");

    await act(async () => chip("1M").click());
    expect(onPick).toHaveBeenCalledWith(1_000_000);
  });
});
