/**
 * BrowserTab Component
 * 
 * Renders a browser preview within the editor area using an iframe.
 * Provides URL navigation, refresh, and basic browser controls.
 * 
 * Note: For element inspection, users should open in external browser
 * and use native DevTools due to cross-origin security restrictions.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Home,
  Globe,
  Shield,
  X,
  ExternalLink,
  Lock,
  Unlock,
  MousePointer2,
} from 'lucide-react';
import { useEditorStore } from '../../store/useEditorStore';
import { useChatStore } from '../../store/useChatStore';

interface BrowserTabProps {
  tabId: string;
  url: string;
}

export const BrowserTab: React.FC<BrowserTabProps> = ({
  tabId,
  url: initialUrl,
}) => {
  const [currentUrl, setCurrentUrl] = useState(initialUrl || '');
  const [inputUrl, setInputUrl] = useState(initialUrl || '');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  
  const inputRef = useRef<HTMLInputElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  
  const { updateBrowserTab } = useEditorStore();
  const { appendToInput } = useChatStore();

  // Check if URL is localhost
  const isLocalUrl = useCallback((urlStr: string) => {
    try {
      const parsed = new URL(urlStr);
      return (
        parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === '0.0.0.0' ||
        parsed.hostname.endsWith('.localhost')
      );
    } catch {
      return false;
    }
  }, []);

  // Check if URL is secure
  const isSecure = useCallback((urlStr: string) => {
    try {
      const parsed = new URL(urlStr);
      return parsed.protocol === 'https:' || isLocalUrl(urlStr);
    } catch {
      return false;
    }
  }, [isLocalUrl]);

  // Normalize URL
  const normalizeUrl = useCallback((urlStr: string): string => {
    let normalized = urlStr.trim();
    
    if (!normalized) return '';
    
    if (/^localhost(:\d+)?/.test(normalized)) {
      normalized = `http://${normalized}`;
    } else if (/^:\d+/.test(normalized)) {
      normalized = `http://localhost${normalized}`;
    } else if (/^\d{2,5}$/.test(normalized)) {
      normalized = `http://localhost:${normalized}`;
    } else if (!/^https?:\/\//i.test(normalized)) {
      if (/^[\w-]+(\.[\w-]+)+/.test(normalized)) {
        normalized = `https://${normalized}`;
      } else {
        normalized = `http://${normalized}`;
      }
    }
    
    return normalized;
  }, []);

  // Extract title from URL
  const extractTitle = useCallback((urlStr: string): string => {
    try {
      const parsed = new URL(urlStr);
      if (isLocalUrl(urlStr)) {
        return `localhost:${parsed.port || '80'}`;
      }
      return parsed.hostname;
    } catch {
      return urlStr || 'New Browser';
    }
  }, [isLocalUrl]);

  // Navigate to URL
  const navigate = useCallback((urlStr: string, addToHistory = true) => {
    const normalized = normalizeUrl(urlStr);
    if (!normalized) return;
    
    setError(null);
    setIsLoading(true);
    setCurrentUrl(normalized);
    setInputUrl(normalized);
    
    // Update history
    if (addToHistory && normalized !== history[historyIndex]) {
      const newHistory = [...history.slice(0, historyIndex + 1), normalized];
      setHistory(newHistory);
      setHistoryIndex(newHistory.length - 1);
    }
    
    updateBrowserTab(tabId, {
      url: normalized,
      filename: extractTitle(normalized),
      canGoBack: historyIndex > 0 || (addToHistory && history.length > 0),
      canGoForward: false,
    });
  }, [normalizeUrl, tabId, updateBrowserTab, extractTitle, history, historyIndex]);

  // Go back in history
  const goBack = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      const url = history[newIndex];
      setCurrentUrl(url);
      setInputUrl(url);
      setIsLoading(true);
      
      updateBrowserTab(tabId, {
        url,
        filename: extractTitle(url),
        canGoBack: newIndex > 0,
        canGoForward: true,
      });
    }
  }, [historyIndex, history, tabId, updateBrowserTab, extractTitle]);

  // Go forward in history
  const goForward = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      const url = history[newIndex];
      setCurrentUrl(url);
      setInputUrl(url);
      setIsLoading(true);
      
      updateBrowserTab(tabId, {
        url,
        filename: extractTitle(url),
        canGoBack: true,
        canGoForward: newIndex < history.length - 1,
      });
    }
  }, [historyIndex, history, tabId, updateBrowserTab, extractTitle]);

  // Handle URL input submission
  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    navigate(inputUrl);
  };

  // Open in browser with DevTools hint
  const openWithDevTools = useCallback(() => {
    if (currentUrl) {
      window.open(currentUrl, '_blank');
    }
    appendToInput(
      'I opened the page in my browser. To inspect elements:\n' +
      '1. Press F12 to open DevTools\n' +
      '2. Click the element selector (top-left arrow icon)\n' +
      '3. Click on an element\n' +
      '4. Right-click in Elements panel -> Copy -> Copy selector\n' +
      '5. Paste the selector here!'
    );
  }, [currentUrl, appendToInput]);

  // Refresh page
  const refresh = useCallback(() => {
    setIsLoading(true);
    setError(null);
    
    if (iframeRef.current && currentUrl) {
      // Force reload by setting src
      iframeRef.current.src = currentUrl;
    }
  }, [currentUrl]);

  // Go home (localhost:3000)
  const goHome = () => navigate('http://localhost:3000');

  // Open in external browser
  const openExternal = () => {
    if (currentUrl) {
      window.open(currentUrl, '_blank');
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+L to focus URL bar
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
      // F5 or Ctrl+R to refresh
      if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key === 'r')) {
        e.preventDefault();
        refresh();
      }
      // Alt+Left for back
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        goBack();
      }
      // Alt+Right for forward
      if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        goForward();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [refresh, goBack, goForward]);

  // Focus URL bar on mount if empty
  useEffect(() => {
    if (!initialUrl || initialUrl === 'about:blank') {
      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
    } else {
      // Navigate to initial URL
      const normalized = normalizeUrl(initialUrl);
      if (normalized) {
        setCurrentUrl(normalized);
        setInputUrl(normalized);
        setHistory([normalized]);
        setHistoryIndex(0);
        setIsLoading(true);
      }
    }
  }, []);

  // Handle iframe load
  const handleIframeLoad = () => {
    setIsLoading(false);
    setError(null);
  };

  // Handle iframe error
  const handleIframeError = () => {
    setIsLoading(false);
    setError('Failed to load page. Make sure the server is running.');
  };

  const secure = isSecure(currentUrl);
  const local = isLocalUrl(currentUrl);
  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < history.length - 1;

  return (
    <div className="flex-1 flex flex-col bg-editor overflow-hidden">
      {/* Browser Toolbar */}
      <div
        className="flex items-center gap-2 px-2 py-1.5 border-b flex-shrink-0"
        style={{
          backgroundColor: 'var(--aurora-titleBar-background)',
          borderColor: 'var(--aurora-common-border)',
        }}
      >
        {/* Navigation Buttons */}
        <div className="flex items-center gap-0.5">
          <button
            onClick={goBack}
            disabled={!canGoBack}
            className="p-1.5 rounded-md transition-colors disabled:opacity-30 hover:bg-[var(--aurora-sidebar-itemHover)] disabled:hover:bg-transparent"
            style={{ color: 'var(--aurora-editor-foreground)' }}
            title="Back (Alt+Left)"
          >
            <ArrowLeft size={16} />
          </button>
          <button
            onClick={goForward}
            disabled={!canGoForward}
            className="p-1.5 rounded-md transition-colors disabled:opacity-30 hover:bg-[var(--aurora-sidebar-itemHover)] disabled:hover:bg-transparent"
            style={{ color: 'var(--aurora-editor-foreground)' }}
            title="Forward (Alt+Right)"
          >
            <ArrowRight size={16} />
          </button>
          <button
            onClick={refresh}
            disabled={!currentUrl}
            className="p-1.5 rounded-md transition-colors hover:bg-[var(--aurora-sidebar-itemHover)] disabled:opacity-30"
            style={{ color: 'var(--aurora-editor-foreground)' }}
            title="Refresh (F5)"
          >
            <RotateCw size={16} className={isLoading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={goHome}
            className="p-1.5 rounded-md transition-colors hover:bg-[var(--aurora-sidebar-itemHover)]"
            style={{ color: 'var(--aurora-editor-foreground)' }}
            title="Home (localhost:3000)"
          >
            <Home size={16} />
          </button>
        </div>

        {/* URL Bar */}
        <form onSubmit={handleUrlSubmit} className="flex-1 flex items-center">
          <div
            className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-colors"
            style={{
              backgroundColor: 'var(--aurora-chat-inputBackground)',
              borderColor: 'var(--aurora-chat-inputBorder)',
            }}
          >
            {currentUrl ? (
              secure ? (
                local ? (
                  <span title="Local development server"><Shield size={14} className="text-local flex-shrink-0" /></span>
                ) : (
                  <span title="Secure connection"><Lock size={14} className="text-secure flex-shrink-0" /></span>
                )
              ) : (
                <span title="Not secure"><Unlock size={14} className="text-insecure flex-shrink-0" /></span>
              )
            ) : (
              <Globe size={14} className="opacity-50 flex-shrink-0" style={{ color: 'var(--aurora-editor-foreground)' }} />
            )}
            
            <input
              ref={inputRef}
              type="text"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              placeholder="Enter URL or port (e.g., 3000, localhost:8080)"
              className="flex-1 bg-transparent outline-none text-sm"
              style={{ color: 'var(--aurora-editor-foreground)' }}
              onFocus={(e) => e.target.select()}
            />
            
            {inputUrl && (
              <button
                type="button"
                onClick={() => {
                  setInputUrl('');
                  inputRef.current?.focus();
                }}
                className="p-0.5 rounded opacity-50 hover:opacity-100 transition-opacity"
                style={{ color: 'var(--aurora-editor-foreground)' }}
              >
                <X size={14} />
              </button>
            )}
          </div>
        </form>

        {/* Action Buttons */}
        <div className="flex items-center gap-0.5">
          {/* Open in Browser for DevTools */}
          <button
            onClick={openWithDevTools}
            disabled={!currentUrl}
            className="p-1.5 rounded-md transition-colors hover:bg-[var(--aurora-sidebar-itemHover)] disabled:opacity-30"
            style={{ color: 'var(--aurora-editor-foreground)' }}
            title="Inspect with DevTools (opens in browser)"
          >
            <MousePointer2 size={16} />
          </button>
          
          <div className="w-px h-4 mx-1" style={{ backgroundColor: 'var(--aurora-common-border)' }} />
          
          <button
            onClick={openExternal}
            disabled={!currentUrl}
            className="p-1.5 rounded-md transition-colors hover:bg-[var(--aurora-sidebar-itemHover)] disabled:opacity-30"
            style={{ color: 'var(--aurora-editor-foreground)' }}
            title="Open in external browser"
          >
            <ExternalLink size={16} />
          </button>
        </div>
      </div>

      {/* Browser Content */}
      <div className="flex-1 relative overflow-hidden">
        {/* Loading Bar */}
        {isLoading && (
          <div
            className="absolute top-0 left-0 right-0 h-0.5 z-10 overflow-hidden"
            style={{ backgroundColor: 'var(--aurora-common-border)' }}
          >
            <div
              className="h-full w-1/3"
              style={{
                backgroundColor: 'var(--aurora-common-primary)',
                animation: 'loading-slide 1s ease-in-out infinite',
              }}
            />
          </div>
        )}

        {/* Iframe */}
        {currentUrl && (
          <iframe
            ref={iframeRef}
            src={currentUrl}
            className="w-full h-full border-0"
            style={{ backgroundColor: 'white' }}
            onLoad={handleIframeLoad}
            onError={handleIframeError}
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads"
            allow="clipboard-read; clipboard-write"
            title="Browser Preview"
          />
        )}

        {/* Empty State */}
        {!currentUrl && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center"
            style={{ backgroundColor: 'var(--aurora-editor-background)' }}
          >
            <Globe size={64} className="mb-4 opacity-20" style={{ color: 'var(--aurora-editor-foreground)' }} />
            <h3
              className="text-lg font-semibold mb-2"
              style={{ color: 'var(--aurora-editor-foreground)' }}
            >
              Browser Preview
            </h3>
            <p
              className="text-sm mb-6 text-center max-w-md"
              style={{ color: 'var(--aurora-sidebar-foreground)' }}
            >
              Enter a URL above to preview your web application.
              <br />
              <span className="text-xs opacity-70">
                Tip: Click the pointer icon to open in browser with DevTools
              </span>
            </p>
            <div className="flex gap-2 flex-wrap justify-center">
              <button
                onClick={() => navigate('http://localhost:3000')}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-colors hover:opacity-90"
                style={{
                  backgroundColor: 'var(--aurora-common-primary)',
                  color: 'var(--aurora-common-primaryForeground)',
                }}
              >
                localhost:3000
              </button>
              <button
                onClick={() => navigate('http://localhost:5173')}
                className="px-4 py-2 rounded-lg text-sm font-medium border transition-colors hover:bg-[var(--aurora-sidebar-itemHover)]"
                style={{
                  borderColor: 'var(--aurora-common-border)',
                  color: 'var(--aurora-editor-foreground)',
                }}
              >
                localhost:5173
              </button>
              <button
                onClick={() => navigate('http://localhost:8080')}
                className="px-4 py-2 rounded-lg text-sm font-medium border transition-colors hover:bg-[var(--aurora-sidebar-itemHover)]"
                style={{
                  borderColor: 'var(--aurora-common-border)',
                  color: 'var(--aurora-editor-foreground)',
                }}
              >
                localhost:8080
              </button>
            </div>
          </div>
        )}

        {/* Error Toast */}
        {error && (
          <div
            className="absolute bottom-4 left-4 right-4 flex items-center gap-2 px-4 py-3 rounded-lg z-30"
            style={{
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              color: '#ef4444',
            }}
          >
            <span className="text-sm flex-1">{error}</span>
            <button
              onClick={() => setError(null)}
              className="p-1 rounded hover:bg-white/10"
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>

      {/* CSS for loading animation */}
      <style>{`
        @keyframes loading-slide {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  );
};
