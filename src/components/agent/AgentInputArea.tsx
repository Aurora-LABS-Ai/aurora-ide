/**
 * Agent Mode Input Area
 * 
 * Dedicated input component for Agent Mode with centered layout.
 * Uses the centralized theme system via CSS variables.
 * 
 * See: DOCS/theme-dev.md for full token reference
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Sparkles, Brain, ArrowUp, Square, X, Paperclip, ChevronDown, Settings } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';
import { useChatStore } from '../../store/useChatStore';
import { loadFileContent } from '../../store/useWorkspaceStore';
import { useEditorStore } from '../../store/useEditorStore';
import { FileIcon } from '../explorer/FileIcons';
import { getDragFilePath, getFilename, getLanguageFromExtension } from '../../lib/file-utils';
import clsx from 'clsx';

export interface AttachedFile {
  path: string;
  name: string;
}

interface AgentInputAreaProps {
  onSend: (content: string, attachedFiles?: AttachedFile[]) => void;
  disabled?: boolean;
}

export const AgentInputArea: React.FC<AgentInputAreaProps> = ({ onSend, disabled }) => {
  const [content, setContent] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const { isLoading, stopGeneration } = useChatStore();
  const { setSettingsOpen } = useUiStore();
  const {
    selectedModel,
    setSelectedModel,
    getAvailableModels,
    getLLMConfig,
    thinkingEnabled,
    setThinkingEnabled,
  } = useSettingsStore();

  const llmConfig = getLLMConfig();
  const providerSupportsThinking = llmConfig?.supportsThinking ?? false;
  const availableModels = getAvailableModels();
  const selectedModelName = selectedModel?.split(':')[1] ?? '';
  const currentModel = llmConfig?.name || selectedModelName || 'Select Model';
  const currentModelLabel = availableModels.length > 0 ? currentModel : 'No Models';

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const newHeight = Math.min(Math.max(textareaRef.current.scrollHeight, 60), 200);
      textareaRef.current.style.height = `${newHeight}px`;
    }
  }, [content]);

  useEffect(() => {
    if (showModelDropdown && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.top - 8,
        left: rect.left,
      });
    }
  }, [showModelDropdown]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        const dropdown = document.getElementById('agent-model-dropdown');
        if (dropdown && dropdown.contains(e.target as Node)) return;
        setShowModelDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSubmit = () => {
    if ((!content.trim() && attachedFiles.length === 0) || disabled) return;
    onSend(content, attachedFiles.length > 0 ? attachedFiles : undefined);
    setContent('');
    setAttachedFiles([]);
  };

  const handleStopOrSend = () => {
    if (isLoading) {
      stopGeneration();
    } else {
      handleSubmit();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !isLoading) {
      e.preventDefault();
      handleSubmit();
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

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const filePath = getDragFilePath(e);
    if (!filePath) return;

    const fileName = getFilename(filePath);
    if (attachedFiles.some(f => f.path === filePath)) return;

    setAttachedFiles(prev => [...prev, { path: filePath, name: fileName }]);
  }, [attachedFiles]);

  const removeAttachedFile = (path: string) => {
    setAttachedFiles(prev => prev.filter(f => f.path !== path));
  };

  const handleFileClick = async (file: AttachedFile) => {
    try {
      const content = await loadFileContent(file.path);
      const language = getLanguageFromExtension(file.name);
      useEditorStore.getState().openFile(file.path, file.name, content, language);
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  };

  const handleModelSelect = (providerId: string, model: string) => {
    setSelectedModel(`${providerId}:${model}`);
    setShowModelDropdown(false);
  };

  const renderDropdown = () => {
    if (!showModelDropdown) return null;

    const dropdown = (
      <div
        id="agent-model-dropdown"
        className="fixed w-60 bg-sidebar ring-1 ring-border rounded-xl shadow-xl shadow-black/80 overflow-hidden z-[9999]"
        style={{
          top: dropdownPosition.top,
          left: dropdownPosition.left,
          transform: 'translateY(-100%)',
        }}
      >
        <div className="px-3 py-2 border-b border-border bg-input/30">
          <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Select Model</span>
        </div>

        {availableModels.length === 0 ? (
          <div className="p-4 text-center">
            <p className="text-[11px] text-muted-foreground mb-2">No models found</p>
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
          <div className="max-h-64 overflow-y-auto scrollbar-thin py-1">
            {availableModels.map(({ providerId, providerName, model, label }) => (
              <button
                key={`${providerId}:${model}`}
                onClick={() => handleModelSelect(providerId, model)}
                className={clsx(
                  "w-full px-3 py-2 text-left text-[12px] hover:bg-sidebar-item-hover transition-colors flex items-center justify-between group",
                  selectedModel === `${providerId}:${model}` && "bg-primary/10 text-primary hover:bg-primary/15"
                )}
              >
                <div className="flex flex-col">
                  <span className={clsx("font-medium", selectedModel !== `${providerId}:${model}` && "text-text-primary")}>{label}</span>
                  <span className="text-[10px] text-text-disabled group-hover:text-text-secondary transition-colors">{providerName}</span>
                </div>
                {selectedModel === `${providerId}:${model}` && <div className="w-1.5 h-1.5 rounded-full bg-primary" />}
              </button>
            ))}
          </div>
        )}
      </div>
    );

    return createPortal(dropdown, document.body);
  };

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
          "rounded-xl transition-all duration-300 cursor-text"
        )}
        style={{
          backgroundColor: 'var(--aurora-chat-input-background)',
          border: isFocused
            ? '1px solid color-mix(in srgb, var(--aurora-common-primary) 12%, transparent)'
            : '1px solid var(--aurora-chat-input-border)',
          boxShadow: 'none',
        }}
        onClick={() => textareaRef.current?.focus()}
      >
        {/* Top Control Bar */}
        <div className="flex items-center justify-between px-3 pt-1.5 pb-0.5">
          {/* Model Pill */}
          <button
            ref={buttonRef}
            onClick={() => setShowModelDropdown(!showModelDropdown)}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium text-text-primary transition-colors"
            style={{
              backgroundColor: 'var(--aurora-chat-surface)',
              border: '1px solid transparent',
              boxShadow: '0 0 0 1px var(--aurora-chat-surface-border)',
            }}
          >
            <Sparkles size={10} className="text-primary" />
            <span className="truncate max-w-[120px]">{currentModelLabel}</span>
            <ChevronDown size={10} className={clsx("text-muted-foreground transition-transform", showModelDropdown && "rotate-180")} />
          </button>

          {/* Thinking Toggle */}
          <button
            onClick={() => providerSupportsThinking && setThinkingEnabled(!thinkingEnabled)}
            disabled={!providerSupportsThinking}
            className={clsx(
              "flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium transition-all",
              !providerSupportsThinking
                ? "bg-transparent text-muted-foreground cursor-not-allowed opacity-50"
                : thinkingEnabled
                  ? "bg-primary/10 text-primary"
                  : "bg-transparent text-muted-foreground hover:text-text-primary"
            )}
            style={{
              boxShadow: providerSupportsThinking
                ? '0 0 0 1px var(--aurora-chat-surface-border)'
                : 'none',
            }}
          >
            <Brain size={12} className={thinkingEnabled && providerSupportsThinking ? "animate-pulse" : ""} />
            <span>Thinking</span>
          </button>
        </div>

        {/* Attached Files */}
        {attachedFiles.length > 0 && (
          <div className="px-3 py-2 flex flex-wrap gap-2">
            {attachedFiles.map(file => (
              <div
                key={file.path}
                onClick={() => handleFileClick(file)}
                className="group flex items-center gap-1.5 pl-2 pr-1 py-1 bg-accent/10 text-accent rounded-md border border-accent/20 text-[10px] cursor-pointer hover:bg-accent/20 transition-colors"
              >
                <FileIcon name={file.name} path={file.path} className="w-3 h-3 min-w-3" />
                <span className="truncate max-w-[150px] font-medium">{file.name}</span>
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
          </div>
        )}

        {/* Text Input */}
        <div className="px-3 pb-1.75 pt-1">
          <textarea
            ref={textareaRef}
            value={content}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled || isLoading}
            placeholder={attachedFiles.length > 0 ? "Ask about these files..." : "Message Aurora (Type @ to add files)..."}
            className="w-full bg-transparent text-[13px] text-text-primary resize-none border-0 outline-none ring-0 focus:border-0 focus:outline-none focus:ring-0 focus-visible:border-0 focus-visible:outline-none min-h-[28px] max-h-[140px] placeholder:text-text-disabled font-light leading-relaxed"
            rows={1}
          />
        </div>

        {/* Bottom Actions */}
        <div className="px-2 pb-1 flex items-center justify-end">
          <button
            onClick={handleStopOrSend}
            disabled={!isLoading && ((!content.trim() && attachedFiles.length === 0) || disabled)}
            className={clsx(
              "p-1 rounded-full transition-all duration-200 flex items-center justify-center",
              isLoading
                ? "bg-error/10 text-error hover:bg-error/20"
                : "hover:bg-transparent"
            )}
          >
            {isLoading ? (
              <Square size={14} fill="currentColor" />
            ) : (
              <div className={clsx(
                "w-8 h-8 rounded-full flex items-center justify-center transition-all duration-300",
                (content.trim() || attachedFiles.length > 0)
                  ? "bg-gradient-to-br from-primary to-primary/80 hover:scale-105"
                  : "bg-muted text-muted-foreground"
              )}>
                <ArrowUp
                  size={16}
                  className={clsx(
                    "transition-all duration-300",
                    (content.trim() || attachedFiles.length > 0) ? "text-primary-foreground stroke-[2.5px]" : "opacity-50"
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
    </div>
  );
};

export default AgentInputArea;
