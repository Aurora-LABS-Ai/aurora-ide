import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CARD_SETTLE_MS,
  useReservedCostLines,
  useSticky,
  useThrottled,
} from "@/apps/agent/components/composer/context-card-stability";

/**
 * The context card is fed by four stores that each republish on every API
 * response — one per tool iteration, so fifty-odd on a long turn. Rendered
 * straight through, that resized the card dozens of times under an open hover
 * and strobed seventeen numbers. These two hooks are the whole fix, so what
 * they promise is worth pinning: a value settles instead of strobing, and a
 * row that has earned its slot never gives it back.
 */

/**
 * A minimal mount helper. The project has no testing-library, and one test
 * file is not a reason to add a dependency — `react-dom` is already here and
 * these hooks need nothing more than a container and `act`.
 */
function mount(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(element);
  });
  return {
    text: () => container.textContent ?? "",
    rerender: (next: React.ReactElement) => act(() => void root.render(next)),
    tick: (ms: number) => act(() => void vi.advanceTimersByTime(ms)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

let mounted: ReturnType<typeof mount> | null = null;
const open = (element: React.ReactElement) => (mounted = mount(element));

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
});

describe("settling a value that updates on every request", () => {
  const Probe: React.FC<{ value: number }> = ({ value }) => (
    <span>{useThrottled(value)}</span>
  );

  it("shows the first value straight away", () => {
    // A card that opened blank for a second would trade one flicker for worse.
    expect(open(<Probe value={1} />).text()).toBe("1");
  });

  it("publishes once for a burst, and publishes the LAST value", () => {
    const card = open(<Probe value={1} />);
    // Fifty responses inside one settle window — the shape of a long turn.
    for (let i = 2; i <= 51; i++) {
      card.rerender(<Probe value={i} />);
      card.tick(5);
    }
    // Still on the opening figure: nothing in between was meant to be read.
    expect(card.text()).toBe("1");
    card.tick(CARD_SETTLE_MS);
    // And the one that lands is the newest, not some stale midpoint.
    expect(card.text()).toBe("51");
  });

  it("lets a later change through once the window has passed", () => {
    const card = open(<Probe value={1} />);
    card.tick(CARD_SETTLE_MS * 2);
    card.rerender(<Probe value={2} />);
    card.tick(CARD_SETTLE_MS);
    expect(card.text()).toBe("2");
  });

  it("never strands a turn on a stale figure", () => {
    // The settled number matters most — a throttle that could drop the final
    // update would leave the wrong cost on screen for good.
    const card = open(<Probe value={10} />);
    card.rerender(<Probe value={20} />);
    card.tick(10);
    card.rerender(<Probe value={30} />);
    card.tick(CARD_SETTLE_MS * 2);
    expect(card.text()).toBe("30");
  });
});

describe("reserving a row once it has earned one", () => {
  const Probe: React.FC<{ present: boolean }> = ({ present }) => (
    <span>{String(useSticky(present))}</span>
  );

  it("is false until the row first has something to say", () => {
    expect(open(<Probe present={false} />).text()).toBe("false");
  });

  it("is true on the very render the row first appears", () => {
    // One render late would be a visible pop — the thing being fixed.
    expect(open(<Probe present />).text()).toBe("true");
  });

  it("keeps the slot after the value falls back to zero", () => {
    const card = open(<Probe present />);
    card.rerender(<Probe present={false} />);
    expect(card.text()).toBe("true");
    card.rerender(<Probe present={false} />);
    expect(card.text()).toBe("true");
  });
});

describe("which cost lines get a slot", () => {
  type Values = Parameters<typeof useReservedCostLines>[0];
  const Probe: React.FC<{ values: Values }> = ({ values }) => (
    <span>
      {useReservedCostLines(values)
        .map(([name, value]) => `${name}=${value}`)
        .join("|")}
    </span>
  );
  const none: Values = {
    "fresh input": 0,
    "cache write": 0,
    "cached input": 0,
    output: 0,
  };

  it("shows nothing for a section that has never cost anything", () => {
    // Four permanently dead rows would be the opposite failure — a provider
    // with no cache should not carry two rows that can never say anything.
    expect(open(<Probe values={none} />).text()).toBe("");
  });

  it("shows a line on the render it first has a value", () => {
    const card = open(<Probe values={{ ...none, "fresh input": 0.5 }} />);
    expect(card.text()).toBe("fresh input=0.5");
  });

  it("keeps the line at zero rather than reclaiming its space", () => {
    const card = open(<Probe values={{ ...none, "fresh input": 0.5 }} />);
    card.rerender(<Probe values={none} />);
    // Present, worth nothing — the card renders a dash here, not a gap.
    expect(card.text()).toBe("fresh input=0");
  });

  it("orders lines canonically, not by when they arrived", () => {
    // `output` earns its slot first but must still render below the inputs,
    // or a late-arriving line reshuffles every row above it.
    const card = open(<Probe values={{ ...none, output: 0.2 }} />);
    card.rerender(
      <Probe values={{ ...none, output: 0.2, "fresh input": 0.9 }} />,
    );
    expect(card.text()).toBe("fresh input=0.9|output=0.2");
  });

  it("never drops a line once earned, across a whole turn", () => {
    const card = open(<Probe values={none} />);
    const sequence: Values[] = [
      { ...none, "fresh input": 1 },
      { ...none, "fresh input": 1, "cached input": 2 },
      { ...none, "fresh input": 1 },
      { ...none, output: 3 },
    ];
    let widest = 0;
    for (const values of sequence) {
      card.rerender(<Probe values={values} />);
      const count = card.text().split("|").filter(Boolean).length;
      // Monotonic: the row count may grow but must never shrink, because a
      // shrink is the card changing height under the pointer.
      expect(count).toBeGreaterThanOrEqual(widest);
      widest = count;
    }
    expect(card.text()).toBe("fresh input=0|cached input=0|output=3");
  });
});
