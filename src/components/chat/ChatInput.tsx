import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Send, Square, Brain, ChevronDown, Settings, X, Paperclip, Sparkles } from 'lucide-react';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';
import { useChatStore } from '../../store/useChatStore';
import { useWorkspaceStore, loadFileContent } from '../../store/useWorkspaceStore';
import { useEditorStore } from '../../store/useEditorStore';
import { useTaskStore } from '../../store/useTaskStore';
import type { FileNode } from '../../types';
import clsx from 'clsx';
import { createPortal } from 'react-dom';
import { getDragFilePath, getFilename, getLanguageFromExtension } from '../../lib/file-utils';
import { FileIcon } from '../explorer/FileIcons';
import { CompactTaskList } from './TaskView';
import { ContextUsageIndicator } from './ContextUsageIndicator';

export interface AttachedFile {
  path: string;
  name: string;
}

interface ChatInputProps {
  onSend: (content: string, attachedFiles?: AttachedFile[]) => void;
  disabled?: boolean;
}

const flattenFiles = (nodes: FileNode[]): FileNode[] => {
  let result: FileNode[] = [];
  for (const node of nodes) {
    if (node.type === 'file') {
      result.push(node);
    } else if (node.children) {
      result = [...result, ...flattenFiles(node.children)];
    }
  }
  return result;
};

