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

  it("shows only the tab being looked at when two browser tabs exist", async () => {
    const v = await load();
    v.setBrowserPanelMounted(true, "browser-tab-a");
    // Switching tabs: the first panel unmounts, the second mounts.
    v.setBrowserPanelMounted(false, "browser-tab-a");
    v.setBrowserPanelMounted(true, "browser-tab-b");
    expect(v.isBrowserMeantVisible("browser-tab-a")).toBe(false);
    expect(v.isBrowserMeantVisible("browser-tab-b")).toBe(true);
    expect(sent().map((s) => [s.label, s.visible])).toEqual([
      ["browser-tab-a", true],
      ["browser-tab-a", false],
      ["browser-tab-b", true],
    ]);
  });

  it("an overlay hides whichever page is showing, and only that one comes back", async () => {
    const v = await load();
    v.setBrowserPanelMounted(true, "browser-tab-a");
    v.setBrowserPanelMounted(false, "browser-tab-a");
    v.setBrowserPanelMounted(true, "browser-tab-b");
    invoke.mockClear();
    const release = v.holdBrowserHidden();
    release();
    // tab-a was already hidden, so nothing is re-sent for it.
    expect(sent().map((s) => [s.label, s.visible])).toEqual([
      ["browser-tab-b", false],
      ["browser-tab-b", true],
    ]);
  });

  it("a closed tab's page is forgotten, so a later overlay sends nothing for it", async () => {
    const v = await load();
    v.setBrowserPanelMounted(true, "browser-tab-a");
    v.setBrowserPanelMounted(false, "browser-tab-a");
    v.forgetBrowser("browser-tab-a");
    invoke.mockClear();
    v.holdBrowserHidden()();
    expect(sent()).toEqual([]);
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
