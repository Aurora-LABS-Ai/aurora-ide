import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ShellStreamView } from "@/apps/agent/components/tool-views/ShellStreamView";

vi.mock("@/kernel/store/useSettingsStore", () => ({
  useSettingsStore: (
    select: (state: { explorerIconPack: string }) => unknown,
  ) => select({ explorerIconPack: "material-icon-theme" }),
}));

afterEach(() => {
  vi.useRealTimers();
});

/**
 * `pnpm lint && pnpm build` prints nothing until it finishes. On the bare word
 * "Waiting…" that is indistinguishable from a hang, which is exactly the
 * moment a person needs to know the difference.
 */
describe("ShellStreamView while nothing has printed yet", () => {
  const render = (props: Parameters<typeof ShellStreamView>[0]) =>
    renderToStaticMarkup(<ShellStreamView {...props} />);

  it("says how long it has waited and when the wait ends", () => {
    vi.useFakeTimers();
    const started = 1_000_000;
    vi.setSystemTime(started + 45_000);

    const html = render({
      command: "pnpm lint && pnpm build",
      shell: "bash",
      output: "",
      startedAt: started,
      timeoutMs: 120_000,
    });

    expect(html).toContain("Waiting for output…");
    expect(html).toContain("45s of 2m");
  });

  it("shows no clock when the row was rebuilt from history", () => {
    // Rust does not persist a start time, so a reloaded call has none. Better
    // to say nothing than to count from the moment the page happened to load.
    const html = render({ command: "pnpm test", output: "", timeoutMs: 120_000 });

    expect(html).toContain("Waiting for output…");
    expect(html).not.toContain("agw-shell-waiting-clock");
  });

  it("drops the clock once real output arrives", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_045_000);

    const html = render({
      command: "pnpm test",
      output: "Test Files  78 passed",
      startedAt: 1_000_000,
      timeoutMs: 120_000,
    });

    // The output moving IS the progress; a second clock beside it is noise.
    expect(html).not.toContain("agw-shell-waiting");
    expect(html).toContain("78 passed");
  });
});