export const ChatInput: React.FC<ChatInputProps> = ({ onSend, disabled }) => {
  const [content, setContent] = useState('');
  const [_showOptions, _setShowOptions] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const [isDragOver, setIsDragOver] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [hasInteracted, setHasInteracted] = useState(false);

  // Mention Logic State
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState<number>(-1);
  const [_mentionCoords, _setMentionCoords] = useState({ top: 0, left: 0 });
  const [filteredFiles, setFilteredFiles] = useState<FileNode[]>([]);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const { setSettingsOpen } = useUiStore();
  const { isLoading, stopGeneration } = useChatStore();
  const { files: workspaceFiles } = useWorkspaceStore();
  const { openFile } = useEditorStore();
  const { tasks, isVisible } = useTaskStore();
  const {
    thinkingEnabled,
    setThinkingEnabled,
    selectedModel,
    setSelectedModel,
    getAvailableModels,
  } = useSettingsStore();

  // Re-compute available models when providers change
  const availableModels = getAvailableModels();
  const [, currentModel] = selectedModel.split(':');

  // Flatten files for searching
  const allFiles = useMemo(() => flattenFiles(workspaceFiles), [workspaceFiles]);

  // Handle Input Change for Mentions
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newVal = e.target.value;
    setContent(newVal);

    // Detect @ mention
    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = newVal.slice(0, cursorPos);
    const lastAtSymbol = textBeforeCursor.lastIndexOf('@');

    if (lastAtSymbol !== -1) {
      // Check if there's a space before @ (or it's the start)
      const isValidStart = lastAtSymbol === 0 || /\s/.test(textBeforeCursor[lastAtSymbol - 1]);

      if (isValidStart) {
        const query = textBeforeCursor.slice(lastAtSymbol + 1);
        // Only trigger if no spaces in query yet (simple mention) - or allow spaces if we want filename matching with spaces?
        // Let's stick to no spaces for now or until newline
        if (!query.includes('\n')) {
          setMentionQuery(query);
          setMentionIndex(lastAtSymbol);

          // Calculate coords (simplified approximation)
          if (textareaRef.current) {
            const rect = textareaRef.current.getBoundingClientRect();
            // This is a rough approx, for production ideally use a proper caret coordinator or hidden div mirror
            // For now, we center it above the textarea or at outline
            _setMentionCoords({
              top: rect.top - 10,
              left: rect.left + 20 + (query.length * 6), // Offset slightly
            });
          }
          return;
        }
      }
    }

    setMentionQuery(null);
  };

  // Filter files when mention query changes
  useEffect(() => {
    if (mentionQuery !== null) {
      const lowerQuery = mentionQuery.toLowerCase();
      const filtered = allFiles
        .filter(f => f.name.toLowerCase().includes(lowerQuery))
        .slice(0, 10); // Limit results
      setFilteredFiles(filtered);
      setSelectedFileIndex(0);
    }
  }, [mentionQuery, allFiles]);

  // Handle File Selection
  const selectFile = (file: FileNode | AttachedFile) => {
    // Add to attached (ensure path exists)
    if (!file.path) return;
    const filePath = file.path;
    setAttachedFiles(prev => {
      if (prev.some(f => f.path === filePath)) return prev;
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

  const handleFileClick = async (file: AttachedFile) => {
    try {
      // Load content if not already available (AttachedFile is just metadata)
      const content = await loadFileContent(file.path);
      const language = getLanguageFromExtension(file.name);
      openFile(file.path, file.name, content, language);
    } catch (err) {
      console.error('Failed to open attached file:', err);
    }
  };

  // Update dropdown position when showing
  useEffect(() => {
    if (showModelDropdown && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.top - 8, // Position above button with small gap
        left: rect.left,
      });
    }
  }, [showModelDropdown]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        // Check if click is inside dropdown portal
        const dropdown = document.getElementById('model-dropdown-portal');
        if (dropdown && dropdown.contains(e.target as Node)) return;
        setShowModelDropdown(false);
      }
      // Note: Mention popup usually closes on selection or space, but clicking away should also clear it
      if (mentionQuery !== null && !document.getElementById('mention-popup')?.contains(e.target as Node)) {
        setMentionQuery(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [mentionQuery]);

  const handleSubmit = () => {
    if ((!content.trim() && attachedFiles.length === 0) || disabled) return;
    onSend(content, attachedFiles.length > 0 ? attachedFiles : undefined);
    setContent('');
    setAttachedFiles([]);
    setHasInteracted(true);
  };

  const handleStopOrSend = () => {
    if (isLoading) {
      stopGeneration();
    } else {
      handleSubmit();
    }
  };

  const removeAttachedFile = (path: string) => {
    setAttachedFiles(files => files.filter(f => f.path !== path));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle Mention Navigation
    if (mentionQuery !== null && filteredFiles.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedFileIndex(i => (i + 1) % filteredFiles.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedFileIndex(i => (i - 1 + filteredFiles.length) % filteredFiles.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectFile(filteredFiles[selectedFileIndex]);
        return;
      }
      if (e.key === 'Escape') {
        setMentionQuery(null);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px';
    }
  }, [content]);

  const handleModelSelect = (providerId: string, model: string) => {
    setSelectedModel(`${providerId}:${model}`);
    setShowModelDropdown(false);
  };

  // Render Mention Popup
  const renderMentionPopup = () => {
    // Only return null if query is null. If files are 0, we still want to show "No files found"
    if (mentionQuery === null) return null;

    // Calculate position
    const inputRect = textareaRef.current?.getBoundingClientRect();
    if (!inputRect) return null;

    // Position above the input box (simple implementation)
    // We can improve this by using the mentionCoords logic if stable
    const popupStyle = {
      bottom: window.innerHeight - inputRect.top + 10,
      left: inputRect.left + 20, // Align with typical text start
      maxHeight: '300px',
    };

    console.log(`[MentionPopup] Rendering with ${filteredFiles.length} files. Query: "${mentionQuery}"`);

    return createPortal(
      <div
        id="mention-popup"
        className="fixed z-[10000] w-64 bg-[#1e1e1e] ring-1 ring-white/10 rounded-lg shadow-2xl overflow-hidden flex flex-col"
        style={popupStyle}
      >
        <div className="px-2 py-1.5 bg-white/5 border-b border-white/5 text-[10px] items-center flex justify-between text-zinc-400">
          <span className="font-semibold uppercase tracking-wider">Suggested Files</span>
          <span className="font-mono">{filteredFiles.length} found</span>
        </div>

        {filteredFiles.length === 0 ? (
          <div className="p-3 text-center text-zinc-500 text-[11px] italic">
            {allFiles.length === 0 ? "No files in workspace" : "No matching files found"}
          </div>
        ) : (
          <div className="max-h-48 overflow-y-auto p-1">
            {filteredFiles.map((file, idx) => (
              <button
                key={file.id}
                onClick={() => selectFile(file)}
                onMouseEnter={() => setSelectedFileIndex(idx)}
                className={clsx(
                  "w-full text-left flex items-center gap-2 px-2 py-1.5 rounded text-[11px] font-mono transition-colors",
                  idx === selectedFileIndex ? "bg-emerald-500/20 text-emerald-300" : "text-zinc-400 hover:bg-white/5"
                )}
              >
                <FileIcon name={file.name} path={file.path} className="w-4 h-4 min-w-4" />
                <span className="truncate">{file.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>,
      document.body
    );
  };

  // Render dropdown as portal to avoid clipping
  const renderDropdown = () => {
    if (!showModelDropdown) return null;

    const dropdown = (
      <div
        id="model-dropdown-portal"
        className="fixed w-60 bg-[#1e1e1e] ring-1 ring-white/10 rounded-xl shadow-xl shadow-black/80 overflow-hidden z-[9999]"
        style={{
          top: dropdownPosition.top,
          left: dropdownPosition.left,
          transform: 'translateY(-100%)',
        }}
      >
        <div className="px-3 py-2 border-b border-white/5 bg-white/[0.02]">
          <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">Select Model</span>
        </div>

        {availableModels.length === 0 ? (
          <div className="p-4 text-center">
            <p className="text-[11px] text-zinc-500 mb-2">No models found</p>
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
                  "w-full px-3 py-2 text-left text-[12px] hover:bg-white/5 transition-colors flex items-center justify-between group",
                  selectedModel === `${providerId}:${model}` && "bg-primary/10 text-primary hover:bg-primary/15"
                )}
              >
                <div className="flex flex-col">
                  <span className={clsx("font-medium", selectedModel !== `${providerId}:${model}` && "text-zinc-300")}>{label}</span>
                  <span className="text-[10px] text-zinc-500 group-hover:text-zinc-400 transition-colors">{providerName}</span>
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

  // --- DRAG DROP HANDLERS ---
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'link';
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
    setAttachedFiles(prev => {
      if (prev.some(f => f.path === filePath)) return prev;
      return [...prev, { path: filePath, name: filename }];
    });
    textareaRef.current?.focus();
  }, []);

  // Handle clicking anywhere in container to focus input
  const handleContainerClick = (e: React.MouseEvent) => {
    // Don't focus if clicking on a button or interactive element
    if ((e.target as HTMLElement).closest('button') || (e.target as HTMLElement).closest('[role="button"]')) return;
    textareaRef.current?.focus();
  };

  return (
    <div
      className="p-4 bg-sidebar transition-colors relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag Overlay */}
      {isDragOver && (
        <div className="absolute inset-2 z-50 rounded-xl border-2 border-dashed border-emerald-500/50 bg-emerald-500/5 backdrop-blur-sm flex flex-col items-center justify-center text-emerald-400 animate-in fade-in duration-200">
          <Paperclip className="w-8 h-8 mb-2 animate-bounce" />
          <span className="text-sm font-medium">Drop to attach context</span>
        </div>
      )}

      {/* Main Box */}
      <div
        onClick={handleContainerClick}
        className={clsx(
          "bg-[#1e1e1e] rounded-xl border transition-all duration-200 shadow-sm cursor-text",
          isLoading ? "border-primary/20 shadow-primary/5" : "border-white/10 hover:border-white/20"
        )}
      >

        {/* Top Control Bar */}
        <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
          {/* Model Pill */}
          <button
            ref={buttonRef}
            onClick={() => setShowModelDropdown(!showModelDropdown)}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-[10px] font-medium text-zinc-300 transition-colors border border-white/5 hover:border-white/10"
          >
            <Sparkles size={10} className="text-primary" />
            <span className="truncate max-w-[120px]">{availableModels.length > 0 ? (currentModel || 'Select Model') : 'No Models'}</span>
            <ChevronDown size={10} className={clsx("text-zinc-500 transition-transform", showModelDropdown && "rotate-180")} />
          </button>

          {/* Thinking Toggle */}
          <button
            onClick={() => setThinkingEnabled(!thinkingEnabled)}
            className={clsx(
              "flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium transition-all border",
              thinkingEnabled
                ? "bg-primary/10 border-primary/20 text-primary shadow-[0_0_10px_rgba(var(--primary-rgb),0.1)]"
                : "bg-transparent border-transparent text-zinc-500 hover:text-zinc-300"
            )}
          >
            <Brain size={12} className={thinkingEnabled ? "animate-pulse" : ""} />
            <span>Thinking</span>
          </button>
        </div>

        {/* Attached Files Scroll */}
        {attachedFiles.length > 0 && (
          <div className="px-3 py-2 flex flex-wrap gap-2 text-zinc-300">
            {attachedFiles.map(file => (
              <div
                key={file.path}
                onClick={() => handleFileClick(file)}
                className="group flex items-center gap-1.5 pl-2 pr-1 py-1 bg-emerald-500/10 text-emerald-400 rounded-md border border-emerald-500/20 text-[10px] cursor-pointer hover:bg-emerald-500/20 transition-colors"
                title="Click to open file"
              >
                <FileIcon name={file.name} path={file.path} className="w-3 h-3 min-w-3" />
                <span className="truncate max-w-[150px] font-mono">{file.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeAttachedFile(file.path);
                  }}
                  className="p-0.5 rounded-sm hover:bg-white/10 text-emerald-600 hover:text-red-400 transition-colors"
                  title="Remove file"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Text Input */}
        <div className="px-3 pb-3 pt-2">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            disabled={disabled || isLoading}
            placeholder={attachedFiles.length > 0 ? "Ask a question about these files..." : "Message Aurora (Type @ to add files)..."}
            className="w-full bg-transparent text-[13px] text-zinc-100 resize-none outline-none min-h-[40px] max-h-[200px] placeholder:text-zinc-600 font-light leading-relaxed"
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
            disabled={!isLoading && ((!content.trim() && attachedFiles.length === 0) || disabled || availableModels.length === 0)}
            className={clsx(
              "p-2 rounded-lg transition-all duration-200 flex items-center justify-center",
              isLoading
                ? "bg-red-500/10 text-red-400 hover:bg-red-500/20"
                : (content.trim() || attachedFiles.length > 0)
                  ? "bg-primary text-white hover:opacity-90 shadow-md shadow-primary/20"
                  : "bg-white/5 text-zinc-600 cursor-not-allowed"
            )}
            title={isLoading ? 'Stop generation' : 'Send message'}
          >
            {isLoading ? <Square size={14} fill="currentColor" /> : <Send size={14} className={content.trim() || attachedFiles.length > 0 ? "translate-x-0.5" : ""} />}
          </button>
        </div>
      </div>

      {/* Task List (Active) */}
      {/* Footer Area: Tasks OR Caution */}
      <div className="mt-2 text-center min-h-[20px] flex items-center justify-center w-full">
        {isVisible && tasks.length > 0 ? (
          <CompactTaskList todos={tasks} />
        ) : (
          <p className="text-[10px] text-zinc-600">
            {isLoading ? "Generating response..." : "AI can make mistakes. Review generated code."}
          </p>
        )}
      </div>

      {renderDropdown()}
      {renderMentionPopup()}
    </div>
  );
};