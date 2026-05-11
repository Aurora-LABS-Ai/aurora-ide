/**
 * THEME ARCHITECTURE NOTICE:
 *
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 *
 * Instead of:
 *   - Hardcoded hex values: #ff0000, #1a1a1a
 *   - Hardcoded RGB values: rgb(255, 0, 0)
 *   - Tailwind arbitrary colors: bg-[#1a1a1a], text-[#ff0000]
 *
 * Use theme tokens via CSS variables:
 *   - CSS: var(--aurora-{category}-{token})
 *   - Tailwind: bg-[var(--aurora-editor-background)]
 *   - Component styles: style={{ background: 'var(--aurora-sidebar-background)' }}
 *
 * Available categories: editor, sidebar, chat, terminal, statusBar, titleBar, common
 *
 * See: DOCS/theme-dev.md for full token reference
 * See: src/types/theme.ts for TypeScript interfaces
 * See: src/services/theme-service.ts for theme utilities
 */

import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import {
  Square,
  X,
  Paperclip,
  ArrowUp,
  AlertCircle,
  MousePointer2,
} from "lucide-react";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { useChatStore } from "../../store/useChatStore";
import type { SelectedElementEntry } from "../../store/useChatStore";
import {
  useWorkspaceStore,
  loadFileContent,
} from "../../store/useWorkspaceStore";
import { useEditorStore } from "../../store/useEditorStore";
import { useTaskStore } from "../../store/useTaskStore";
import { type PromptAttachment } from "../../services/prompt-assets";
import { usePromptAssetCatalog } from "../../hooks/usePromptAssetCatalog";
import type { FileNode } from "../../types";
import clsx from "clsx";
import { createPortal } from "react-dom";
import { addAttachmentDropListener } from "../../lib/attachment-events";
import {
  getDragFilePath,
  getFilename,
  getLanguageFromExtension,
} from "../../lib/file-utils";
import { FileIcon } from "../explorer/FileIcons";
import { CompactTaskList } from "./TaskView";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import { PromptAttachmentPopup } from "./PromptAttachmentPopup";
import { ShimmerText } from "../ui/ShimmerText";
import { ModelSelector } from "../ui/ModelSelector";
import { AgentExecutionModeToggle } from "../ui/AgentExecutionModeToggle";
import { SpeechInputButton } from "./SpeechInputButton";

// Rotating status messages for AI generation
const GENERATING_MESSAGES = [
  "Aurora is thinking...",
  "Analyzing your request...",
  "Building solution...",
  "Aurora agent working...",
  "Processing context...",
  "Crafting response...",
];

export interface AttachedFile {
  path: string;
  name: string;
}

interface ChatInputProps {
  onSend: (
    content: string,
    attachedFiles?: AttachedFile[],
    promptAttachments?: PromptAttachment[],
    selectedElements?: SelectedElementEntry[],
  ) => void;
  disabled?: boolean;
}

const flattenFiles = (nodes: FileNode[]): FileNode[] => {
  let result: FileNode[] = [];
  for (const node of nodes) {
    if (node.type === "file") {
      result.push(node);
    } else if (node.children) {
      result = [...result, ...flattenFiles(node.children)];
    }
  }
  return result;
};

// Status component that shows rotating shimmer messages during generation
const GeneratingStatus: React.FC = () => {
  const { isLoading } = useChatStore();
  const [messageIndex, setMessageIndex] = useState(0);
  const visibleMessageIndex = isLoading ? messageIndex : 0;

  // Rotate through messages every 2.5 seconds
  useEffect(() => {
    if (!isLoading) return;

    const interval = setInterval(() => {
      setMessageIndex((prev) => (prev + 1) % GENERATING_MESSAGES.length);
    }, 2500);

    return () => clearInterval(interval);
  }, [isLoading]);

  if (!isLoading) {
    return (
      <p className="text-[10px] text-muted-foreground">
        AI can make mistakes. Review generated code.
      </p>
    );
  }

  return (
    <ShimmerText className="text-[10px] font-medium">
      {GENERATING_MESSAGES[visibleMessageIndex]}
    </ShimmerText>
  );
};

