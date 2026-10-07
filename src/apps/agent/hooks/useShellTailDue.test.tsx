/**
 * The live tail waits for a command to prove it is slow. A quick command must
 * never be due, or its tail opens and closes within a tenth of a second and
 * jerks the transcript (probe round 2, aurora-shell-live-output-designs.html).
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TAIL_APPEARS_AFTER_MS } from "@/apps/agent/components/tool-views/shell-tail";
import { useShellTailDue } from "@/apps/agent/hooks/useShellTailDue";

const Probe = ({ startedAt, running }: { startedAt?: number; running: boolean }) => (
  <>{String(useShellTailDue(startedAt, running))}</>
);

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  root = createRoot(host);
});

/** What the hook returned on the latest render. */
const due = () => host.textContent === "true";

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

const render = (props: { startedAt?: number; running: boolean }) =>
  act(() => root.render(<Probe {...props} />));
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("useShellTailDue", () => {
  it("is not due while a command is still quick", () => {
    render({ startedAt: 100_000, running: true });
    advance(TAIL_APPEARS_AFTER_MS - 1);
    expect(due()).toBe(false);
  });

  it("is due once the command has run long enough", () => {
    render({ startedAt: 100_000, running: true });
    advance(TAIL_APPEARS_AFTER_MS);
    expect(due()).toBe(true);
  });

  it("counts from the command's own start, not from when the card mounted", () => {
    render({ startedAt: 100_000 - TAIL_APPEARS_AFTER_MS, running: true });
    advance(0);
    expect(due()).toBe(true);
  });

  it("is never due for a command that finished first", () => {
    render({ startedAt: 100_000, running: true });
    advance(300);
    render({ startedAt: 100_000, running: false });
    advance(TAIL_APPEARS_AFTER_MS * 2);
    expect(due()).toBe(false);
  });

  it("stops being due the moment the command ends", () => {
    render({ startedAt: 100_000, running: true });
    advance(TAIL_APPEARS_AFTER_MS);
    render({ startedAt: 100_000, running: false });
    expect(due()).toBe(false);
  });
});
