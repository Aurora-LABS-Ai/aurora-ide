import { getFilename, getLanguageFromExtension } from "../lib/file-utils";
import { readFileContent } from "../lib/tauri";
import { useEditorStore } from "../store/useEditorStore";
import {
  planMultiSearchReplace,
  planSearchReplace,
  type SearchReplaceReplacement,
} from "../lib/search-replace-utils";
import { resolvePath } from "../tools/utils/path-resolver";
import type { ToolCallRequest } from "./providers/types";
import {
  getParsedReplacementsArg,
  getStreamingBooleanArg,
  getStreamingStringArg,
  isLivePreviewTool,
  type LivePreviewToolName,
} from "./live-file-preview-utils";

type LivePreviewStatus = "streaming" | "applying";

interface LiveFilePreviewSession {
  fileName: string;
  filePath: string;
  lastPreviewContent: string;
  openedByPreview: boolean;
  originalContent?: string;
  originalTabContent?: string;
  status: LivePreviewStatus;
  toolCallId: string;
  toolName: LivePreviewToolName;
  updateVersion: number;
}

const sessions = new Map<string, LiveFilePreviewSession>();
const pendingEditorUpdates = new Map<string, string>();
const scheduledEditorUpdates = new Set<string>();

const getActiveTabSnapshot = (filePath: string) => {
  const editorState = useEditorStore.getState();
  return editorState.tabs.find((tab) => tab.path === filePath);
};

const scheduleEditorPreview = (
  session: LiveFilePreviewSession,
  content: string,
) => {
  session.lastPreviewContent = content;
  pendingEditorUpdates.set(session.toolCallId, content);

  if (scheduledEditorUpdates.has(session.toolCallId)) {
    return;
  }

  scheduledEditorUpdates.add(session.toolCallId);
  const flush = () => {
    scheduledEditorUpdates.delete(session.toolCallId);
    const latestContent = pendingEditorUpdates.get(session.toolCallId);
    pendingEditorUpdates.delete(session.toolCallId);

    const latestSession = sessions.get(session.toolCallId);
    if (!latestSession || latestContent === undefined) {
      return;
    }

    const { openFile, requestEditorReveal } = useEditorStore.getState();

    // ALWAYS route streamed chunks through `openFile` (which dedupes
    // by path: existing tab → `reloadTabContent`, missing tab →
    // create + activate). This drives the @monaco-editor/react value
    // prop, which the wrapper diffs against the model and triggers
    // `setValue` for a visible update on every chunk. Works for both
    // `file_create` (no tab yet) and `file_write` (tab already open)
    // uniformly.
    //
    // We previously tried to optimise the "tab already open" case
    // with `streamPreviewMonacoFileContent` (raw `model.applyEdits`,
    // no React update), but with React state out of sync the wrapper
    // would occasionally roll the model back to the stale tab.content
    // value during an unrelated re-render — silently undoing the
    // streamed chunk. The visible Zustand-driven path is the one
    // that was already shipping for `file_create`, and it's the
    // single behaviour we want both tools to use.
    openFile(
      latestSession.filePath,
      latestSession.fileName,
      latestContent,
      getLanguageFromExtension(latestSession.fileName),
    );
    requestEditorReveal(latestSession.filePath, {
      mode: "bottom",
      focus: false,
    });
  };

  if (typeof window !== "undefined" && "requestAnimationFrame" in window) {
    window.requestAnimationFrame(flush);
  } else {
    setTimeout(flush, 16);
  }
};

const cancelPendingEditorPreview = (toolCallId: string) => {
  pendingEditorUpdates.delete(toolCallId);
  scheduledEditorUpdates.delete(toolCallId);
};

const rollbackSessionPreview = (session: LiveFilePreviewSession) => {
  cancelPendingEditorPreview(session.toolCallId);

  const editorState = useEditorStore.getState();
  if (session.openedByPreview) {
    editorState.closeTab(session.filePath, { skipUnsavedWarning: true });
    return;
  }

  if (session.originalTabContent !== undefined) {
    editorState.reloadTabContent(session.filePath, session.originalTabContent);
  }
};

const createSession = (
  toolCallId: string,
  toolName: LivePreviewToolName,
  filePath: string,
): LiveFilePreviewSession => {
  const existingTab = getActiveTabSnapshot(filePath);
  return {
    fileName: getFilename(filePath),
    filePath,
    lastPreviewContent: "",
    openedByPreview: !existingTab,
    originalTabContent: existingTab?.content,
    status: "streaming",
    toolCallId,
    toolName,
    updateVersion: 0,
  };
};

const getOrCreateSession = (
  toolCallId: string,
  toolName: LivePreviewToolName,
  filePath: string,
): LiveFilePreviewSession => {
  const existing = sessions.get(toolCallId);
  if (existing && existing.filePath === filePath && existing.toolName === toolName) {
    return existing;
  }

  if (existing) {
    rollbackSessionPreview(existing);
  }

  const session = createSession(toolCallId, toolName, filePath);
  sessions.set(toolCallId, session);
  return session;
};

const readOriginalContent = async (
  session: LiveFilePreviewSession,
): Promise<string> => {
  if (session.originalContent !== undefined) {
    return session.originalContent;
  }

  try {
    session.originalContent = await readFileContent(session.filePath);
  } catch {
    session.originalContent = "";
  }

  return session.originalContent;
};

