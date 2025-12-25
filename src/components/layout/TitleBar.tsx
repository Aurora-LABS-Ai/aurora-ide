import React, { useCallback } from 'react';
import { Minus, Square, X, Settings, History, MessageSquare, Sun, Moon } from 'lucide-react';
import { useUiStore } from '../../store/useUiStore';

export const TitleBar: React.FC = () => {
  const { theme, toggleTheme, setSettingsOpen, setAuditOpen, isChatOpen, toggleChat } = useUiStore();

  const handleMinimize = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().minimize();
    } catch (err) {
      console.error('Failed to minimize:', err);
    }
  }, []);

  const handleMaximize = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().toggleMaximize();
    } catch (err) {
      console.error('Failed to maximize:', err);
    }
  }, []);

  const handleClose = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    } catch (err) {
      console.error('Failed to close:', err);
    }
  }, []);

  // Handle window dragging via mouse events (fallback for programmatic dragging)
  const handleMouseDown = useCallback(async (e: React.MouseEvent) => {
    // Only start drag if clicking on the drag region itself (not buttons)
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('[data-no-drag]')) return;
    
    if (e.buttons === 1) { // Left mouse button
      // Handle double-click to maximize
      if (e.detail === 2) {
        handleMaximize();
        return;
      }
      
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().startDragging();
      } catch (err) {
        console.error('Failed to start dragging:', err);
      }
    }
  }, [handleMaximize]);

  return (
    <div 
      data-tauri-drag-region
      className="h-8 bg-titlebar flex items-center justify-between border-b border-border select-none"
      onMouseDown={handleMouseDown}
    >
      {/* Left side - App branding */}
      <div 
        data-tauri-drag-region
        className="flex items-center h-full flex-1"
      >
        <div 
          data-tauri-drag-region
          className="flex items-center gap-2 px-3 h-full"
        >
          <div className="w-4 h-4 rounded bg-primary flex items-center justify-center shrink-0">
            <svg viewBox="0 0 24 24" fill="none" className="w-2.5 h-2.5 text-white">
              <path d="M12 2L13.5 9L20 8L14 12L17 19L12 14L7 19L10 12L4 8L10.5 9L12 2Z" fill="currentColor"/>
            </svg>
          </div>
          <span 
            data-tauri-drag-region
            className="text-[12px] text-text-secondary"
          >
            Aurora
          </span>
        </div>
      </div>

      {/* Right side - Actions + Window controls */}
      <div className="flex items-center h-full" data-no-drag>
        {/* Action buttons */}
        <div className="flex items-center gap-0.5 px-2">
          <button 
            onClick={() => setAuditOpen(true)}
            className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-input/50 rounded transition-colors"
            title="Audit Timeline"
          >
            <History className="w-3.5 h-3.5" />
          </button>
          <button 
            onClick={toggleTheme}
            className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-input/50 rounded transition-colors"
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          </button>
          <button 
            onClick={() => setSettingsOpen(true)}
            className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-input/50 rounded transition-colors"
            title="Settings"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
          <div className="w-[1px] h-4 bg-border mx-1" />
          <button 
            onClick={toggleChat}
            className={`p-1.5 rounded transition-colors ${isChatOpen ? 'text-primary bg-primary/10' : 'text-text-secondary hover:text-text-primary hover:bg-input/50'}`}
            title={isChatOpen ? 'Hide AI Assistant' : 'Show AI Assistant'}
          >
            <MessageSquare className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Window controls */}
        <div className="flex items-center h-full ml-2">
          <button
            onClick={handleMinimize}
            className="w-12 h-full hover:bg-text-secondary/20 transition-colors flex items-center justify-center"
            title="Minimize"
          >
            <Minus className="w-4 h-4 text-text-secondary" />
          </button>
          <button
            onClick={handleMaximize}
            className="w-12 h-full hover:bg-text-secondary/20 transition-colors flex items-center justify-center"
            title="Maximize"
          >
            <Square className="w-3 h-3 text-text-secondary" />
          </button>
          <button
            onClick={handleClose}
            className="w-12 h-full hover:bg-danger transition-colors flex items-center justify-center group"
            title="Close"
          >
            <X className="w-4 h-4 text-text-secondary group-hover:text-white" />
          </button>
        </div>
      </div>
    </div>
  );
};
