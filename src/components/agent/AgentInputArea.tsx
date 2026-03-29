/**
 * Agent Mode Input Area
 *
 * Dedicated input component for Agent Mode with centered layout.
 * Uses the centralized theme system via CSS variables.
 *
 * See: DOCS/theme-dev.md for full token reference
 */

import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
} from "react";
import {
  Sparkles,
  Brain,
  ArrowUp,
  Square,
  X,
  Paperclip,
  ChevronDown,
  Settings,
} from "lucide-react";
import { createPortal } from "react-dom";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { useChatStore } from "../../store/useChatStore";
import {
  loadFileContent,
  useWorkspaceStore,
} from "../../store/useWorkspaceStore";
import { useEditorStore } from "../../store/useEditorStore";
import {
  loadPromptAttachments,
  type PromptAttachment,
} from "../../services/prompt-assets";
import { FileIcon } from "../explorer/FileIcons";
import { PromptAttachmentPopup } from "../chat/PromptAttachmentPopup";
import {
  getDragFilePath,
  getFilename,
  getLanguageFromExtension,
} from "../../lib/file-utils";
import { resolveThinkingModelPair } from "../../lib/thinking-models";
import clsx from "clsx";

export interface AttachedFile {
  path: string;
  name: string;
}

interface AgentInputAreaProps {
  onSend: (
    content: string,
    attachedFiles?: AttachedFile[],
    promptAttachments?: PromptAttachment[],
  ) => void;
  disabled?: boolean;
}

