/**
 * Keep the browser's address and the open chat in step (web only).
 *
 * `openWebChatUrl` opens what the address names, once the window has bound
 * its project; `startWebChatUrlSync` then writes every change of project,
 * chat or product back into the address (a new entry when the chat changes,
 * so Back returns to the previous chat) and follows Back/Forward. The
 * address format is `lib/navigation/web-chat-url.ts`.
 *
 * The desktop window has no address bar and keeps `/agent-window` as is.
 */

import {
  parseWebChatPath,
  projectForSlug,
  projectSlug,
  webChatPath,
  type WebChatLocation,
} from "@/apps/agent/lib/navigation/web-chat-url";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";

const currentLocation = (): WebChatLocation => {
  const { currentThreadId, projectRoot } = useAgentChatStore.getState();
  const surface = useAgentSettingsStore.getState().auroraSurface;
  if (surface === "chat") {
    return currentThreadId ? { kind: "chat", threadId: currentThreadId } : { kind: "home" };
  }
  if (!projectRoot) return { kind: "home" };
  return { kind: "project", slug: projectSlug(projectRoot), threadId: currentThreadId };
};

/**
 * Open the project and chat the address names. `false` when it names
 * nothing this window can open (the caller falls back to its usual restore).
 */
export async function openWebChatUrl(): Promise<boolean> {
  const location = parseWebChatPath(window.location.pathname);
  const chat = useAgentChatStore.getState();
  const surface = useAgentSettingsStore.getState().auroraSurface;

  if (location.kind === "chat") {
    if (surface !== "chat") await chat.enterSurface("chat");
    await useAgentChatStore.getState().selectThread(location.threadId);
    return true;
  }
  if (location.kind !== "project") return false;

  await chat.loadKnownProjects();
  const { knownProjects, projectRoot } = useAgentChatStore.getState();
  const roots = projectRoot ? [projectRoot, ...knownProjects] : knownProjects;
  const root = projectForSlug(location.slug, roots);
  if (!root) {
    console.warn(`[agent-window] the address names a project this Aurora does not know: ${location.slug}`);
    return false;
  }
  if (surface !== "build") await chat.enterSurface("build");
  if (location.threadId) {
    await useAgentChatStore.getState().selectThread(location.threadId, root);
  } else if (root !== useAgentChatStore.getState().projectRoot) {
    await useAgentChatStore.getState().setProject(root);
  }
  return true;
}

/** Write the open chat into the address from now on. Returns the stop function. */
export function startWebChatUrlSync(): () => void {
  let lastThread = useAgentChatStore.getState().currentThreadId;

  const write = () => {
    const path = webChatPath(currentLocation());
    if (path === window.location.pathname) return;
    const thread = useAgentChatStore.getState().currentThreadId;
    const state = window.history.state as unknown;
    if (thread !== lastThread) {
      window.history.pushState(state, "", path + window.location.search);
    } else {
      window.history.replaceState(state, "", path + window.location.search);
    }
    lastThread = thread;
  };

  write();
  const stopChat = useAgentChatStore.subscribe((state, prev) => {
    if (state.currentThreadId !== prev.currentThreadId || state.projectRoot !== prev.projectRoot) {
      write();
    }
  });
  const stopSettings = useAgentSettingsStore.subscribe((state, prev) => {
    if (state.auroraSurface !== prev.auroraSurface) write();
  });
  const onPop = () => {
    lastThread = null;
    void openWebChatUrl().then((opened) => {
      if (!opened) useAgentChatStore.getState().newChat();
      lastThread = useAgentChatStore.getState().currentThreadId;
    });
  };
  window.addEventListener("popstate", onPop);

  return () => {
    stopChat();
    stopSettings();
    window.removeEventListener("popstate", onPop);
  };
}
