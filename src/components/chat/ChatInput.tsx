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
  Brain,
  ChevronDown,
  Settings,
  X,
  Paperclip,
  Sparkles,
  ArrowUp,
  AlertCircle,
} from "lucide-react";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { useChatStore } from "../../store/useChatStore";
import {
  useWorkspaceStore,
  loadFileContent,
} from "../../store/useWorkspaceStore";
import { useEditorStore } from "../../store/useEditorStore";
import { useTaskStore } from "../../store/useTaskStore";
import {
  loadPromptAttachments,
  type PromptAttachment,
} from "../../services/prompt-assets";
import type { FileNode } from "../../types";
import clsx from "clsx";
import { createPortal } from "react-dom";
import {
  getDragFilePath,
  getFilename,
  getLanguageFromExtension,
} from "../../lib/file-utils";
import { resolveThinkingModelPair } from "../../lib/thinking-models";
import { FileIcon } from "../explorer/FileIcons";
import { CompactTaskList } from "./TaskView";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import { PromptAttachmentPopup } from "./PromptAttachmentPopup";
import { ShimmerText } from "../ui/ShimmerText";

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

  const [content, setContentLocal] = useState(draftInput);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({
    top: 0,
    left: 0,
    placement: "above" as "above" | "below",
  });
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
  const [promptAssetCatalog, setPromptAssetCatalog] = useState<
    PromptAttachment[]
  >([]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const { setSettingsOpen } = useUiStore();
  const { isLoading, stopGeneration, consumePendingInput, pendingInputNonce } =
    useChatStore();
  const { files: workspaceFiles, rootPath } = useWorkspaceStore();
  const { openFile } = useEditorStore();
  const { tasks, isVisible } = useTaskStore();

  // Wrapped setters -- sync to draft store via separate calls (not inside updaters)
  const setContent = useCallback((valOrUpdater: string | ((prev: string) => string)) => {
    if (typeof valOrUpdater === 'function') {
      setContentLocal((prev) => {
        const next = valOrUpdater(prev);
        queueMicrotask(() => setDraftInput(next));
        return next;
      });
    } else {
      setContentLocal(valOrUpdater);
      setDraftInput(valOrUpdater);
    }
  }, [setDraftInput]);

  const setAttachedFiles = useCallback((valOrUpdater: AttachedFile[] | ((prev: AttachedFile[]) => AttachedFile[])) => {
    if (typeof valOrUpdater === 'function') {
      setAttachedFilesLocal((prev) => {
        const next = valOrUpdater(prev);
        queueMicrotask(() => setDraftAttachedFiles(next.map(f => ({ path: f.path, name: f.name }))));
        return next;
      });
    } else {
      setAttachedFilesLocal(valOrUpdater);
      setDraftAttachedFiles(valOrUpdater.map(f => ({ path: f.path, name: f.name })));
    }
  }, [setDraftAttachedFiles]);

  const setAttachedPromptAssets = useCallback((valOrUpdater: PromptAttachment[] | ((prev: PromptAttachment[]) => PromptAttachment[])) => {
    if (typeof valOrUpdater === 'function') {
      setAttachedPromptAssetsLocal((prev) => {
        const next = valOrUpdater(prev);
        queueMicrotask(() => setDraftAttachedPromptAssets(next));
        return next;
      });
    } else {
      setAttachedPromptAssetsLocal(valOrUpdater);
      setDraftAttachedPromptAssets(valOrUpdater);
    }
  }, [setDraftAttachedPromptAssets]);
  const {
    thinkingEnabled,
    setThinkingEnabled,
    selectedModel,
    setSelectedModel,
    getAvailableModels,
    getLLMConfig,
    skillToggles,
    skillsEnabled,
  } = useSettingsStore();

  const llmConfig = getLLMConfig();
  const providerReady = llmConfig !== null;
  const providerSupportsThinking = llmConfig?.supportsThinking ?? false;

  // Re-compute available models when providers change
  const availableModels = getAvailableModels();
  const [selectedProviderId = "", currentModel = ""] = selectedModel.split(":");
  const providerModels = useMemo(
    () =>
      availableModels
        .filter((item) => item.providerId === selectedProviderId)
        .map((item) => item.model),
    [availableModels, selectedProviderId],
  );
  const thinkingPair = useMemo(
    () => resolveThinkingModelPair(currentModel, providerModels),
    [currentModel, providerModels],
  );
  const showThinkingToggle = providerSupportsThinking && !!thinkingPair;
  const effectiveThinkingEnabled = thinkingPair
    ? thinkingPair.currentModelIsThinking
    : thinkingEnabled;
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

  useEffect(() => {
    let isCancelled = false;

    const loadCatalog = async () => {
      const attachments = await loadPromptAttachments(rootPath, {
        enabledSkillToggles: skillToggles,
        skillsEnabled,
      });
      if (!isCancelled) {
        setPromptAssetCatalog(attachments);
      }
    };

    void loadCatalog();

    return () => {
      isCancelled = true;
    };
  }, [rootPath, skillToggles, skillsEnabled]);

  // Consume pending input from external sources (e.g., browser element inspector, suggested prompts)
  useEffect(() => {
    const { content: pending, replace } = consumePendingInput();
    if (pending) {
      const rafId = window.requestAnimationFrame(() => {
        if (replace) {
          setContent(pending);
        } else {
          setContent((prev) => (prev ? `${prev}\n\n${pending}` : pending));
        }
        textareaRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(rafId);
    }
  }, [pendingInputNonce, consumePendingInput]);

  // Handle Input Change for Mentions
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newVal = e.target.value;
    setContent(newVal);

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
    setAttachedFiles((prev) => {
      if (prev.some((f) => f.path === filePath)) return prev;
      return [...prev, { path: filePath, name: file.name }];
    });

    // Remove text query if via mention
    if (mentionQuery !== null && mentionIndex !== -1) {
      const before = content.slice(0, mentionIndex);
      const after = content.slice(mentionIndex + mentionQuery.length + 1); // +1 for @
      setContent(`${before}${after} `);
      // Close popup
      setMentionQuery(null);
    }
  };

  const selectPromptAttachment = (attachment: PromptAttachment) => {
    setAttachedPromptAssets((prev) => {
      if (prev.some((item) => item.key === attachment.key)) {
        return prev;
      }
      return [...prev, attachment];
    });

    if (slashQuery !== null && slashIndex !== -1) {
      const before = content.slice(0, slashIndex);
      const after = content.slice(slashIndex + slashQuery.length + 1);
      setContent(`${before}${after} `);
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

  // Update dropdown position when showing
  const positionModelDropdown = useCallback(() => {
    if (!buttonRef.current) return;

    const rect = buttonRef.current.getBoundingClientRect();
    const dropdownWidth = 256;
    const estimatedDropdownHeight = Math.min(
      320,
      44 + Math.max(availableModels.length, 1) * 56,
    );
    const viewportPadding = 12;
    const gap = 8;

    const clampedLeft = Math.min(
      Math.max(rect.left, viewportPadding),
      window.innerWidth - dropdownWidth - viewportPadding,
    );

    const preferredTop = rect.top - gap - estimatedDropdownHeight;
    const canPlaceAbove = preferredTop >= viewportPadding;

    const top = canPlaceAbove
      ? Math.max(viewportPadding, preferredTop)
      : Math.min(
          rect.bottom + gap,
          window.innerHeight - estimatedDropdownHeight - viewportPadding,
        );

    setDropdownPosition({
      top,
      left: clampedLeft,
      placement: canPlaceAbove ? "above" : "below",
    });
  }, [availableModels.length]);

  useEffect(() => {
    if (showModelDropdown) {
      positionModelDropdown();
    }
  }, [positionModelDropdown, showModelDropdown]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        // Check if click is inside dropdown portal
        const dropdown = document.getElementById("model-dropdown-portal");
        if (dropdown && dropdown.contains(e.target as Node)) return;
        setShowModelDropdown(false);
      }
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
        attachedPromptAssets.length === 0) ||
      disabled
    )
      return;
    onSend(
      content,
      attachedFiles.length > 0 ? attachedFiles : undefined,
      attachedPromptAssets.length > 0 ? attachedPromptAssets : undefined,
    );
    setContent("");
    setAttachedFiles([]);
    setAttachedPromptAssets([]);
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
    setAttachedFiles((files) => files.filter((f) => f.path !== path));
  };

  const removePromptAttachment = (key: string) => {
    setAttachedPromptAssets((items) =>
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
      setAttachedPromptAssets((items) => items.slice(0, -1));
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
    setShowModelDropdown(false);
  };

  const handleThinkingToggle = useCallback(() => {
    if (!thinkingPair || !selectedProviderId) {
      setThinkingEnabled(!thinkingEnabled);
      return;
    }

    const nextModel = effectiveThinkingEnabled
      ? thinkingPair.nonThinkModel
      : thinkingPair.thinkModel;

    if (nextModel && nextModel !== currentModel) {
      setSelectedModel(`${selectedProviderId}:${nextModel}`);
    } else {
      setThinkingEnabled(!thinkingEnabled);
    }
  }, [
    thinkingPair,
    selectedProviderId,
    effectiveThinkingEnabled,
    currentModel,
    setSelectedModel,
    setThinkingEnabled,
    thinkingEnabled,
  ]);

  // Render Mention Popup
  const renderMentionPopup = () => {
    // Only return null if query is null. If files are 0, we still want to show "No files found"
    if (mentionQuery === null) return null;
    if (!mentionPopupPosition) return null;

    // Position above the input box (simple implementation)
    // We can improve this by using the mentionCoords logic if stable
    const popupStyle = {
      bottom: mentionPopupPosition.bottom,
      left: mentionPopupPosition.left, // Align with typical text start
      maxHeight: "300px",
    };

    console.log(
      `[MentionPopup] Rendering with ${filteredFiles.length} files. Query: "${mentionQuery}"`,
    );

    return createPortal(
      <div
        id="mention-popup"
        className="fixed z-[10000] w-72 overflow-hidden rounded-2xl border border-border/70 shadow-2xl backdrop-blur-xl animate-in zoom-in-95 duration-100 flex flex-col"
        style={{
          ...popupStyle,
          background:
            "color-mix(in srgb, var(--aurora-chat-surface) 92%, var(--aurora-sidebar-background) 8%)",
          boxShadow: `
            0 18px 40px color-mix(in srgb, var(--aurora-common-shadow) 28%, transparent),
            0 2px 10px color-mix(in srgb, var(--aurora-common-shadow) 18%, transparent),
            inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 8%, transparent)
          `,
        }}
      >
        <div
          className="px-3 py-2 border-b border-border/70 text-[10px] items-center flex justify-between"
          style={{
            background:
              "linear-gradient(180deg, color-mix(in srgb, var(--aurora-title-bar-background) 82%, transparent) 0%, color-mix(in srgb, var(--aurora-chat-surface) 92%, transparent) 100%)",
            color: "var(--aurora-common-text-secondary)",
          }}
        >
          <span className="font-semibold uppercase tracking-[0.18em]">
            Suggested Files
          </span>
          <span
            className="rounded-md px-1.5 py-0.5 text-[9px] font-medium"
            style={{
              background:
                "color-mix(in srgb, var(--aurora-common-primary) 10%, transparent)",
              color: "var(--aurora-common-primary)",
            }}
          >
            {filteredFiles.length}
          </span>
        </div>

        {filteredFiles.length === 0 ? (
          <div
            className="p-4 text-center text-[11px] italic"
            style={{ color: "var(--aurora-common-text-disabled)" }}
          >
            {allFiles.length === 0
              ? "No files in workspace"
              : "No matching files found"}
          </div>
        ) : (
          <div className="max-h-56 overflow-y-auto p-1.5 scrollbar-thin">
            {filteredFiles.map((file, idx) => (
              <button
                key={file.id}
                onClick={() => selectFile(file)}
                onMouseEnter={() => setSelectedFileIndex(idx)}
                className={clsx(
                  "w-full text-left flex items-center gap-2.5 px-2.5 py-2 rounded-xl transition-all duration-150",
                  idx === selectedFileIndex
                    ? "text-primary"
                    : "hover:bg-sidebar-item-hover",
                )}
                style={{
                  color:
                    idx === selectedFileIndex
                      ? "var(--aurora-common-primary)"
                      : "var(--aurora-common-text-secondary)",
                  background:
                    idx === selectedFileIndex
                      ? "color-mix(in srgb, var(--aurora-common-primary) 10%, transparent)"
                      : "transparent",
                  boxShadow:
                    idx === selectedFileIndex
                      ? "inset 0 0 0 1px color-mix(in srgb, var(--aurora-common-primary) 18%, transparent)"
                      : "none",
                }}
              >
                <FileIcon
                  name={file.name}
                  path={file.path}
                  className="w-4 h-4 min-w-4"
                />
                <span className="truncate">{file.name}</span>
              </button>
            ))}
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

  // Render dropdown as portal to avoid clipping
  const renderDropdown = () => {
    if (!showModelDropdown) return null;

    const dropdown = (
      <div
        id="model-dropdown-portal"
        className="fixed w-64 overflow-hidden rounded-2xl border border-border/70 shadow-2xl backdrop-blur-xl animate-in zoom-in-95 duration-100 z-[9999]"
        style={{
          top: dropdownPosition.top,
          left: dropdownPosition.left,
          transform:
            dropdownPosition.placement === "above"
              ? "translateY(0)"
              : "translateY(0)",
          background:
            "color-mix(in srgb, var(--aurora-sidebar-background) 92%, var(--aurora-chat-surface) 8%)",
          boxShadow: `
            0 18px 40px color-mix(in srgb, var(--aurora-common-shadow) 28%, transparent),
            0 2px 10px color-mix(in srgb, var(--aurora-common-shadow) 18%, transparent),
            inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 8%, transparent)
          `,
        }}
      >
        <div
          className="px-3 py-2 border-b border-border/70"
          style={{
            background:
              "linear-gradient(180deg, color-mix(in srgb, var(--aurora-title-bar-background) 82%, transparent) 0%, color-mix(in srgb, var(--aurora-sidebar-background) 96%, transparent) 100%)",
          }}
        >
          <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-[0.18em]">
            Select Model
          </span>
        </div>

        {availableModels.length === 0 ? (
          <div className="p-4 text-center">
            <p className="text-[11px] text-muted-foreground mb-2">
              No models found
            </p>
            <button
              onClick={() => {
                setShowModelDropdown(false);
                setSettingsOpen(true);
              }}
              className="text-[11px] text-primary hover:text-primary/80 flex items-center gap-1.5 mx-auto transition-colors"
            >
              <Settings size={12} />
              <span>Configure Settings</span>
            </button>
          </div>
        ) : (
          <div className="max-h-64 overflow-y-auto scrollbar-thin p-1.5">
            {availableModels.map(
              ({ providerId, providerName, model, label }) => (
                <button
                  key={`${providerId}:${model}`}
                  onClick={() => handleModelSelect(providerId, model)}
                  className={clsx(
                    "w-full px-3 py-2.5 text-left text-[12px] transition-all duration-150 flex items-center justify-between group rounded-xl",
                    selectedModel === `${providerId}:${model}`
                      ? "text-primary"
                      : "hover:bg-sidebar-item-hover",
                  )}
                  style={{
                    background:
                      selectedModel === `${providerId}:${model}`
                        ? "color-mix(in srgb, var(--aurora-common-primary) 10%, transparent)"
                        : "transparent",
                    boxShadow:
                      selectedModel === `${providerId}:${model}`
                        ? "inset 0 0 0 1px color-mix(in srgb, var(--aurora-common-primary) 18%, transparent)"
                        : "none",
                  }}
                >
                  <div className="flex flex-col">
                    <span
                      className={clsx(
                        "font-medium",
                        selectedModel !== `${providerId}:${model}` &&
                          "text-text-primary",
                      )}
                    >
                      {label}
                    </span>
                    <span className="text-[10px] text-text-disabled group-hover:text-text-secondary transition-colors">
                      {providerName}
                    </span>
                  </div>
                  {selectedModel === `${providerId}:${model}` && (
                    <div
                      className="w-1.5 h-1.5 rounded-full"
                      style={{
                        background: "var(--aurora-common-primary)",
                        boxShadow:
                          "0 0 10px color-mix(in srgb, var(--aurora-common-primary) 28%, transparent)",
                      }}
                    />
                  )}
                </button>
              ),
            )}
          </div>
        )}
      </div>
    );

    return createPortal(dropdown, document.body);
  };

  // --- DRAG DROP HANDLERS ---
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

    const filename = getFilename(filePath);
    // Add file to attached files (avoid duplicates)
    setAttachedFiles((prev) => {
      if (prev.some((f) => f.path === filePath)) return prev;
      return [...prev, { path: filePath, name: filename }];
    });
    textareaRef.current?.focus();
  }, []);

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

  return (
    <div
      className="p-4 transition-colors relative"
      style={{ backgroundColor: "var(--aurora-chat-background)" }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag Overlay */}
      {isDragOver && (
        <div className="absolute inset-2 z-50 rounded-xl border-2 border-dashed border-accent/50 bg-accent/5 backdrop-blur-sm flex flex-col items-center justify-center text-accent animate-in fade-in duration-200">
          <Paperclip className="w-8 h-8 mb-2 animate-bounce" />
          <span className="text-sm font-medium">Drop to attach context</span>
        </div>
      )}

      {/* Main Box */}
      <div
        onClick={handleContainerClick}
        className={clsx(
          "rounded-[22px] transition-all duration-500 cursor-text relative overflow-hidden",
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
          backdropFilter: "blur(10px)",
        }}
      >
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-14"
          style={{
            background:
              "linear-gradient(180deg, color-mix(in srgb, var(--aurora-common-primary-foreground) 10%, transparent) 0%, transparent 100%)",
            opacity: isFocused ? 1 : 0.8,
          }}
        />
        {/* Top Control Bar */}
        <div
          className="flex items-center justify-between px-3 pt-2.5 pb-1"
          style={{ backgroundColor: "transparent" }}
        >
          {/* Model Pill */}
          <button
            ref={buttonRef}
            onClick={() => {
              if (showModelDropdown) {
                setShowModelDropdown(false);
                return;
              }

              positionModelDropdown();
              setShowModelDropdown(true);
            }}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium text-text-primary transition-colors"
            style={{
              backgroundColor:
                "color-mix(in srgb, var(--aurora-chat-surface) 82%, transparent)",
              border: "1px solid transparent",
              boxShadow: `
                0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 10%, transparent),
                0 0 0 1px var(--aurora-chat-surface-border)
              `,
            }}
          >
            <Sparkles size={10} className="text-primary" />
            <span className="truncate max-w-[160px]">
              {selectedModelOption?.label ||
                (availableModels.length > 0 ? "Select Model" : "No Models")}
            </span>
            <ChevronDown
              size={10}
              className={clsx(
                "text-muted-foreground transition-transform",
                showModelDropdown && "rotate-180",
              )}
            />
          </button>

          {/* Thinking toggle only appears when provider exposes model pairs (think/non-think). */}
          {showThinkingToggle && (
            <button
              onClick={handleThinkingToggle}
              title={
                effectiveThinkingEnabled
                  ? `Switch to ${thinkingPair?.nonThinkModel}`
                  : `Switch to ${thinkingPair?.thinkModel}`
              }
              className={clsx(
                "flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium transition-all",
                effectiveThinkingEnabled
                  ? "bg-primary/10 text-primary"
                  : "bg-transparent text-muted-foreground hover:text-text-primary",
              )}
              style={{
                border: "1px solid transparent",
                boxShadow: effectiveThinkingEnabled
                  ? `
                      0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 10%, transparent),
                      0 0 0 1px color-mix(in srgb, var(--aurora-chat-surface-border) 40%, transparent)
                    `
                  : `
                      0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 10%, transparent),
                      0 0 0 1px var(--aurora-chat-surface-border)
                    `,
                backgroundColor: effectiveThinkingEnabled
                  ? "color-mix(in srgb, var(--aurora-chat-surface) 70%, var(--aurora-common-primary) 10%)"
                  : "var(--aurora-chat-surface)",
              }}
            >
              <Brain
                size={12}
                className={effectiveThinkingEnabled ? "animate-pulse" : ""}
              />
              <span>Thinking</span>
            </button>
          )}
        </div>

        {/* Attached Files / Prompt Assets */}
        {(attachedFiles.length > 0 || attachedPromptAssets.length > 0) && (
          <div className="px-3 py-2 flex flex-wrap gap-2 text-text-primary">
            {attachedFiles.map((file) => (
              <div
                key={file.path}
                onClick={() => handleFileClick(file)}
                className="group flex items-center gap-1.5 pl-2 pr-1 py-1 bg-accent/10 text-accent rounded-md border border-accent/20 text-[10px] cursor-pointer hover:bg-accent/20 transition-colors"
                title="Click to open file"
              >
                <FileIcon
                  name={file.name}
                  path={file.path}
                  className="w-3 h-3 min-w-3"
                />
                <span className="truncate max-w-[150px] font-medium">
                  {file.name}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeAttachedFile(file.path);
                  }}
                  className="p-0.5 rounded-sm hover:bg-input/50 text-accent hover:text-error transition-colors"
                  title="Remove file"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
            {attachedPromptAssets.map((asset) => (
              <div
                key={asset.key}
                className="group flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] transition-colors"
                style={{
                  backgroundColor: "var(--aurora-chat-surface)",
                  borderColor: "var(--aurora-chat-surface-border)",
                  color: "var(--aurora-common-text-secondary)",
                }}
              >
                <span className="rounded bg-sidebar px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-text-secondary">
                  {asset.type}
                </span>
                <span className="truncate max-w-[180px] font-medium text-text-primary">
                  {asset.title}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removePromptAttachment(asset.key);
                  }}
                  className="p-0.5 rounded-sm hover:bg-input/50 hover:text-error transition-colors"
                  title="Remove attachment"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Setup nudge when no provider is configured */}
        {!providerReady && !isLoading && (
          <div className="mx-3 mb-2 mt-1 flex items-center gap-2.5 rounded-lg border px-3 py-2.5"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--aurora-common-warning) 8%, var(--aurora-chat-surface))',
              borderColor: 'color-mix(in srgb, var(--aurora-common-warning) 25%, transparent)',
            }}
          >
            <AlertCircle size={14} className="text-warning shrink-0" />
            <span className="text-xs text-text-secondary flex-1">
              Connect an AI provider to start chatting.
            </span>
            <button
              onClick={() => setSettingsOpen(true)}
              className="text-[10px] font-semibold px-2.5 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary-hover transition-colors shrink-0"
            >
              Open Settings
            </button>
          </div>
        )}

        {/* Text Input */}
        <div className="px-3 pb-3 pt-2">
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
                ? "Add an API key in Settings to get started..."
                : attachedFiles.length > 0 || attachedPromptAssets.length > 0
                  ? "Ask Aurora with your attached files, skills, or rules..."
                  : "Message Aurora (Type @ for files, / for skills and rules)..."
            }
            className="w-full bg-transparent text-[14px] font-normal tracking-[0.01em] text-text-primary resize-none border-0 outline-none ring-0 focus:border-0 focus:outline-none focus:ring-0 focus-visible:border-0 focus-visible:outline-none min-h-[40px] max-h-[200px] placeholder:text-text-disabled leading-[1.55]"
            rows={1}
          />
        </div>

        {/* Bottom Actions */}
        <div className="px-2 pb-2 flex items-center">
          <div className="flex-1 pl-1">
            {hasInteracted && <ContextUsageIndicator />}
          </div>
          <button
            onClick={handleStopOrSend}
            disabled={
              !isLoading &&
              ((!content.trim() &&
                attachedFiles.length === 0 &&
                attachedPromptAssets.length === 0) ||
                disabled ||
                !providerReady ||
                availableModels.length === 0)
            }
            className={clsx(
              "p-1 rounded-full transition-all duration-200 flex items-center justify-center tap-highlight-transparent outline-none focus:outline-none",
              isLoading
                ? "bg-error/10 text-error hover:bg-error/20"
                : "hover:bg-transparent",
            )}
            title={isLoading ? "Stop generation" : "Send message"}
          >
            {isLoading ? (
              <Square size={14} fill="currentColor" />
            ) : (
              <div
                className={clsx(
                  "w-8 h-8 rounded-full flex items-center justify-center transition-all duration-300",
                  content.trim() || attachedFiles.length > 0
                    ? "bg-gradient-to-br from-primary to-primary/80 hover:scale-105 active:scale-95"
                    : "bg-muted text-muted-foreground",
                )}
              >
                <ArrowUp
                  size={16}
                  className={clsx(
                    "transition-all duration-300",
                    content.trim() || attachedFiles.length > 0
                      ? "text-primary-foreground stroke-[2.5px]"
                      : "opacity-50",
                  )}
                />
              </div>
            )}
          </button>
        </div>
      </div>

      {/* Task List (Active) */}
      {/* Footer Area: Tasks OR Caution */}
      <div className="mt-2 text-center min-h-[20px] flex items-center justify-center w-full">
        {isVisible && tasks.length > 0 ? (
          <CompactTaskList todos={tasks} />
        ) : (
          <GeneratingStatus />
        )}
      </div>

      {renderDropdown()}
      {renderMentionPopup()}
      {renderPromptAttachmentPopup()}
    </div>
  );
};