export const AgentInputArea: React.FC<AgentInputAreaProps> = ({
  onSend,
  disabled,
}) => {
  // Initialize from shared draft state (persists across layout switches)
  const draftInput = useChatStore((s) => s.draftInput);
  const draftAttachedFiles = useChatStore((s) => s.draftAttachedFiles);
  const draftAttachedPromptAssets = useChatStore((s) => s.draftAttachedPromptAssets);
  const setDraftInput = useChatStore((s) => s.setDraftInput);
  const setDraftAttachedFiles = useChatStore((s) => s.setDraftAttachedFiles);
  const setDraftAttachedPromptAssets = useChatStore((s) => s.setDraftAttachedPromptAssets);
  const clearDraft = useChatStore((s) => s.clearDraft);

  const [content, setContentLocal] = useState(draftInput);
  const [isFocused, setIsFocused] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({
    top: 0,
    left: 0,
    placement: "above" as "above" | "below",
  });
  const [attachedFiles, setAttachedFilesLocal] = useState<AttachedFile[]>(
    () => draftAttachedFiles.map(f => ({ path: f.path, name: f.name }))
  );
  const [attachedPromptAssets, setAttachedPromptAssetsLocal] = useState<
    PromptAttachment[]
  >(() => [...draftAttachedPromptAssets]);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState<number>(-1);
  const [slashSearchQuery, setSlashSearchQuery] = useState("");
  const [slashPopupPosition, setSlashPopupPosition] = useState<{
    bottom: number;
    left: number;
  } | null>(null);
  const [selectedPromptAssetIndex, setSelectedPromptAssetIndex] = useState(0);
  const [promptAssetCatalog, setPromptAssetCatalog] = useState<
    PromptAttachment[]
  >([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const { isLoading, stopGeneration, consumePendingInput, pendingInputNonce } =
    useChatStore();
  const { setSettingsOpen } = useUiStore();
  const rootPath = useWorkspaceStore((state) => state.rootPath);

  // Wrapped setters that also sync to draft store
  const setContent = useCallback((valOrUpdater: string | ((prev: string) => string)) => {
    setContentLocal((prev) => {
      const next = typeof valOrUpdater === 'function' ? valOrUpdater(prev) : valOrUpdater;
      setDraftInput(next);
      return next;
    });
  }, [setDraftInput]);

  const setAttachedFiles = useCallback((valOrUpdater: AttachedFile[] | ((prev: AttachedFile[]) => AttachedFile[])) => {
    setAttachedFilesLocal((prev) => {
      const next = typeof valOrUpdater === 'function' ? valOrUpdater(prev) : valOrUpdater;
      setDraftAttachedFiles(next.map(f => ({ path: f.path, name: f.name })));
      return next;
    });
  }, [setDraftAttachedFiles]);

  const setAttachedPromptAssets = useCallback((valOrUpdater: PromptAttachment[] | ((prev: PromptAttachment[]) => PromptAttachment[])) => {
    setAttachedPromptAssetsLocal((prev) => {
      const next = typeof valOrUpdater === 'function' ? valOrUpdater(prev) : valOrUpdater;
      setDraftAttachedPromptAssets(next);
      return next;
    });
  }, [setDraftAttachedPromptAssets]);
  const {
    selectedModel,
    setSelectedModel,
    getAvailableModels,
    getLLMConfig,
    skillToggles,
    skillsEnabled,
    thinkingEnabled,
    setThinkingEnabled,
  } = useSettingsStore();

  const llmConfig = getLLMConfig();
  const providerSupportsThinking = llmConfig?.supportsThinking ?? false;
  const availableModels = getAvailableModels();
  const [selectedProviderId = "", selectedModelName = ""] =
    selectedModel.split(":");
  const providerModels = useMemo(
    () =>
      availableModels
        .filter((item) => item.providerId === selectedProviderId)
        .map((item) => item.model),
    [availableModels, selectedProviderId],
  );
  const thinkingPair = useMemo(
    () => resolveThinkingModelPair(selectedModelName, providerModels),
    [selectedModelName, providerModels],
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
  const currentModelLabel =
    selectedModelOption?.label ||
    (availableModels.length > 0 ? "Select Model" : "No Models");
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

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      const newHeight = Math.min(
        Math.max(textareaRef.current.scrollHeight, 60),
        200,
      );
      textareaRef.current.style.height = `${newHeight}px`;
    }
  }, [content]);

  const updateDropdownPosition = useCallback(() => {
    if (!buttonRef.current) return;

    const rect = buttonRef.current.getBoundingClientRect();
    const popupWidth = 256;
    const estimatedPopupHeight = Math.min(
      Math.max(availableModels.length * 52 + 56, 120),
      340,
    );
    const viewportPadding = 12;

    const left = Math.min(
      Math.max(rect.left, viewportPadding),
      window.innerWidth - popupWidth - viewportPadding,
    );

    const gap = 8;
    const preferredTop = rect.top - gap - estimatedPopupHeight;
    const fitsAbove = preferredTop >= viewportPadding;
    const top = fitsAbove
      ? Math.max(viewportPadding, preferredTop)
      : Math.min(
          rect.bottom + gap,
          window.innerHeight - estimatedPopupHeight - viewportPadding,
        );

    setDropdownPosition({
      top,
      left,
      placement: fitsAbove ? "above" : "below",
    });
  }, [availableModels.length]);

  useEffect(() => {
    if (!showModelDropdown) return;

    updateDropdownPosition();

    const handleWindowChange = () => {
      updateDropdownPosition();
    };

    window.addEventListener("resize", handleWindowChange);
    window.addEventListener("scroll", handleWindowChange, true);

    return () => {
      window.removeEventListener("resize", handleWindowChange);
      window.removeEventListener("scroll", handleWindowChange, true);
    };
  }, [showModelDropdown, updateDropdownPosition]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        const dropdown = document.getElementById("model-dropdown-portal");
        if (dropdown && dropdown.contains(e.target as Node)) return;
        setShowModelDropdown(false);
      }

      if (
        slashQuery !== null &&
        !document
          .getElementById("agent-prompt-attachment-popup")
          ?.contains(e.target as Node)
      ) {
        setSlashQuery(null);
        setSlashSearchQuery("");
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [slashQuery]);

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
  };

  const handleStopOrSend = () => {
    if (isLoading) {
      stopGeneration();
    } else {
      handleSubmit();
    }
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
        const attachment = filteredPromptAssets[selectedPromptAssetIndex];
        if (attachment) {
          setAttachedPromptAssets((prev) => [...prev, attachment]);
          if (slashIndex !== -1) {
            const before = content.slice(0, slashIndex);
            const after = content.slice(
              slashIndex + (slashQuery?.length ?? 0) + 1,
            );
            setContent(`${before}${after} `);
          }
          setSlashQuery(null);
          setSlashSearchQuery("");
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashQuery(null);
        setSlashSearchQuery("");
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey && !isLoading) {
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

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      const filePath = getDragFilePath(e);
      if (!filePath) return;

      const fileName = getFilename(filePath);
      if (attachedFiles.some((f) => f.path === filePath)) return;

      setAttachedFiles((prev) => [...prev, { path: filePath, name: fileName }]);
    },
    [attachedFiles],
  );

  const removeAttachedFile = (path: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.path !== path));
  };

  const removePromptAttachment = (key: string) => {
    setAttachedPromptAssets((items) =>
      items.filter((item) => item.key !== key),
    );
  };

  const handleFileClick = async (file: AttachedFile) => {
    try {
      const content = await loadFileContent(file.path);
      const language = getLanguageFromExtension(file.name);
      useEditorStore
        .getState()
        .openFile(file.path, file.name, content, language);
    } catch (error) {
      console.error("Failed to open file:", error);
    }
  };

  const handleModelSelect = (providerId: string, model: string) => {
    setSelectedModel(`${providerId}:${model}`);
    setShowModelDropdown(false);
  };

  const handleInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = event.target.value;
    setContent(newValue);

    const cursorPos = event.target.selectionStart;
    const textBeforeCursor = newValue.slice(0, cursorPos);

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

  const handleThinkingToggle = useCallback(() => {
    if (!thinkingPair || !selectedProviderId) {
      setThinkingEnabled(!thinkingEnabled);
      return;
    }

    const nextModel = effectiveThinkingEnabled
      ? thinkingPair.nonThinkModel
      : thinkingPair.thinkModel;

    if (nextModel && nextModel !== selectedModelName) {
      setSelectedModel(`${selectedProviderId}:${nextModel}`);
    } else {
      setThinkingEnabled(!thinkingEnabled);
    }
  }, [
    thinkingPair,
    selectedProviderId,
    effectiveThinkingEnabled,
    selectedModelName,
    setSelectedModel,
    setThinkingEnabled,
    thinkingEnabled,
  ]);

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

  const renderPromptAttachmentPopup = () => (
    <PromptAttachmentPopup
      id="agent-prompt-attachment-popup"
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

  return (
    <div
      className="w-full max-w-4xl mx-auto"
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

      {/* Main Input Box */}
      <div
        className={clsx(
          "rounded-[22px] transition-all duration-300 cursor-text relative overflow-hidden",
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
        onClick={() => textareaRef.current?.focus()}
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
        <div className="flex items-center justify-between px-3 pt-1.5 pb-0.5">
          {/* Model Pill */}
          <button
            ref={buttonRef}
            onClick={() => {
              if (showModelDropdown) {
                setShowModelDropdown(false);
                return;
              }

              updateDropdownPosition();
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
            <span className="truncate max-w-[160px]">{currentModelLabel}</span>
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
                boxShadow: `
                  0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 10%, transparent),
                  0 0 0 1px var(--aurora-chat-surface-border)
                `,
                backgroundColor: effectiveThinkingEnabled
                  ? "color-mix(in srgb, var(--aurora-chat-surface) 70%, var(--aurora-common-primary) 10%)"
                  : "color-mix(in srgb, var(--aurora-chat-surface) 82%, transparent)",
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
          <div className="px-3 py-2 flex flex-wrap gap-2">
            {attachedFiles.map((file) => (
              <div
                key={file.path}
                onClick={() => handleFileClick(file)}
                className="group flex items-center gap-1.5 pl-2 pr-1 py-1 bg-accent/10 text-accent rounded-md border border-accent/20 text-[10px] cursor-pointer hover:bg-accent/20 transition-colors"
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
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Text Input */}
        <div className="px-3 pb-1.75 pt-1">
          <textarea
            ref={textareaRef}
            value={content}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            disabled={disabled || isLoading}
            placeholder={
              attachedFiles.length > 0 || attachedPromptAssets.length > 0
                ? "Ask Aurora with your attached files, skills, or rules..."
                : "Message Aurora (Type @ for files, / for skills and rules)..."
            }
            className="w-full bg-transparent text-[14px] font-normal tracking-[0.01em] text-text-primary resize-none border-0 outline-none ring-0 focus:border-0 focus:outline-none focus:ring-0 focus-visible:border-0 focus-visible:outline-none min-h-[28px] max-h-[140px] placeholder:text-text-disabled leading-[1.55]"
            rows={1}
          />
        </div>

        {/* Bottom Actions */}
        <div className="px-2 pb-1 flex items-center justify-end">
          <button
            onClick={handleStopOrSend}
            disabled={
              !isLoading &&
              ((!content.trim() &&
                attachedFiles.length === 0 &&
                attachedPromptAssets.length === 0) ||
                disabled)
            }
            className={clsx(
              "p-1 rounded-full transition-all duration-200 flex items-center justify-center",
              isLoading
                ? "bg-error/10 text-error hover:bg-error/20"
                : "hover:bg-transparent",
            )}
          >
            {isLoading ? (
              <Square size={14} fill="currentColor" />
            ) : (
              <div
                className={clsx(
                  "w-8 h-8 rounded-full flex items-center justify-center transition-all duration-300",
                  content.trim() || attachedFiles.length > 0
                    ? "bg-gradient-to-br from-primary to-primary/80 hover:scale-105"
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

      {/* Footer text */}
      <div className="mt-2 text-center">
        <p className="text-[10px] text-muted-foreground">
          AI can make mistakes. Review generated code.
        </p>
      </div>

      {renderDropdown()}
      {renderPromptAttachmentPopup()}
    </div>
  );
};

export default AgentInputArea;
