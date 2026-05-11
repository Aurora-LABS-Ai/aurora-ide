/**
 * BrowserTab Component
 *
 * Two operating modes:
 *
 *   1. Iframe preview (default) — fast embedded preview suitable for
 *      most pages. Cannot inspect cross-origin content because the
 *      same-origin policy blocks the parent from reading the framed
 *      document. Element-pick is unavailable in this mode.
 *
 *   2. Native inspector window — opens a real Tauri WebviewWindow via
 *      `services/browser-service.ts`. The Rust runtime injects an
 *      inspector overlay (and an optional Stagewise-style toolbar)
 *      into the page; clicked elements stream back to the chat input
 *      via `aurora:element-picked` events. This is the only way to
 *      get true element-pick fidelity for arbitrary pages.
 *
 * The native window's lifecycle is owned by this component — it
 * opens the window when the user toggles inspector mode and closes
 * it when the tab unmounts or the user toggles back.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Clock,
  ExternalLink,
  Globe,
  Home,
  Lock,
  MousePointer2,
  RotateCw,
  Shield,
  SquarePen,
  Unlock,
  X,
} from 'lucide-react';

import {
  activateInspector,
  activateStagewise,
  browserWindowLabelFor,
  closeBrowserWindow,
  createBrowserWindow,
  deactivateInspector,
  deactivateStagewise,
  navigateBrowser,
  onBrowserWindowClosed,
  onPickedElement,
  readBrowserThemeTokens,
  refreshBrowser,
} from '../../services/browser-service';
import {
  buildLocalhostUrl,
  COMMON_DEV_PORTS,
  useBrowserHistoryStore,
} from '../../store/useBrowserHistoryStore';
import { useChatStore } from '../../store/useChatStore';
import { useEditorStore } from '../../store/useEditorStore';

interface BrowserTabProps {
  tabId: string;
  url: string;
}

type InspectorMode = 'off' | 'inspector' | 'stagewise';

export const BrowserTab: React.FC<BrowserTabProps> = ({ tabId, url: initialUrl }) => {
  const [currentUrl, setCurrentUrl] = useState(initialUrl || '');
  const [inputUrl, setInputUrl] = useState(initialUrl || '');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [nativeOpen, setNativeOpen] = useState(false);
  const [inspectorMode, setInspectorMode] = useState<InspectorMode>('off');

  const inputRef = useRef<HTMLInputElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const { updateBrowserTab } = useEditorStore();
  const addSelectedElement = useChatStore((s) => s.addSelectedElement);
  const recentUrls = useBrowserHistoryStore((s) => s.recent);
  const recordVisit = useBrowserHistoryStore((s) => s.recordVisit);
  const hydrateHistory = useBrowserHistoryStore((s) => s.hydrate);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Pull persisted history once per tab mount. The store guards itself
  // against repeat hydration so this is cheap on subsequent calls.
  useEffect(() => {
    void hydrateHistory();
  }, [hydrateHistory]);

  const nativeLabel = useMemo(() => browserWindowLabelFor(tabId), [tabId]);

  // Mode the user *wants* to be in. The actual injected scripts get
  // wiped on every page navigation, so we keep this ref outside React
  // state to reliably re-arm the right tool after navigate/refresh.
  const desiredModeRef = useRef<InspectorMode>('off');
  const reArmMode = useCallback(
    (label: string) => {
      const mode = desiredModeRef.current;
      if (mode === 'off') return;
      // Give the new page a moment to become interactable before
      // injecting the overlay.
      window.setTimeout(() => {
        if (desiredModeRef.current !== mode) return;
        if (mode === 'inspector') {
          activateInspector(label).catch((err) =>
            console.warn('[BrowserTab] re-arm inspector failed:', err),
          );
        } else if (mode === 'stagewise') {
          activateStagewise(label, readBrowserThemeTokens()).catch((err) =>
            console.warn('[BrowserTab] re-arm stagewise failed:', err),
          );
        }
      }, 500);
    },
    [],
  );

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

  const isSecure = useCallback(
    (urlStr: string) => {
      try {
        const parsed = new URL(urlStr);
        return parsed.protocol === 'https:' || isLocalUrl(urlStr);
      } catch {
        return false;
      }
    },
    [isLocalUrl],
  );

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

  const extractTitle = useCallback(
    (urlStr: string): string => {
      try {
        const parsed = new URL(urlStr);
        if (isLocalUrl(urlStr)) return `localhost:${parsed.port || '80'}`;
        return parsed.hostname;
      } catch {
        return urlStr || 'New Browser';
      }
    },
    [isLocalUrl],
  );

  const navigate = useCallback(
    (urlStr: string, addToHistory = true) => {
      const normalized = normalizeUrl(urlStr);
      if (!normalized) return;

      setError(null);
      setIsLoading(true);
      setCurrentUrl(normalized);
      setInputUrl(normalized);
      setShowSuggestions(false);
      recordVisit(normalized);

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

      // Mirror the navigation to the native window if it's open.
      if (nativeOpen) {
        navigateBrowser(nativeLabel, normalized).catch((err) => {
          console.warn('[BrowserTab] native navigate failed:', err);
        });
        // Re-arm whatever inspection mode the user had on; the page
        // load wiped the injected overlay.
        reArmMode(nativeLabel);
      }
    },
    [
      normalizeUrl,
      tabId,
      updateBrowserTab,
      extractTitle,
      history,
      historyIndex,
      nativeOpen,
      nativeLabel,
      reArmMode,
      recordVisit,
    ],
  );

  const goBack = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      const url = history[newIndex];
      setHistoryIndex(newIndex);
      setCurrentUrl(url);
      setInputUrl(url);
      setIsLoading(true);
      updateBrowserTab(tabId, {
        url,
        filename: extractTitle(url),
        canGoBack: newIndex > 0,
        canGoForward: true,
      });
      if (nativeOpen) {
        navigateBrowser(nativeLabel, url).catch(() => {});
        reArmMode(nativeLabel);
      }
    }
  }, [historyIndex, history, tabId, updateBrowserTab, extractTitle, nativeOpen, nativeLabel, reArmMode]);

  const goForward = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      const url = history[newIndex];
      setHistoryIndex(newIndex);
      setCurrentUrl(url);
      setInputUrl(url);
      setIsLoading(true);
      updateBrowserTab(tabId, {
        url,
        filename: extractTitle(url),
        canGoBack: true,
        canGoForward: newIndex < history.length - 1,
      });
      if (nativeOpen) {
        navigateBrowser(nativeLabel, url).catch(() => {});
        reArmMode(nativeLabel);
      }
    }
  }, [historyIndex, history, tabId, updateBrowserTab, extractTitle, nativeOpen, nativeLabel, reArmMode]);

  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    navigate(inputUrl);
  };

  const refresh = useCallback(() => {
    setIsLoading(true);
    setError(null);
    if (nativeOpen) {
      refreshBrowser(nativeLabel)
        .catch((err) => console.warn('[BrowserTab] native refresh failed:', err))
        .finally(() => reArmMode(nativeLabel));
      return;
    }
    if (iframeRef.current && currentUrl) {
      iframeRef.current.src = currentUrl;
    }
  }, [currentUrl, nativeOpen, nativeLabel, reArmMode]);

  const goHome = () => navigate('http://localhost:3000');

  const openExternal = () => {
    if (currentUrl) window.open(currentUrl, '_blank');
  };

  const openNative = useCallback(async () => {
    if (!currentUrl) return;
    try {
      await createBrowserWindow({
        label: nativeLabel,
        url: currentUrl,
        title: `Aurora Browser — ${extractTitle(currentUrl)}`,
        width: 1280,
        height: 800,
      });
      setNativeOpen(true);
      setError(null);
    } catch (err) {
      console.error('[BrowserTab] failed to open native window:', err);
      setError(`Failed to open native window: ${err}`);
    }
  }, [currentUrl, nativeLabel, extractTitle]);

  const closeNative = useCallback(async () => {
    try {
      await closeBrowserWindow(nativeLabel);
    } catch (err) {
      console.warn('[BrowserTab] close native failed:', err);
    }
    desiredModeRef.current = 'off';
    setNativeOpen(false);
    setInspectorMode('off');
  }, [nativeLabel]);

  const setMode = useCallback((mode: InspectorMode) => {
    desiredModeRef.current = mode;
    setInspectorMode(mode);
  }, []);

  const toggleInspector = useCallback(async () => {
    if (!nativeOpen) {
      setMode('inspector');
      await openNative();
      // Page-load timing is per-site; give the WebView a moment
      // before injecting the overlay so the document is
      // interactable.
      window.setTimeout(() => {
        activateInspector(nativeLabel).catch((err) =>
          console.warn('[BrowserTab] activate inspector failed:', err),
        );
      }, 400);
      return;
    }
    if (inspectorMode === 'inspector') {
      await deactivateInspector(nativeLabel).catch(() => {});
      setMode('off');
    } else {
      if (inspectorMode === 'stagewise') {
        await deactivateStagewise(nativeLabel).catch(() => {});
      }
      await activateInspector(nativeLabel).catch((err) =>
        console.warn('[BrowserTab] activate inspector failed:', err),
      );
      setMode('inspector');
    }
  }, [nativeOpen, inspectorMode, nativeLabel, openNative, setMode]);

  const toggleStagewise = useCallback(async () => {
    if (!nativeOpen) {
      setMode('stagewise');
      await openNative();
      window.setTimeout(() => {
        activateStagewise(nativeLabel, readBrowserThemeTokens()).catch((err) =>
          console.warn('[BrowserTab] activate stagewise failed:', err),
        );
      }, 400);
      return;
    }
    if (inspectorMode === 'stagewise') {
      await deactivateStagewise(nativeLabel).catch(() => {});
      setMode('off');
    } else {
      if (inspectorMode === 'inspector') {
        await deactivateInspector(nativeLabel).catch(() => {});
      }
      await activateStagewise(nativeLabel, readBrowserThemeTokens()).catch((err) =>
        console.warn('[BrowserTab] activate stagewise failed:', err),
      );
      setMode('stagewise');
    }
  }, [nativeOpen, inspectorMode, nativeLabel, openNative, setMode]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
      if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key === 'r')) {
        e.preventDefault();
        refresh();
      }
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        goBack();
      }
      if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        goForward();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [refresh, goBack, goForward]);

  // Initial focus / hydration of the URL bar
  useEffect(() => {
    if (!initialUrl || initialUrl === 'about:blank') {
      setTimeout(() => inputRef.current?.focus(), 100);
      return;
    }
    const normalized = normalizeUrl(initialUrl);
    if (normalized) {
      setCurrentUrl(normalized);
      setInputUrl(normalized);
      setHistory([normalized]);
      setHistoryIndex(0);
      setIsLoading(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for picked elements + native window close events.
  //
  // The previous version pushed `unlisten` handles into a closure
  // array AFTER the registration promise resolved, but React
  // StrictMode mounts the effect twice in dev — and the first
  // cleanup ran before its promise resolved, leaking that listener
  // forever. The end result was every pick fired twice. The
  // `cancelled` flag makes registrations idempotent: if cleanup
  // already ran, we unlisten the handle the moment it lands instead
  // of stashing it.
  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];
    const register = (
      promise: Promise<() => void>,
      tag: string,
    ): void => {
      promise
        .then((unlisten) => {
          if (cancelled) {
            try {
              unlisten();
            } catch {
              /* listener already gone */
            }
          } else {
            cleanups.push(unlisten);
          }
        })
        .catch((err) => console.warn(`[BrowserTab] ${tag} listener failed:`, err));
    };

    register(
      onPickedElement((element) => {
        if (element.label !== nativeLabel) return;
        addSelectedElement(element);
      }),
      'picked-element',
    );

    register(
      onBrowserWindowClosed(({ label }) => {
        if (label !== nativeLabel) return;
        desiredModeRef.current = 'off';
        setNativeOpen(false);
        setInspectorMode('off');
      }),
      'window-closed',
    );

    return () => {
      cancelled = true;
      cleanups.forEach((fn) => {
        try {
          fn();
        } catch {
          /* listener already gone */
        }
      });
    };
  }, [addSelectedElement, nativeLabel]);

  // Close the native window when the tab unmounts
  useEffect(() => {
    return () => {
      closeBrowserWindow(nativeLabel).catch(() => {});
    };
  }, [nativeLabel]);

  // Iframe handlers
  const handleIframeLoad = () => {
    setIsLoading(false);
    setError(null);
  };
  const handleIframeError = () => {
    setIsLoading(false);
    setError('Failed to load page. Make sure the server is running.');
  };

  const secure = isSecure(currentUrl);
  const local = isLocalUrl(currentUrl);
  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < history.length - 1;

  const inspectorActive = inspectorMode === 'inspector';
  const stagewiseActive = inspectorMode === 'stagewise';

  return (
    <div className="flex-1 flex flex-col bg-editor overflow-hidden">
      {/* Browser Toolbar */}
      <div
        className="flex items-center gap-2 px-2 py-1.5 border-b flex-shrink-0"
        style={{
          backgroundColor: 'var(--aurora-title-bar-background)',
          borderColor: 'var(--aurora-common-border)',
        }}
      >
        <div className="flex items-center gap-0.5">
          <button
            onClick={goBack}
            disabled={!canGoBack}
            className="p-1.5 rounded-md transition-colors disabled:opacity-30 hover:bg-[var(--aurora-sidebar-item-hover)] disabled:hover:bg-transparent"
            style={{ color: 'var(--aurora-editor-foreground)' }}
            title="Back (Alt+Left)"
          >
            <ArrowLeft size={16} />
          </button>
          <button
            onClick={goForward}
            disabled={!canGoForward}
            className="p-1.5 rounded-md transition-colors disabled:opacity-30 hover:bg-[var(--aurora-sidebar-item-hover)] disabled:hover:bg-transparent"
            style={{ color: 'var(--aurora-editor-foreground)' }}
            title="Forward (Alt+Right)"
          >
            <ArrowRight size={16} />
          </button>
          <button
            onClick={refresh}
            disabled={!currentUrl}
            className="p-1.5 rounded-md transition-colors hover:bg-[var(--aurora-sidebar-item-hover)] disabled:opacity-30"
            style={{ color: 'var(--aurora-editor-foreground)' }}
            title="Refresh (F5)"
          >
            <RotateCw size={16} className={isLoading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={goHome}
            className="p-1.5 rounded-md transition-colors hover:bg-[var(--aurora-sidebar-item-hover)]"
            style={{ color: 'var(--aurora-editor-foreground)' }}
            title="Home (localhost:3000)"
          >
            <Home size={16} />
          </button>
        </div>

        <form onSubmit={handleUrlSubmit} className="flex-1 flex items-center relative">
          <div
            className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-colors"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--aurora-common-secondary) 82%, var(--aurora-common-muted) 18%)',
              borderColor: 'var(--aurora-common-border)',
            }}
          >
            {currentUrl ? (
              secure ? (
                local ? (
                  <span title="Local development server">
                    <Shield size={14} className="text-local flex-shrink-0" />
                  </span>
                ) : (
                  <span title="Secure connection">
                    <Lock size={14} className="text-secure flex-shrink-0" />
                  </span>
                )
              ) : (
                <span title="Not secure">
                  <Unlock size={14} className="text-insecure flex-shrink-0" />
                </span>
              )
            ) : (
              <Globe
                size={14}
                className="opacity-50 flex-shrink-0"
                style={{ color: 'var(--aurora-editor-foreground)' }}
              />
            )}

            <input
              ref={inputRef}
              type="text"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              placeholder="Enter URL or port (e.g., 3000, localhost:8080)"
              className="flex-1 bg-transparent outline-none text-sm"
              style={{ color: 'var(--aurora-editor-foreground)' }}
              onFocus={(e) => {
                e.target.select();
                setShowSuggestions(true);
              }}
              onBlur={() => {
                // Delay so click handlers on the dropdown rows fire
                // before the dropdown is torn down.
                window.setTimeout(() => setShowSuggestions(false), 150);
              }}
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

          {showSuggestions && (
            <UrlSuggestionsPanel
              query={inputUrl}
              recent={recentUrls}
              onPick={(url) => {
                setShowSuggestions(false);
                navigate(url);
              }}
            />
          )}
        </form>

        <div className="flex items-center gap-0.5">
          <button
            onClick={toggleInspector}
            disabled={!currentUrl}
            className="p-1.5 rounded-md transition-colors hover:bg-[var(--aurora-sidebar-item-hover)] disabled:opacity-30"
            style={{
              color: inspectorActive
                ? 'var(--aurora-common-primary)'
                : 'var(--aurora-editor-foreground)',
              backgroundColor: inspectorActive
                ? 'color-mix(in srgb, var(--aurora-common-primary) 18%, transparent)'
                : undefined,
            }}
            title={
              inspectorActive
                ? 'Inspector active — click to disable'
                : 'Inspect element (opens native window)'
            }
          >
            <MousePointer2 size={16} />
          </button>
          <button
            onClick={toggleStagewise}
            disabled={!currentUrl}
            className="p-1.5 rounded-md transition-colors hover:bg-[var(--aurora-sidebar-item-hover)] disabled:opacity-30"
            style={{
              color: stagewiseActive
                ? 'var(--aurora-common-primary)'
                : 'var(--aurora-editor-foreground)',
              backgroundColor: stagewiseActive
                ? 'color-mix(in srgb, var(--aurora-common-primary) 18%, transparent)'
                : undefined,
            }}
            title={
              stagewiseActive
                ? 'Stagewise toolbar active — click to disable'
                : 'Open Stagewise toolbar in native window'
            }
          >
            <SquarePen size={16} />
          </button>

          <div
            className="w-px h-4 mx-1"
            style={{ backgroundColor: 'var(--aurora-common-border)' }}
          />

          <button
            onClick={openExternal}
            disabled={!currentUrl}
            className="p-1.5 rounded-md transition-colors hover:bg-[var(--aurora-sidebar-item-hover)] disabled:opacity-30"
            style={{ color: 'var(--aurora-editor-foreground)' }}
            title="Open in OS default browser"
          >
            <ExternalLink size={16} />
          </button>
        </div>
      </div>

      {/* Browser Content */}
      <div className="flex-1 relative overflow-hidden">
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

        {nativeOpen ? (
          <NativeWindowPlaceholder
            url={currentUrl}
            mode={inspectorMode}
            onFocus={openNative}
            onClose={closeNative}
          />
        ) : currentUrl ? (
          <iframe
            ref={iframeRef}
            src={currentUrl}
            className="w-full h-full border-0"
            style={{ backgroundColor: 'white' }}
            onLoad={handleIframeLoad}
            onError={handleIframeError}
            // `allow-same-origin` was paired with `allow-scripts` here
            // before — Chrome warns that combination defeats the
            // sandbox because the framed page can rewrite its own
            // `sandbox` attribute. The preview path doesn't need
            // first-party access (inspection lives in the native
            // window), so drop it.
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
            allow="clipboard-read; clipboard-write"
            title="Browser Preview"
          />
        ) : (
          <EmptyState onNavigate={navigate} />
        )}

        {error && (
          <div
            className="absolute bottom-4 left-4 right-4 flex items-center gap-2 px-4 py-3 rounded-lg z-30"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--aurora-common-error) 10%, transparent)',
              border:
                '1px solid color-mix(in srgb, var(--aurora-common-error) 30%, transparent)',
              color: 'var(--aurora-common-error)',
            }}
          >
            <span className="text-sm flex-1">{error}</span>
            <button
              onClick={() => setError(null)}
              className="p-1 rounded hover:bg-input/50"
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>

      <style>{`
        @keyframes loading-slide {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  );
};

interface EmptyStateProps {
  onNavigate: (url: string) => void;
}

const EmptyState: React.FC<EmptyStateProps> = ({ onNavigate }) => (
  <div
    className="absolute inset-0 flex flex-col items-center justify-center"
    style={{ backgroundColor: 'var(--aurora-editor-background)' }}
  >
    <Globe
      size={64}
      className="mb-4 opacity-20"
      style={{ color: 'var(--aurora-editor-foreground)' }}
    />
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
        Click the pointer icon to open a native window with element inspection.
      </span>
    </p>
    <div className="flex gap-2 flex-wrap justify-center">
      {['http://localhost:3000', 'http://localhost:5173', 'http://localhost:8080'].map(
        (preset, i) => (
          <button
            key={preset}
            onClick={() => onNavigate(preset)}
            className={
              i === 0
                ? 'px-4 py-2 rounded-lg text-sm font-medium transition-colors hover:opacity-90'
                : 'px-4 py-2 rounded-lg text-sm font-medium border transition-colors hover:bg-[var(--aurora-sidebar-item-hover)]'
            }
            style={
              i === 0
                ? {
                    backgroundColor: 'var(--aurora-common-primary)',
                    color: 'var(--aurora-common-primary-foreground)',
                  }
                : {
                    borderColor: 'var(--aurora-common-border)',
                    color: 'var(--aurora-editor-foreground)',
                  }
            }
          >
            {preset.replace('http://', '')}
          </button>
        ),
      )}
    </div>
  </div>
);

interface UrlSuggestionsPanelProps {
  query: string;
  recent: ReturnType<typeof useBrowserHistoryStore.getState>['recent'];
  onPick: (url: string) => void;
}

const UrlSuggestionsPanel: React.FC<UrlSuggestionsPanelProps> = ({
  query,
  recent,
  onPick,
}) => {
  const trimmed = query.trim().toLowerCase();
  const filteredRecent = trimmed
    ? recent.filter((entry) => entry.url.toLowerCase().includes(trimmed))
    : recent;
  // When user has typed something that matches no presets and no
  // recents, hide the panel — letting them type freely without an
  // empty dropdown in the way.
  const presets = trimmed
    ? COMMON_DEV_PORTS.filter((port) => `${port}`.startsWith(trimmed))
    : [...COMMON_DEV_PORTS];

  if (presets.length === 0 && filteredRecent.length === 0) return null;

  return (
    <div
      className="absolute left-0 right-0 top-full mt-1 z-30 rounded-lg border overflow-hidden"
      style={{
        backgroundColor: 'var(--aurora-sidebar-background)',
        borderColor: 'var(--aurora-common-border)',
        boxShadow:
          '0 18px 40px color-mix(in srgb, var(--aurora-common-shadow) 30%, transparent)',
      }}
      onMouseDown={(e) => {
        // Stop the input from blurring before our row click fires.
        e.preventDefault();
      }}
    >
      {presets.length > 0 && (
        <div className="py-1.5">
          <div
            className="px-3 pb-1 text-[10px] uppercase tracking-wider font-semibold"
            style={{ color: 'var(--aurora-sidebar-foreground)' }}
          >
            Quick start
          </div>
          {presets.map((port) => {
            const url = buildLocalhostUrl(port);
            return (
              <button
                key={port}
                type="button"
                onClick={() => onPick(url)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--aurora-sidebar-item-hover)]"
                style={{ color: 'var(--aurora-editor-foreground)' }}
              >
                <Shield size={13} className="opacity-60 flex-shrink-0" />
                <span className="text-[12px] font-medium">localhost:{port}</span>
                <span
                  className="text-[10px] ml-auto opacity-60"
                  style={{ color: 'var(--aurora-sidebar-foreground)' }}
                >
                  {portHint(port)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {filteredRecent.length > 0 && (
        <div
          className="py-1.5 border-t"
          style={{ borderColor: 'var(--aurora-common-border)' }}
        >
          <div
            className="px-3 pb-1 text-[10px] uppercase tracking-wider font-semibold"
            style={{ color: 'var(--aurora-sidebar-foreground)' }}
          >
            Recent
          </div>
          {filteredRecent.slice(0, 8).map((entry) => (
            <button
              key={entry.url}
              type="button"
              onClick={() => onPick(entry.url)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--aurora-sidebar-item-hover)]"
              style={{ color: 'var(--aurora-editor-foreground)' }}
            >
              <Clock size={13} className="opacity-60 flex-shrink-0" />
              <span className="text-[12px] truncate">{entry.url}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const portHint = (port: number): string => {
  switch (port) {
    case 3000:
      return 'Next / CRA';
    case 5173:
      return 'Vite';
    case 8080:
      return 'webpack';
    case 4173:
      return 'Vite preview';
    case 4000:
      return 'Phoenix';
    case 8000:
      return 'Django';
    case 8888:
      return 'Jupyter';
    default:
      return '';
  }
};

interface NativeWindowPlaceholderProps {
  url: string;
  mode: InspectorMode;
  onFocus: () => Promise<void>;
  onClose: () => Promise<void>;
}

const NativeWindowPlaceholder: React.FC<NativeWindowPlaceholderProps> = ({
  url,
  mode,
  onFocus,
  onClose,
}) => {
  const modeLabel =
    mode === 'inspector'
      ? 'Inspector active — clicked elements stream to chat'
      : mode === 'stagewise'
        ? 'Stagewise toolbar active — pick element to attach'
        : 'Native preview window open';

  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center"
      style={{ backgroundColor: 'var(--aurora-editor-background)' }}
    >
      <MousePointer2
        size={56}
        className="mb-4 opacity-25"
        style={{ color: 'var(--aurora-editor-foreground)' }}
      />
      <h3
        className="text-base font-semibold mb-2"
        style={{ color: 'var(--aurora-editor-foreground)' }}
      >
        {modeLabel}
      </h3>
      <p
        className="text-xs mb-5 max-w-md opacity-80"
        style={{ color: 'var(--aurora-sidebar-foreground)' }}
      >
        {url}
      </p>
      <div className="flex gap-2">
        <button
          onClick={() => {
            void onFocus();
          }}
          className="px-3 py-1.5 rounded-md text-xs font-medium border transition-colors hover:bg-[var(--aurora-sidebar-item-hover)]"
          style={{
            borderColor: 'var(--aurora-common-border)',
            color: 'var(--aurora-editor-foreground)',
          }}
        >
          Focus window
        </button>
        <button
          onClick={() => {
            void onClose();
          }}
          className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors hover:opacity-90"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--aurora-common-error) 18%, transparent)',
            color: 'var(--aurora-common-error)',
          }}
        >
          Close native window
        </button>
      </div>
    </div>
  );
};
