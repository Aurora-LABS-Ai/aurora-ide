/**
 * Reload-restore contract: the open chat is snapshotted to sessionStorage on
 * every selection change and re-selected after an in-window reload (Ctrl+R or
 * the native renderer-crash auto-reload).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { restoreThreadAfterReload, trackThreadForReload } from "@/apps/agent/hooks/window/useReloadRestore";

const KEY = "agw:reload-thread";

describe("useReloadRestore", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    useAgentChatStore.setState({
      projectRoot: "C:/project-a",
      currentThreadId: null,
      currentThread: null,
    });
  });

  it("snapshots the open chat on selection change and clears it on deselect", () => {
    const unsubscribe = trackThreadForReload();

    useAgentChatStore.setState({ currentThreadId: "thread-a" });
    expect(JSON.parse(window.sessionStorage.getItem(KEY) ?? "null")).toEqual({
      id: "thread-a",
      ws: "C:/project-a",
    });

    useAgentChatStore.setState({ currentThreadId: null });
    expect(window.sessionStorage.getItem(KEY)).toBeNull();

    unsubscribe();
  });

  it("re-selects the saved chat after a reload", () => {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({ id: "thread-a", ws: "C:/project-a" }),
    );
    const selectThread = vi.fn().mockResolvedValue(undefined);
    useAgentChatStore.setState({ selectThread });

    restoreThreadAfterReload();
    expect(selectThread).toHaveBeenCalledWith("thread-a", "C:/project-a");
  });

  it("does nothing on a fresh window or a corrupt marker", () => {
    const selectThread = vi.fn().mockResolvedValue(undefined);
    useAgentChatStore.setState({ selectThread });

    restoreThreadAfterReload();
    window.sessionStorage.setItem(KEY, "{not json");
    restoreThreadAfterReload();

    expect(selectThread).not.toHaveBeenCalled();
  });
});
