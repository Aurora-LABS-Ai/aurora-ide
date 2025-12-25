import React, { useState, useRef, useEffect } from 'react';
import { Send, Brain, ChevronDown, Settings } from 'lucide-react';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';
import clsx from 'clsx';
import { createPortal } from 'react-dom';

interface ChatInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
}

export const ChatInput: React.FC<ChatInputProps> = ({ onSend, disabled }) => {
  const [content, setContent] = useState('');
  const [showOptions, setShowOptions] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  
  const { setSettingsOpen } = useUiStore();
  const { 
    thinkingEnabled, 
    setThinkingEnabled,
    selectedModel,
    setSelectedModel,
    getAvailableModels,
    providers,
  } = useSettingsStore();

  // Re-compute available models when providers change
  const availableModels = getAvailableModels();
  const [, currentModel] = selectedModel.split(':');

  // Debug: log available models
  useEffect(() => {
    console.log('Available models:', availableModels);
    console.log('Providers:', providers);
  }, [availableModels, providers]);

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

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        // Check if click is inside dropdown portal
        const dropdown = document.getElementById('model-dropdown-portal');
        if (dropdown && dropdown.contains(e.target as Node)) return;
        setShowModelDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSubmit = () => {
    if (!content.trim() || disabled) return;
    onSend(content);
    setContent('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
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

  // Render dropdown as portal to avoid clipping
  const renderDropdown = () => {
    if (!showModelDropdown) return null;

    const dropdown = (
      <div 
        id="model-dropdown-portal"
        className="fixed w-52 bg-titlebar border border-border rounded-lg shadow-2xl overflow-hidden z-[9999]"
        style={{
          top: dropdownPosition.top,
          left: dropdownPosition.left,
          transform: 'translateY(-100%)',
        }}
      >
        {availableModels.length === 0 ? (
          <div className="p-3 text-center">
            <p className="text-[11px] text-text-disabled mb-2">No models available</p>
            <p className="text-[10px] text-text-disabled mb-3">
              Add API key to a provider or add a local model
            </p>
            <button
              onClick={() => {
                setShowModelDropdown(false);
                setSettingsOpen(true);
              }}
              className="text-[11px] text-primary hover:underline flex items-center gap-1.5 mx-auto"
            >
              <Settings className="w-3.5 h-3.5" />
              Open Settings
            </button>
          </div>
        ) : (
          <div className="max-h-64 overflow-y-auto scrollbar-thin py-1">
            {availableModels.map(({ providerId, providerName, model, label }) => (
              <button
                key={`${providerId}:${model}`}
                onClick={() => handleModelSelect(providerId, model)}
                className={clsx(
                  "w-full px-3 py-2 text-left text-[12px] hover:bg-input transition-colors flex items-center justify-between",
                  selectedModel === `${providerId}:${model}` && "bg-input text-primary"
                )}
              >
                <span className="truncate font-medium">{label}</span>
                <span className="text-[10px] text-text-disabled ml-2 shrink-0">{providerName}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );

    return createPortal(dropdown, document.body);
  };

  return (
    <div className="p-3 bg-sidebar">
      <div className="bg-input rounded-xl">
        {/* Options Panel */}
        {showOptions && (
          <div className="px-3 pt-3 pb-2 border-b border-input-border">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Brain className={clsx(
                  "w-3.5 h-3.5 transition-colors",
                  thinkingEnabled ? "text-primary" : "text-text-disabled"
                )} />
                <span className="text-[11px] text-text-secondary">Thinking Mode</span>
              </div>
              <button
                onClick={() => setThinkingEnabled(!thinkingEnabled)}
                className={clsx(
                  "w-7 h-3.5 rounded-full transition-colors relative",
                  thinkingEnabled ? "bg-primary" : "bg-input-border"
                )}
              >
                <div className={clsx(
                  "w-2.5 h-2.5 rounded-full bg-white absolute top-0.5 transition-transform",
                  thinkingEnabled ? "translate-x-3.5" : "translate-x-0.5"
                )} />
              </button>
            </div>
          </div>
        )}

        {/* Input Area */}
        <div className="px-3 pt-3 pb-2">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            placeholder="Message Aurora..."
            className="w-full bg-transparent text-[13px] text-text-primary resize-none outline-none min-h-[24px] max-h-[120px] placeholder:text-text-disabled select-text"
            rows={1}
          />
        </div>
        
        {/* Toolbar */}
        <div className="px-2 pb-2 flex items-center justify-between">
          <div className="flex items-center gap-1">
            {/* Model Selector */}
            <button
              ref={buttonRef}
              onClick={() => setShowModelDropdown(!showModelDropdown)}
              className={clsx(
                "px-2 py-1 rounded text-[11px] font-medium transition-colors flex items-center gap-1",
                showModelDropdown 
                  ? "bg-primary/20 text-primary" 
                  : "bg-input-border/50 text-text-secondary hover:text-text-primary"
              )}
            >
              {availableModels.length > 0 ? (currentModel || 'Select model') : 'No models'}
              <ChevronDown className={clsx("w-3 h-3 transition-transform", showModelDropdown && "rotate-180")} />
            </button>

            {renderDropdown()}
            
            <button
              onClick={() => setShowOptions(!showOptions)}
              className={clsx(
                "p-1.5 rounded transition-colors",
                showOptions || thinkingEnabled 
                  ? "text-primary" 
                  : "text-text-disabled hover:text-text-secondary"
              )}
              title="Thinking options"
            >
              <Brain className="w-3.5 h-3.5" />
            </button>
          </div>
          
          <button
            onClick={handleSubmit}
            disabled={!content.trim() || disabled || availableModels.length === 0}
            className="p-1.5 text-text-disabled hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title={availableModels.length === 0 ? 'Configure a provider first' : 'Send'}
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