const previewFullContentTool = async (
  toolCall: ToolCallRequest,
  toolName: "file_create" | "file_write",
  rawArguments: string,
) => {
  const pathField = getStreamingStringArg(rawArguments, "path");
  if (!pathField?.complete || !pathField.value.trim()) {
    return;
  }

  const contentField = getStreamingStringArg(rawArguments, "content");
  if (!contentField) {
    return;
  }

  const filePath = resolvePath(pathField.value);
  const session = getOrCreateSession(toolCall.id, toolName, filePath);
  session.updateVersion += 1;
  scheduleEditorPreview(session, contentField.value);
};

const previewSearchReplaceTool = async (
  toolCall: ToolCallRequest,
  rawArguments: string,
) => {
  const pathField = getStreamingStringArg(rawArguments, "path");
  const oldStringField = getStreamingStringArg(rawArguments, "old_string");
  const newStringField = getStreamingStringArg(rawArguments, "new_string");

  if (
    !pathField?.complete ||
    !pathField.value.trim() ||
    !oldStringField?.complete ||
    !oldStringField.value ||
    !newStringField
  ) {
    return;
  }

  const filePath = resolvePath(pathField.value);
  const session = getOrCreateSession(toolCall.id, "search_replace", filePath);
  const updateVersion = session.updateVersion + 1;
  session.updateVersion = updateVersion;

  const originalContent = await readOriginalContent(session);
  if (sessions.get(toolCall.id)?.updateVersion !== updateVersion) {
    return;
  }

  const plannedReplacement = planSearchReplace(originalContent, {
    old_string: oldStringField.value,
    new_string: newStringField.value,
    replace_all: getStreamingBooleanArg(rawArguments, "replace_all"),
  });

  if (plannedReplacement.success) {
    scheduleEditorPreview(session, plannedReplacement.content);
  }
};

const previewMultiSearchReplaceTool = async (
  toolCall: ToolCallRequest,
  rawArguments: string,
) => {
  const pathField = getStreamingStringArg(rawArguments, "path");
  const replacements = getParsedReplacementsArg(rawArguments);

  if (!pathField?.complete || !pathField.value.trim() || !replacements) {
    return;
  }

  const filePath = resolvePath(pathField.value);
  const session = getOrCreateSession(toolCall.id, "multi_search_replace", filePath);
  const updateVersion = session.updateVersion + 1;
  session.updateVersion = updateVersion;

  const originalContent = await readOriginalContent(session);
  if (sessions.get(toolCall.id)?.updateVersion !== updateVersion) {
    return;
  }

  const plannedReplacement = planMultiSearchReplace(
    originalContent,
    replacements as SearchReplaceReplacement[],
  );

  if (plannedReplacement.success) {
    scheduleEditorPreview(session, plannedReplacement.content);
  }
};

const updateFromToolCall = async (toolCall: ToolCallRequest) => {
  const toolName = toolCall.function.name;
  if (!isLivePreviewTool(toolName)) {
    return;
  }

  const rawArguments = toolCall.function.arguments || "";

  if (toolName === "file_create" || toolName === "file_write") {
    await previewFullContentTool(toolCall, toolName, rawArguments);
    return;
  }

  if (toolName === "search_replace") {
    await previewSearchReplaceTool(toolCall, rawArguments);
    return;
  }

  await previewMultiSearchReplaceTool(toolCall, rawArguments);
};

/**
 * Public snapshot of a live-preview session for downstream consumers
 * (the `agent_file_changed` sync handler in particular) that need the
 * original (pre-AI) content so the final committed write can be
 * pushed onto Monaco's undo stack as a single entry against the
 * original baseline rather than against the last streamed chunk.
 */
export interface LiveFilePreviewSnapshot {
  filePath: string;
  toolName: LivePreviewToolName;
  lastPreviewContent: string;
  /** Pre-AI content as seen on disk when the session began. */
  originalContent?: string;
  /** Pre-AI in-memory tab content (may differ from disk if dirty). */
  originalTabContent?: string;
  /** Did this session create the tab itself? */
  openedByPreview: boolean;
}

const toSnapshot = (
  session: LiveFilePreviewSession,
): LiveFilePreviewSnapshot => ({
  filePath: session.filePath,
  toolName: session.toolName,
  lastPreviewContent: session.lastPreviewContent,
  originalContent: session.originalContent,
  originalTabContent: session.originalTabContent,
  openedByPreview: session.openedByPreview,
});

export const liveFilePreviewService = {
  cancelAllActive: () => {
    for (const session of sessions.values()) {
      rollbackSessionPreview(session);
    }
    sessions.clear();
  },

  /**
   * Look up the active session for a tool_use_id without mutating it.
   * The `agent_file_changed` handler uses this to grab the original
   * baseline content so the final commit lands as one undo entry.
   */
  getSessionSnapshot: (toolCallId: string): LiveFilePreviewSnapshot | null => {
    const session = sessions.get(toolCallId);
    return session ? toSnapshot(session) : null;
  },

  complete: (toolCallId: string) => {
    cancelPendingEditorPreview(toolCallId);
    sessions.delete(toolCallId);
  },

  fail: (toolCallId: string) => {
    const session = sessions.get(toolCallId);
    if (!session) {
      return;
    }

    rollbackSessionPreview(session);
    sessions.delete(toolCallId);
  },

  markApplying: (toolCallId: string) => {
    const session = sessions.get(toolCallId);
    if (session) {
      session.status = "applying";
    }
  },

  updateFromToolCall: (toolCall: ToolCallRequest) => {
    void updateFromToolCall(toolCall).catch((error) => {
      console.warn("[live-file-preview] Failed to update preview:", error);
    });
  },
};
