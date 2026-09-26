// ---------------------------------------------------------------------------
// Settings persistence debounce
// ---------------------------------------------------------------------------
// Every setter calls `saveToDatabase()`, which writes the store's settings.
// Without coalescing, a burst of mutations (dragging a slider, toggling several
// options) fires N concurrent writes that race each other. A shared timer
// collapses a burst into one write. `flush` forces an immediate write (used on
// window unload so the last change isn't lost inside the debounce window).
//
// One scheduler per store: the editor's settings and the Agent Window's are
// separate stores writing separate keys, and one must not cancel the other's
// pending write.
const SETTINGS_SAVE_DEBOUNCE_MS = 300;

export interface SettingsSaveScheduler {
  /** Run `run` once the burst settles; resolves when that write finishes. */
  schedule: (run: () => Promise<void>) => Promise<void>;
  /** Write now instead of waiting out the debounce. No-op when nothing is pending. */
  flush: (run: () => Promise<void>) => void;
}

export const createSettingsSaveScheduler = (): SettingsSaveScheduler => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolvers: Array<() => void> = [];

  const runNow = (run: () => Promise<void>) => {
    timer = null;
    const waiting = resolvers;
    resolvers = [];
    void run().finally(() => {
      for (const r of waiting) r();
    });
  };

  return {
    schedule: (run) =>
      new Promise<void>((resolve) => {
        resolvers.push(resolve);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => runNow(run), SETTINGS_SAVE_DEBOUNCE_MS);
      }),
    flush: (run) => {
      if (!timer) return;
      clearTimeout(timer);
      runNow(run);
    },
  };
};
