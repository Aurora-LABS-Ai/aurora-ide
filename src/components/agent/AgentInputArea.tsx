/**
 * Agent Mode Input Area
 *
 * Dedicated input component for Agent Mode with centered layout.
 * Shares the exact same composer design as `ChatInput` so both surfaces
 * stay visually consistent (background, border, focus halo, attachment
 * tokens, model selector, send button, slash dropdown). Differences are
 * limited to layout chrome — no outer padding wrapper, centered max width,
 * and a small footer disclaimer instead of the chat task list.
 *
 * All chrome is driven by CSS variables so theme switches restyle this
 * component without code changes.
 */

import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
} from "react";
import {
  ArrowUp,
  Square,
  X,
  Paperclip,
  AlertCircle,
} from "lucide-react";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { useChatStore } from "../../store/useChatStore";
import {
  loadFileContent,
  useWorkspaceStore,
} from "../../store/useWorkspaceStore";
import { useEditorStore } from "../../store/useEditorStore";
import { type PromptAttachment } from "../../services/prompt-assets";
import { usePromptAssetCatalog } from "../../hooks/usePromptAssetCatalog";
import { addAttachmentDropListener } from "../../lib/attachment-events";
import { FileIcon } from "../explorer/FileIcons";
import { PromptAttachmentPopup } from "../chat/PromptAttachmentPopup";
import {
  getDragFilePath,
  getFilename,
  getLanguageFromExtension,
} from "../../lib/file-utils";
import clsx from "clsx";
import { ModelSelector } from "../ui/ModelSelector";
import { AgentExecutionModeToggle } from "../ui/AgentExecutionModeToggle";
import { SpeechInputButton } from "../chat/SpeechInputButton";

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
  const draftAttachedPromptAssets = useChatStore(
    (s) => s.draftAttachedPromptAssets,
  );
  const setDraftInput = useChatStore((s) => s.setDraftInput);
  const setDraftAttachedFiles = useChatStore((s) => s.setDraftAttachedFiles);
  const setDraftAttachedPromptAssets = useChatStore(
    (s) => s.setDraftAttachedPromptAssets,
  );
  const clearDraft = useChatStore((s) => s.clearDraft);

  const [content, setContentLocal] = useState(draftInput);
  const [isFocused, setIsFocused] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [attachedFiles, setAttachedFilesLocal] = useState<AttachedFile[]>(() =>
    draftAttachedFiles.map((f) => ({ path: f.path, name: f.name })),
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { isLoading, stopGeneration, consumePendingInput, pendingInputNonce } =
    useChatStore();
  const { setSettingsOpen } = useUiStore();
  const rootPath = useWorkspaceStore((state) => state.rootPath);

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
  const availableModels = getAvailableModels();
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
        if (!activeQuery) return true;
        return [
          asset.title,
          asset.subtitle,
          asset.description,
          asset.sourceLabel,
        ].some((value) => value.toLowerCase().includes(activeQuery));
      })
      .slice(0, 20);
  }, [attachedPromptAssets, promptAssetCatalog, slashQuery, slashSearchQuery]);

  // Catalog of `/` prompt picker entries (rules + skills). Auto-refreshes when
  // files in the prompt-asset folders change so newly-placed rules / skills
  // show up immediately, and exposes `refreshCatalog()` for the open-slash
  // safety net below (covers the global skills folder too).
  const { promptAssetCatalog, refreshCatalog } = usePromptAssetCatalog({
    rootPath,
    skillToggles,
    skillsEnabled,
  });

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

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      const newHeight = Math.min(
        Math.max(textareaRef.current.scrollHeight, 36),
        200,
      );
      textareaRef.current.style.height = `${newHeight}px`;
    }
  }, [content]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
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
    setContentLocal("");
    setAttachedFilesLocal([]);
    setAttachedPromptAssetsLocal([]);
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
          setAttachedPromptAssetsLocal((prev) => [...prev, attachment]);
          if (slashIndex !== -1) {
            const before = content.slice(0, slashIndex);
            const after = content.slice(
              slashIndex + (slashQuery?.length ?? 0) + 1,
            );
            setContentLocal(`${before}${after} `);
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
      setAttachedPromptAssetsLocal((items) => items.slice(0, -1));
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

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      const filePath = getDragFilePath(e);
      if (!filePath) return;

      attachFilePaths([filePath]);
    },
    [attachFilePaths],
  );

  const removeAttachedFile = (path: string) => {
    setAttachedFilesLocal((prev) => prev.filter((f) => f.path !== path));
  };

  const removePromptAttachment = (key: string) => {
    setAttachedPromptAssetsLocal((items) =>
      items.filter((item) => item.key !== key),
    );
  };

  const handleFileClick = async (file: AttachedFile) => {
    try {
      const fileContent = await loadFileContent(file.path);
      const language = getLanguageFromExtension(file.name);
      useEditorStore
        .getState()
        .openFile(file.path, file.name, fileContent, language);
    } catch (error) {
      console.error("Failed to open file:", error);
    }
  };

  const handleModelSelect = (providerId: string, model: string) => {
    setSelectedModel(`${providerId}:${model}`);
  };

  const handleInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = event.target.value;
    setContentLocal(newValue);

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
          // Refresh the catalog the moment the slash menu opens so newly-added
          // rules / skills (including those in the global skills folder, which
          // the workspace fs-watcher does not cover) appear without a reload.
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
  };

  const selectPromptAttachment = (attachment: PromptAttachment) => {
    setAttachedPromptAssetsLocal((prev) => {
      if (prev.some((item) => item.key === attachment.key)) return prev;
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
      className="w-full max-w-4xl mx-auto relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-attachment-drop-zone="agent-input"
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

      {/* Main Composer Shell — fully theme-driven, identical to ChatInput.
          Multi-layer shadow stack matches the last committed look:
          outer drop shadow + 3 inset layers (top highlight, bottom darken,
          internal depth). Every layer uses color-mix() against theme
          tokens so it renders correctly under any theme. */}
      <div
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
        onClick={() => textareaRef.current?.focus()}
      >
        {/* Top Control Bar — model selector + agent/plan */}
        <div className="flex items-center justify-between gap-2 px-2.5 pt-2 pb-1.5">
          <ModelSelector
            availableModels={availableModels}
            currentModelLabel={currentModelLabel}
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

        {/* Attached Files / Prompt Assets — wrapperless inline tokens */}
        {(attachedFiles.length > 0 || attachedPromptAssets.length > 0) && (
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
                : attachedFiles.length > 0 || attachedPromptAssets.length > 0
                  ? "Ask Aurora with your attached files, skills, or rules…"
                  : "Message Aurora — type @ for files, / for skills and rules"
            }
            className="w-full bg-transparent text-[13.5px] font-normal tracking-[0.01em] text-text-primary resize-none border-0 outline-none ring-0 focus:border-0 focus:outline-none focus:ring-0 focus-visible:border-0 focus-visible:outline-none min-h-[36px] max-h-[200px] placeholder:text-text-disabled leading-[1.55]"
            rows={1}
          />
        </div>

        {/* Bottom Actions */}
        <div className="px-2 pb-1.5 flex items-center justify-end gap-1.5">
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

      {/* Footer text */}
      <div className="mt-1.5 text-center">
        <p
          className="text-[10px]"
          style={{
            color:
              "var(--aurora-text-disabled, var(--aurora-editor-foreground))",
          }}
        >
          AI can make mistakes. Review generated code.
        </p>
      </div>

      {renderPromptAttachmentPopup()}
    </div>
  );
};

export default AgentInputArea;
