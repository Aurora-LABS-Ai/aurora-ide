import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => true);

vi.mock("@/kernel/lib/ipc/runtime", () => ({
  isAuroraRuntimeAvailable: () => true,
  auroraInvoke: (...args: unknown[]) => invoke(...(args as [])),
}));

type Sent = { label: string; visible: boolean; seq: number };
const sent = (): Sent[] => invoke.mock.calls.map((call) => (call as unknown[])[1] as Sent);

// The controller keeps module state, so every test gets a fresh copy.
const load = async () => {
  vi.resetModules();
  return import("./browser-visibility");
};

describe("browser visibility", () => {
  beforeEach(() => invoke.mockClear());

  it("shows while the panel is mounted and hides when it unmounts", async () => {
    const v = await load();
    v.setBrowserPanelMounted(true);
    v.setBrowserPanelMounted(false);
    expect(sent().map((s) => s.visible)).toEqual([true, false]);
  });

  it("keeps the page hidden until EVERY overlay has closed", async () => {
    const v = await load();
    v.setBrowserPanelMounted(true);
    const menu = v.holdBrowserHidden();
    const modal = v.holdBrowserHidden();
    menu();
    expect(v.isBrowserMeantVisible()).toBe(false);
    modal();
    expect(v.isBrowserMeantVisible()).toBe(true);
    expect(sent().map((s) => s.visible)).toEqual([true, false, true]);
  });

  it("never shows the page for an overlay that closes after the panel is gone", async () => {
    const v = await load();
    v.setBrowserPanelMounted(true);
    const release = v.holdBrowserHidden();
    v.setBrowserPanelMounted(false);
    release();
    expect(sent().at(-1)?.visible).toBe(false);
  });

  it("releasing twice does not un-hold someone else's overlay", async () => {
    const v = await load();
    v.setBrowserPanelMounted(true);
    const a = v.holdBrowserHidden();
    const b = v.holdBrowserHidden();
    a();
    a();
    expect(v.isBrowserMeantVisible()).toBe(false);
    b();
    expect(v.isBrowserMeantVisible()).toBe(true);
  });

  it("sends strictly increasing sequence numbers, and a re-assert even when nothing changed", async () => {
    const v = await load();
    v.setBrowserPanelMounted(true);
    v.reassertBrowserVisibility();
    v.setBrowserPanelMounted(true);
    const seqs = sent().map((s) => s.seq);
    expect(seqs).toHaveLength(2);
    expect(seqs[1]).toBeGreaterThan(seqs[0]);
    expect(Number.isSafeInteger(seqs[1])).toBe(true);
  });
});
