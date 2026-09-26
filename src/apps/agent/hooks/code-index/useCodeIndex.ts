import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelIndexBuild, isIndexBuilding, readIndexBuild, saveIndexSettings, startIndexBuild,
  type BuildSnapshot, type IndexSettings,
} from "@/apps/agent/services/code-index/code-index";

/** Mount with a project key. Unmounting only stops observation, never the build. */
export function useCodeIndex(workspace: string) {
  const [snapshot, setSnapshot] = useState<BuildSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const alive = useRef(false);
  const revision = useRef(0);
  const pending = useRef(false);

  useEffect(() => {
    alive.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const requested = revision.current;
      try {
        const next = await readIndexBuild(workspace);
        if (!stopped && !pending.current && requested === revision.current) {
          setSnapshot(next);
          setReadError(null);
        }
      } catch (e) {
        if (!stopped && requested === revision.current) setReadError(`Could not read index status: ${String(e)}`);
      }
      if (!stopped) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => { stopped = true; alive.current = false; clearTimeout(timer); };
  }, [workspace]);

  const perform = useCallback(async (action: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    revision.current += 1;
    setBusy(true);
    setError(null);
    try {
      await action();
      const next = await readIndexBuild(workspace);
      if (alive.current) setSnapshot(next);
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }, [workspace]);

  return {
    snapshot, error: error ?? readError, busy, building: isIndexBuilding(snapshot?.job),
    save: (settings: IndexSettings) => perform(() => saveIndexSettings(workspace, settings)),
    build: () => snapshot && perform(() => startIndexBuild(workspace)),
    cancel: () => perform(() => cancelIndexBuild(workspace)),
  };
}