export const ChatInput: React.FC<ChatInputProps> = ({ onSend, disabled }) => {
  // Initialize from shared draft state (persists across layout switches)
  const draftInput = useChatStore((s) => s.draftInput);
  const draftAttachedFiles = useChatStore((s) => s.draftAttachedFiles);
  const draftAttachedPromptAssets = useChatStore((s) => s.draftAttachedPromptAssets);
  const setDraftInput = useChatStore((s) => s.setDraftInput);
  const setDraftAttachedFiles = useChatStore((s) => s.setDraftAttachedFiles);
  const setDraftAttachedPromptAssets = useChatStore((s) => s.setDraftAttachedPromptAssets);
  const clearDraft = useChatStore((s) => s.clearDraft);

  // Browser-pick state (lives on the chat store so any chat input
  // instance — main panel, agent layout, detached window — sees the
  // same selection set).
  const selectedElements = useChatStore((s) => s.selectedElements);
  const removeSelectedElement = useChatStore((s) => s.removeSelectedElement);
  const clearSelectedElements = useChatStore((s) => s.clearSelectedElements);

  const [content, setContentLocal] = useState(draftInput);
  const [isDragOver, setIsDragOver] = useState(false);
  const [attachedFiles, setAttachedFilesLocal] = useState<AttachedFile[]>(
    () => draftAttachedFiles.map(f => ({ path: f.path, name: f.name }))
  );
  const [attachedPromptAssets, setAttachedPromptAssetsLocal] = useState<
    PromptAttachment[]
  >(() => [...draftAttachedPromptAssets]);
  const [hasInteracted, setHasInteracted] = useState(false);

  // Focus state for theming
  const [isFocused, setIsFocused] = useState(false);

  // Mention Logic State
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState<number>(-1);
  const [mentionPopupPosition, setMentionPopupPosition] = useState<{
    bottom: number;
    left: number;
  } | null>(null);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState<number>(-1);
  const [slashPopupPosition, setSlashPopupPosition] = useState<{
    bottom: number;
    left: number;
  } | null>(null);
  const [slashSearchQuery, setSlashSearchQuery] = useState("");
  const [selectedPromptAssetIndex, setSelectedPromptAssetIndex] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { setSettingsOpen } = useUiStore();
  const { isLoading, stopGeneration, consumePendingInput, pendingInputNonce } =
    useChatStore();
  const { files: workspaceFiles, rootPath } = useWorkspaceStore();
  const { openFile } = useEditorStore();
  const { tasks, isVisible } = useTaskStore();

  useEffect(() => {
    setDraftInput(content);
  }, [content, setDraftInput]);

  useEffect(() => {
    setDraftAttachedFiles(
      attachedFiles.map((file) => ({ path: file.path, name: file.name })),
    );
  }, [attachedFiles, setDraftAttachedFiles]);

  useEffect(() => {
    setDraftAttachedPromptAssets(attachedPromptAssets);
  }, [attachedPromptAssets, setDraftAttachedPromptAssets]);
  const {
    selectedModel,
    setSelectedModel,
    getAvailableModels,
    getLLMConfig,
    skillToggles,
    skillsEnabled,
    agentExecutionMode,
    setAgentExecutionMode,
  } = useSettingsStore();

  const llmConfig = getLLMConfig();
  const providerReady = llmConfig !== null;

  // Re-compute available models when providers change
  const availableModels = getAvailableModels();
  const selectedModelOption = useMemo(
    () =>
      availableModels.find(
        ({ providerId, model }) => `${providerId}:${model}` === selectedModel,
      ),
    [availableModels, selectedModel],
  );

  // Flatten files for searching
  const allFiles = useMemo(
    () => flattenFiles(workspaceFiles),
    [workspaceFiles],
  );

  // Catalog of `/` prompt picker entries (rules + skills). Refreshes itself
  // when the user adds or edits files inside the prompt-asset folders, and
  // exposes `refreshCatalog()` for the imperative "freshen-on-open" path below.
  // Must be declared BEFORE any memo that closes over `promptAssetCatalog`,
  // otherwise the lexical binding is in TDZ when the memo factory first runs.
  const { promptAssetCatalog, refreshCatalog } = usePromptAssetCatalog({
    rootPath,
    skillToggles,
    skillsEnabled,
  });

  const filteredPromptAssets = useMemo(() => {
    const activeQuery = (slashSearchQuery || slashQuery || "")
      .trim()
      .toLowerCase();

    return promptAssetCatalog
      .filter((asset) => {
        if (
          attachedPromptAssets.some((attached) => attached.key === asset.key)
        ) {
          return false;
        }

        if (!activeQuery) {
          return true;
        }

        return [
          asset.title,
          asset.subtitle,
          asset.description,
          asset.sourceLabel,
        ].some((value) => value.toLowerCase().includes(activeQuery));
      })
      .slice(0, 20);
  }, [attachedPromptAssets, promptAssetCatalog, slashQuery, slashSearchQuery]);

  // Consume pending input from external sources (e.g., browser element inspector, suggested prompts)
  useEffect(() => {
    const { content: pending, replace } = consumePendingInput();
    if (pending) {
      const rafId = window.requestAnimationFrame(() => {
        if (replace) {
          setContentLocal(pending);
        } else {
          setContentLocal((prev) => (prev ? `${prev}\n\n${pending}` : pending));
        }
        textareaRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(rafId);
    }
  }, [pendingInputNonce, consumePendingInput]);

  // Handle Input Change for Mentions
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newVal = e.target.value;
    setContentLocal(newVal);

    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = newVal.slice(0, cursorPos);

    let slashHandled = false;
    const lastSlash = textBeforeCursor.lastIndexOf("/");
    if (lastSlash !== -1) {
      const isValidSlashStart =
        lastSlash === 0 || /\s/.test(textBeforeCursor[lastSlash - 1]);
      if (isValidSlashStart) {
        const query = textBeforeCursor.slice(lastSlash + 1);
        if (!query.includes("\n")) {
          slashHandled = true;
          // Refresh the catalog the moment the slash menu opens. This is the
          // safety net for changes the workspace fs-watcher can miss (the
          // global skills folder lives outside the workspace tree, and rapid
          // bursts can race the debounce).
          if (slashQuery === null) {
            refreshCatalog();
          }
          setSlashQuery(query);
          setSlashIndex(lastSlash);
          setSelectedPromptAssetIndex(0);
          if (textareaRef.current) {
            const inputRect = textareaRef.current.getBoundingClientRect();
            setSlashPopupPosition({
              bottom: window.innerHeight - inputRect.top + 10,
              left: inputRect.left + 20,
            });
          }
        }
      }
    }

    if (!slashHandled) {
      setSlashQuery(null);
      setSlashPopupPosition(null);
      setSlashSearchQuery("");
    }

    const lastAtSymbol = textBeforeCursor.lastIndexOf("@");

    if (lastAtSymbol !== -1) {
      const isValidStart =
        lastAtSymbol === 0 || /\s/.test(textBeforeCursor[lastAtSymbol - 1]);

      if (isValidStart) {
        const query = textBeforeCursor.slice(lastAtSymbol + 1);
        if (!query.includes("\n")) {
          setMentionQuery(query);
          setMentionIndex(lastAtSymbol);
          setSelectedFileIndex(0);
          if (textareaRef.current) {
            const inputRect = textareaRef.current.getBoundingClientRect();
            setMentionPopupPosition({
              bottom: window.innerHeight - inputRect.top + 10,
              left: inputRect.left + 20,
            });
          }
          return;
        }
      }
    }

    setMentionQuery(null);
    setMentionPopupPosition(null);
  };

  const filteredFiles = useMemo(() => {
    if (mentionQuery === null) return [];
    const lowerQuery = mentionQuery.toLowerCase();
    return allFiles
      .filter((file) => file.name.toLowerCase().includes(lowerQuery))
      .slice(0, 10);
  }, [mentionQuery, allFiles]);

  // Handle File Selection
  const selectFile = (file: FileNode | AttachedFile) => {
    // Add to attached (ensure path exists)
    if (!file.path) return;
    const filePath = file.path;
    setAttachedFilesLocal((prev) => {
      if (prev.some((f) => f.path === filePath)) return prev;
      return [...prev, { path: filePath, name: file.name }];
    });

    // Remove text query if via mention
    if (mentionQuery !== null && mentionIndex !== -1) {
      const before = content.slice(0, mentionIndex);
      const after = content.slice(mentionIndex + mentionQuery.length + 1); // +1 for @
      setContentLocal(`${before}${after} `);
      // Close popup
      setMentionQuery(null);
    }
  };

  const selectPromptAttachment = (attachment: PromptAttachment) => {
    setAttachedPromptAssetsLocal((prev) => {
      if (prev.some((item) => item.key === attachment.key)) {
        return prev;
      }
      return [...prev, attachment];
    });

    if (slashQuery !== null && slashIndex !== -1) {
      const before = content.slice(0, slashIndex);
      const after = content.slice(slashIndex + slashQuery.length + 1);
      setContentLocal(`${before}${after} `);
    }

    setSlashQuery(null);
    setSlashPopupPosition(null);
    setSlashSearchQuery("");
  };

  const handleFileClick = async (file: AttachedFile) => {
    try {
      // Load content if not already available (AttachedFile is just metadata)
      const content = await loadFileContent(file.path);
      const language = getLanguageFromExtension(file.name);
      openFile(file.path, file.name, content, language);
    } catch (err) {
      console.error("Failed to open attached file:", err);
    }
  };

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        mentionQuery !== null &&
        !document.getElementById("mention-popup")?.contains(e.target as Node)
      ) {
        setMentionQuery(null);
      }
      if (
        slashQuery !== null &&
        !document
          .getElementById("prompt-attachment-popup")
          ?.contains(e.target as Node)
      ) {
        setSlashQuery(null);
        setSlashSearchQuery("");
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [mentionQuery, slashQuery]);

  const handleSubmit = () => {
    if (
      (!content.trim() &&
        attachedFiles.length === 0 &&
        attachedPromptAssets.length === 0 &&
        selectedElements.length === 0) ||
      disabled
    )
      return;

    // Selected page elements ride the 4th onSend arg — kept separate
    // from `content` so the user's chat bubble shows clean text +
    // pills (handled in ChatMessage), while the agent receives the
    // full XML payload via the ideContext sidecar built downstream
    // in buildQueryContext.
    onSend(
      content,
      attachedFiles.length > 0 ? attachedFiles : undefined,
      attachedPromptAssets.length > 0 ? attachedPromptAssets : undefined,
      selectedElements.length > 0 ? selectedElements : undefined,
    );
    setContentLocal("");
    setAttachedFilesLocal([]);
    setAttachedPromptAssetsLocal([]);
    clearSelectedElements();
    clearDraft();
    setHasInteracted(true);
  };

  const handleStopOrSend = (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    if (isLoading) {
      stopGeneration();
    } else {
      handleSubmit();
    }
  };

  const removeAttachedFile = (path: string) => {
    setAttachedFilesLocal((files) => files.filter((f) => f.path !== path));
  };

  const removePromptAttachment = (key: string) => {
    setAttachedPromptAssetsLocal((items) =>
      items.filter((item) => item.key !== key),
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (slashQuery !== null) {
      if (filteredPromptAssets.length > 0 && e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedPromptAssetIndex(
          (index) => (index + 1) % filteredPromptAssets.length,
        );
        return;
      }
      if (filteredPromptAssets.length > 0 && e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedPromptAssetIndex(
          (index) =>
            (index - 1 + filteredPromptAssets.length) %
            filteredPromptAssets.length,
        );
        return;
      }
      if (
        filteredPromptAssets.length > 0 &&
        (e.key === "Enter" || e.key === "Tab")
      ) {
        e.preventDefault();
        selectPromptAttachment(filteredPromptAssets[selectedPromptAssetIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashQuery(null);
        setSlashSearchQuery("");
        return;
      }
    }

    // Handle Mention Navigation
    if (mentionQuery !== null && filteredFiles.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedFileIndex((i) => (i + 1) % filteredFiles.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedFileIndex(
          (i) => (i - 1 + filteredFiles.length) % filteredFiles.length,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectFile(filteredFiles[selectedFileIndex]);
        return;
      }
      if (e.key === "Escape") {
        setMentionQuery(null);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
      return;
    }

    if (
      e.key === "Backspace" &&
      !content &&
      attachedPromptAssets.length > 0 &&
      textareaRef.current?.selectionStart === 0
    ) {
      e.preventDefault();
      setAttachedPromptAssetsLocal((items) => items.slice(0, -1));
    }
  };

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 120) + "px";
    }
  }, [content]);

  const handleModelSelect = (providerId: string, model: string) => {
    setSelectedModel(`${providerId}:${model}`);
  };

  const handleExecutionModeToggle = useCallback(() => {
    setAgentExecutionMode(agentExecutionMode === "plan" ? "agent" : "plan");
  }, [agentExecutionMode, setAgentExecutionMode]);

  const handleSpeechTranscript = useCallback((transcript: string) => {
    setContentLocal((prev) => {
      const trimmed = transcript.trim();
      if (!trimmed) return prev;
      return prev.trim() ? `${prev.trimEnd()} ${trimmed}` : trimmed;
    });
    textareaRef.current?.focus();
  }, []);

  // Render Mention Popup
  const renderMentionPopup = () => {
    if (mentionQuery === null) return null;
    if (!mentionPopupPosition) return null;

    const popupStyle = {
      bottom: mentionPopupPosition.bottom,
      left: mentionPopupPosition.left,
      maxHeight: "300px",
    };

    return createPortal(
      <div
        id="mention-popup"
        className="fixed z-[10000] w-72 overflow-hidden flex flex-col animate-in fade-in duration-100"
        style={{
          ...popupStyle,
          backgroundColor:
            "color-mix(in srgb, var(--aurora-sidebar-background) 96%, var(--aurora-chat-surface) 4%)",
          border:
            "1px solid color-mix(in srgb, var(--aurora-common-border) 65%, transparent)",
          borderRadius: 10,
          boxShadow:
            "0 12px 28px color-mix(in srgb, var(--aurora-common-shadow) 22%, transparent)",
        }}
      >
        <div
          className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-2"
          style={{
            borderBottom:
              "1px solid color-mix(in srgb, var(--aurora-common-border) 40%, transparent)",
            backgroundColor:
              "color-mix(in srgb, var(--aurora-title-bar-background) 35%, transparent)",
          }}
        >
          <div>
            <p
              className="text-[10px] font-semibold uppercase tracking-[0.14em]"
              style={{
                color:
                  "var(--aurora-text-disabled, var(--aurora-editor-foreground))",
              }}
            >
              Mention
            </p>
            <p className="mt-0.5 text-[12px] font-semibold text-text-primary">
              Workspace files
            </p>
          </div>
          <span
            className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium"
            style={{
              backgroundColor:
                "color-mix(in srgb, var(--aurora-common-primary) 12%, transparent)",
              color: "var(--aurora-common-primary)",
              border:
                "1px solid color-mix(in srgb, var(--aurora-common-primary) 28%, transparent)",
              borderRadius: 4,
            }}
          >
            {filteredFiles.length}
          </span>
        </div>

        {filteredFiles.length === 0 ? (
          <div
            className="px-3 py-5 text-center text-[11.5px]"
            style={{
              color:
                "var(--aurora-text-secondary, var(--aurora-editor-foreground))",
            }}
          >
            {allFiles.length === 0
              ? "No files in workspace"
              : "No matching files."}
          </div>
        ) : (
          <div className="max-h-56 overflow-y-auto px-1.5 py-1.5 scrollbar-thin">
            {filteredFiles.map((file, idx) => {
              const isActive = idx === selectedFileIndex;
              return (
                <button
                  key={file.id}
                  onClick={() => selectFile(file)}
                  onMouseEnter={() => setSelectedFileIndex(idx)}
                  className="w-full text-left flex items-center gap-2 px-2 py-1.5 transition-colors"
                  style={{
                    borderRadius: 5,
                    color: isActive
                      ? "var(--aurora-common-primary)"
                      : "var(--aurora-editor-foreground)",
                    backgroundColor: isActive
                      ? "color-mix(in srgb, var(--aurora-common-primary) 12%, transparent)"
                      : "transparent",
                  }}
                >
                  <FileIcon
                    name={file.name}
                    path={file.path}
                    className="w-3.5 h-3.5 min-w-3.5"
                  />
                  <span className="truncate text-[12px] font-medium">
                    {file.name}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>,
      document.body,
    );
  };

  const renderPromptAttachmentPopup = () => (
    <PromptAttachmentPopup
      id="prompt-attachment-popup"
      isOpen={slashQuery !== null}
      items={filteredPromptAssets}
      onHoverIndex={setSelectedPromptAssetIndex}
      onQueryChange={setSlashSearchQuery}
      onSelect={selectPromptAttachment}
      position={slashPopupPosition}
      query={slashSearchQuery || slashQuery || ""}
      selectedIndex={selectedPromptAssetIndex}
    />
  );

  // --- DRAG DROP HANDLERS ---
  const attachFilePaths = useCallback((paths: string[]) => {
    setAttachedFilesLocal((prev) => {
      const existingPaths = new Set(prev.map((file) => file.path));
      const nextFiles = paths
        .filter((path) => path && !existingPaths.has(path))
        .map((path) => ({ path, name: getFilename(path) }));

      return nextFiles.length > 0 ? [...prev, ...nextFiles] : prev;
    });

    textareaRef.current?.focus();
  }, []);

  useEffect(() => addAttachmentDropListener(attachFilePaths), [attachFilePaths]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "link";
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);

    const filePath = getDragFilePath(e);
    if (!filePath) return;

    attachFilePaths([filePath]);
  }, [attachFilePaths]);

  // Handle clicking anywhere in container to focus input
  const handleContainerClick = (e: React.MouseEvent) => {
    // Don't focus if clicking on a button or interactive element
    if (
      (e.target as HTMLElement).closest("button") ||
      (e.target as HTMLElement).closest('[role="button"]')
    )
      return;
    textareaRef.current?.focus();
  };

  const hasComposerContent =
    content.trim().length > 0 ||
    attachedFiles.length > 0 ||
    attachedPromptAssets.length > 0;
  const sendDisabled =
    !isLoading &&
    (!hasComposerContent ||
      disabled ||
      !providerReady ||
      availableModels.length === 0);

  return (
    <div
      className="p-3 transition-colors relative"
      style={{ backgroundColor: "var(--aurora-chat-background)" }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-attachment-drop-zone="chat-input"
    >
      {/* Drag Overlay */}
      {isDragOver && (
        <div
          className="absolute inset-2 z-50 flex flex-col items-center justify-center animate-in fade-in duration-150"
          style={{
            backgroundColor:
              "color-mix(in srgb, var(--aurora-common-primary) 8%, transparent)",
            border:
              "1px dashed color-mix(in srgb, var(--aurora-common-primary) 55%, transparent)",
            borderRadius: 14,
            color: "var(--aurora-common-primary)",
          }}
        >
          <Paperclip className="w-5 h-5 mb-1.5" />
          <span className="text-[12px] font-semibold tracking-tight">
            Drop to attach
          </span>
        </div>
      )}

      {/* Main Composer Shell — fully theme-driven (matches the last
          committed look). Background, border, and the multi-layer focus
          shadow all come from CSS variables (chat-input-background,
          chat-input-surface, common-primary, common-shadow,
          common-primary-foreground) so themes can fully restyle the
          composer without code edits.

          The shadow stack is intentionally rich:
            • 0 6px 14px outer drop shadow (depth)
            • inset 0 1px 0 (top highlight)
            • inset 0 -1px 0 (bottom darken)
            • inset 0 10px 28px (subtle depth gradient inside)
          All four layers use color-mix() against theme tokens so they
          render correctly under any theme. */}
      <div
        onClick={handleContainerClick}
        className={clsx(
          "rounded-[22px] transition-[border-color,box-shadow] duration-200 cursor-text relative overflow-hidden",
        )}
        style={{
          backgroundColor:
            "color-mix(in srgb, var(--aurora-chat-input-background) 88%, var(--aurora-chat-surface) 12%)",
          border: isFocused
            ? "1px solid color-mix(in srgb, var(--aurora-common-primary) 22%, var(--aurora-chat-input-border) 78%)"
            : "1px solid color-mix(in srgb, var(--aurora-chat-input-border) 82%, transparent)",
          boxShadow: isFocused
            ? `
              0 6px 14px color-mix(in srgb, var(--aurora-common-shadow) 8%, transparent),
              inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 8%, transparent),
              inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 18%, transparent),
              inset 0 10px 28px color-mix(in srgb, var(--aurora-common-shadow) 7%, transparent)
            `
            : `
              0 4px 10px color-mix(in srgb, var(--aurora-common-shadow) 6%, transparent),
              inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 8%, transparent),
              inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 14%, transparent),
              inset 0 8px 22px color-mix(in srgb, var(--aurora-common-shadow) 6%, transparent)
            `,
        }}
      >
        {/* Top Control Bar — model selector + agent/plan/thinking */}
        <div className="flex items-center justify-between gap-2 px-2.5 pt-2 pb-1.5">
          <ModelSelector
            availableModels={availableModels}
            currentModelLabel={
              selectedModelOption?.label ||
              (availableModels.length > 0 ? "Select Model" : "No Models")
            }
            onOpenSettings={() => setSettingsOpen(true)}
            onSelectModel={handleModelSelect}
            selectedModel={selectedModel}
          />

          <div className="flex items-center gap-1.5">
            <AgentExecutionModeToggle
              mode={agentExecutionMode}
              onToggle={handleExecutionModeToggle}
            />
          </div>
        </div>

        {/* Attached Files / Prompt Assets / Picked Elements — wrapperless
            inline tokens. Each item is a single line of text with a faint
            primary tint behind it (no border, no chip box). Remove (×)
            appears on hover. */}
        {(attachedFiles.length > 0 ||
          attachedPromptAssets.length > 0 ||
          selectedElements.length > 0) && (
          <div className="px-3 pb-1 pt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
            {attachedFiles.map((file) => (
              <span
                key={file.path}
                onClick={() => handleFileClick(file)}
                className="group inline-flex items-center gap-1 cursor-pointer text-[11px] font-medium select-none"
                style={{ color: "var(--aurora-common-primary)" }}
                title={`Click to open ${file.path}`}
              >
                <FileIcon
                  name={file.name}
                  path={file.path}
                  className="w-3 h-3 min-w-3"
                />
                <span
                  className="truncate max-w-[180px]"
                  style={{
                    backgroundColor:
                      "color-mix(in srgb, var(--aurora-common-primary) 10%, transparent)",
                    padding: "0 4px",
                    borderRadius: 3,
                  }}
                >
                  @{file.name}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeAttachedFile(file.path);
                  }}
                  className="inline-flex h-3.5 w-3.5 items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{
                    color:
                      "var(--aurora-text-secondary, var(--aurora-editor-foreground))",
                  }}
                  onMouseEnter={(event) => {
                    event.currentTarget.style.color =
                      "var(--aurora-common-error)";
                  }}
                  onMouseLeave={(event) => {
                    event.currentTarget.style.color =
                      "var(--aurora-text-secondary, var(--aurora-editor-foreground))";
                  }}
                  title="Remove"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
            {attachedPromptAssets.map((asset) => (
              <span
                key={asset.key}
                className="group inline-flex items-center gap-1 text-[11px] font-medium select-none"
                style={{ color: "var(--aurora-common-primary)" }}
              >
                <span
                  className="truncate max-w-[200px]"
                  style={{
                    backgroundColor:
                      "color-mix(in srgb, var(--aurora-common-primary) 10%, transparent)",
                    padding: "0 4px",
                    borderRadius: 3,
                  }}
                >
                  /{asset.title}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removePromptAttachment(asset.key);
                  }}
                  className="inline-flex h-3.5 w-3.5 items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{
                    color:
                      "var(--aurora-text-secondary, var(--aurora-editor-foreground))",
                  }}
                  onMouseEnter={(event) => {
                    event.currentTarget.style.color =
                      "var(--aurora-common-error)";
                  }}
                  onMouseLeave={(event) => {
                    event.currentTarget.style.color =
                      "var(--aurora-text-secondary, var(--aurora-editor-foreground))";
                  }}
                  title="Remove"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
            {selectedElements.map((entry) => {
              const el = entry.element;
              const tooltipParts = [
                `selector: ${el.selector}`,
                `tag: <${el.tagName}>`,
                el.url ? `url: ${el.url}` : null,
                el.text ? `text: ${el.text.slice(0, 120)}${el.text.length > 120 ? '…' : ''}` : null,
                el.note ? `note: ${el.note}` : null,
              ].filter(Boolean);
              const tooltip = tooltipParts.join('\n');
              return (
                <span
                  key={entry.id}
                  className="group inline-flex items-center gap-1 text-[11px] font-medium select-none"
                  style={{ color: "var(--aurora-common-primary)" }}
                  title={tooltip}
                >
                  <MousePointer2 className="w-3 h-3 min-w-3" />
                  <span
                    className="truncate max-w-[180px]"
                    style={{
                      backgroundColor:
                        "color-mix(in srgb, var(--aurora-common-primary) 10%, transparent)",
                      padding: "0 4px",
                      borderRadius: 3,
                    }}
                  >
                    Selected {entry.index}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeSelectedElement(entry.id);
                    }}
                    className="inline-flex h-3.5 w-3.5 items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{
                      color:
                        "var(--aurora-text-secondary, var(--aurora-editor-foreground))",
                    }}
                    onMouseEnter={(event) => {
                      event.currentTarget.style.color =
                        "var(--aurora-common-error)";
                    }}
                    onMouseLeave={(event) => {
                      event.currentTarget.style.color =
                        "var(--aurora-text-secondary, var(--aurora-editor-foreground))";
                    }}
                    title="Remove this selection"
                  >
                    <X size={10} />
                  </button>
                </span>
              );
            })}
          </div>
        )}

        {/* Setup nudge when no provider is configured */}
        {!providerReady && !isLoading && (
          <div
            className="mx-2.5 mb-1.5 mt-1 flex items-center gap-2 px-2.5 py-1.5"
            style={{
              backgroundColor:
                "color-mix(in srgb, var(--aurora-common-warning) 10%, var(--aurora-chat-surface))",
              border:
                "1px solid color-mix(in srgb, var(--aurora-common-warning) 30%, transparent)",
              borderRadius: 6,
            }}
          >
            <AlertCircle
              size={13}
              className="shrink-0"
              style={{ color: "var(--aurora-common-warning)" }}
            />
            <span
              className="text-[11px] flex-1"
              style={{ color: "var(--aurora-editor-foreground)" }}
            >
              Connect an AI provider to start chatting.
            </span>
            <button
              onClick={() => setSettingsOpen(true)}
              className="text-[10px] font-semibold px-2 py-0.5 transition-colors shrink-0"
              style={{
                backgroundColor: "var(--aurora-common-primary)",
                color: "var(--aurora-common-primary-foreground)",
                borderRadius: 4,
              }}
            >
              Open Settings
            </button>
          </div>
        )}

        {/* Text Input */}
        <div className="px-3 pb-2 pt-1">
          <textarea
            ref={textareaRef}
            value={content}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            disabled={disabled || isLoading || !providerReady}
            placeholder={
              !providerReady
                ? "Add an API key in Settings to get started…"
                : attachedFiles.length > 0 ||
                    attachedPromptAssets.length > 0 ||
                    selectedElements.length > 0
                  ? "Ask Aurora about the attached context…"
                  : "Message Aurora — type @ for files, / for skills and rules"
            }
            className="w-full bg-transparent text-[13.5px] font-normal tracking-[0.01em] text-text-primary resize-none border-0 outline-none ring-0 focus:border-0 focus:outline-none focus:ring-0 focus-visible:border-0 focus-visible:outline-none min-h-[36px] max-h-[200px] placeholder:text-text-disabled leading-[1.55]"
            rows={1}
          />
        </div>

        {/* Bottom Actions */}
        <div className="px-2 pb-1.5 flex items-center gap-1.5">
          <div className="flex-1 pl-1.5 min-w-0">
            {hasInteracted && <ContextUsageIndicator />}
          </div>
          <SpeechInputButton
            disabled={disabled || isLoading}
            onTranscript={handleSpeechTranscript}
          />
          <button
            onClick={handleStopOrSend}
            disabled={sendDisabled}
            className="flex h-7 w-7 items-center justify-center transition-all duration-150 outline-none focus:outline-none disabled:cursor-not-allowed"
            style={{
              backgroundColor: isLoading
                ? "color-mix(in srgb, var(--aurora-common-error) 16%, transparent)"
                : hasComposerContent
                  ? "var(--aurora-common-primary)"
                  : "color-mix(in srgb, var(--aurora-chat-surface) 92%, transparent)",
              border: `1px solid ${
                isLoading
                  ? "color-mix(in srgb, var(--aurora-common-error) 36%, transparent)"
                  : hasComposerContent
                    ? "color-mix(in srgb, var(--aurora-common-primary) 50%, transparent)"
                    : "color-mix(in srgb, var(--aurora-chat-surface-border) 80%, transparent)"
              }`,
              color: isLoading
                ? "var(--aurora-common-error)"
                : hasComposerContent
                  ? "var(--aurora-common-primary-foreground)"
                  : "var(--aurora-text-disabled, var(--aurora-editor-foreground))",
              borderRadius: 7,
              opacity: sendDisabled && !isLoading ? 0.65 : 1,
            }}
            title={isLoading ? "Stop generation" : "Send message"}
          >
            {isLoading ? (
              <Square size={11} fill="currentColor" />
            ) : (
              <ArrowUp
                size={14}
                strokeWidth={hasComposerContent ? 2.6 : 2}
              />
            )}
          </button>
        </div>
      </div>

      {/* Footer Area: Tasks OR Caution */}
      <div className="mt-1.5 text-center min-h-[18px] flex items-center justify-center w-full">
        {isVisible && tasks.length > 0 ? (
          <CompactTaskList todos={tasks} />
        ) : (
          <GeneratingStatus />
        )}
      </div>

      {renderMentionPopup()}
      {renderPromptAttachmentPopup()}
    </div>
  );
};
