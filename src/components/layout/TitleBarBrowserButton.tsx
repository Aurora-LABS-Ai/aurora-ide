import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Globe, Layers, Plus } from 'lucide-react';

import { useBrowserWindowsStore } from '../../store/useBrowserWindowsStore';
import { useEditorStore } from '../../store/useEditorStore';
import { AppIcon } from '../ui/AppIcon';

/**
 * Globe button in the TitleBar.
 *
 *  - Zero live windows  → behaves like the legacy button: click opens
 *    a fresh BrowserTab with `about:blank`.
 *  - One or more live windows → click opens a popover listing every
 *    adoptable window (label + URL + active-pickers indicator). One
 *    click adopts the window into a new BrowserTab. A "New tab"
 *    action at the bottom keeps the legacy behavior reachable.
 *
 * The store self-hydrates on first read; we just nudge a refresh on
 * popover open so a stale list never blocks adoption.
 */

interface TitleBarBrowserButtonProps {
  chromeButtonStyle: React.CSSProperties;
}

export const TitleBarBrowserButton: React.FC<TitleBarBrowserButtonProps> = ({
  chromeButtonStyle,
}) => {
  const windows = useBrowserWindowsStore((s) => s.windows);
  const hydrate = useBrowserWindowsStore((s) => s.hydrate);
  const refresh = useBrowserWindowsStore((s) => s.refresh);
  const openBrowserTab = useEditorStore((s) => s.openBrowserTab);
  const tabs = useEditorStore((s) => s.tabs);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleClick = () => {
    if (windows.length === 0) {
      // Legacy fast-path: nothing to adopt, just spawn a new tab.
      openBrowserTab();
      return;
    }
    void refresh();
    setOpen((v) => !v);
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={handleClick}
        className="flex h-7 items-center gap-1 rounded-[6px] px-1.5 text-text-secondary transition-colors hover:text-text-primary hover:bg-input/50"
        style={chromeButtonStyle}
        title={
          windows.length === 0
            ? 'Open Browser preview'
            : `Open Browser (${windows.length} live window${windows.length === 1 ? '' : 's'})`
        }
      >
        <AppIcon icon={Globe} size={14} />
        {windows.length > 0 && (
          <>
            <span
              className="inline-flex h-4 min-w-[14px] items-center justify-center rounded-full px-1 text-[9px] font-semibold"
              style={{
                color: 'var(--aurora-common-primary-foreground)',
                backgroundColor: 'var(--aurora-common-primary)',
              }}
            >
              {windows.length}
            </span>
            <ChevronDown size={10} />
          </>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-[60] w-[340px] overflow-hidden rounded-md shadow-lg"
          style={{
            backgroundColor: 'var(--aurora-sidebar-background)',
            border: '1px solid var(--aurora-common-border)',
          }}
        >
          <div
            className="px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em]"
            style={{
              color: 'var(--aurora-editor-foreground-muted, var(--aurora-text-disabled))',
              borderBottom: '1px solid var(--aurora-common-border)',
            }}
          >
            Adopt existing window
          </div>
          <div className="max-h-[320px] overflow-y-auto py-1">
            {windows.map((w) => {
              // If a tab is already adopting this window, the action
              // should focus that tab rather than opening a duplicate.
              const existing = tabs.find(
                (t) => t.type === 'browser' && t.adoptedBrowserLabel === w.label,
              );
              return (
                <button
                  key={w.label}
                  onClick={() => {
                    setOpen(false);
                    if (existing) {
                      setActiveTab(existing.id);
                      return;
                    }
                    openBrowserTab(w.url, { adoptedLabel: w.label });
                  }}
                  className="w-full text-left px-3 py-2 transition-colors hover:bg-[var(--aurora-sidebar-item-hover)]"
                  style={{ color: 'var(--aurora-editor-foreground)' }}
                >
                  <div className="flex items-center gap-2">
                    <Layers size={12} style={{ opacity: 0.7 }} />
                    <span
                      className="text-[11.5px] font-mono truncate"
                      style={{ color: 'var(--aurora-editor-foreground)' }}
                    >
                      {w.label}
                    </span>
                    {w.stagewiseActive && (
                      <span
                        className="text-[9px] px-1 py-0.5 rounded uppercase tracking-wider"
                        style={{
                          color: 'var(--aurora-common-primary)',
                          backgroundColor:
                            'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)',
                        }}
                      >
                        Stage
                      </span>
                    )}
                    {w.inspectorActive && (
                      <span
                        className="text-[9px] px-1 py-0.5 rounded uppercase tracking-wider"
                        style={{
                          color: 'var(--aurora-common-primary)',
                          backgroundColor:
                            'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)',
                        }}
                      >
                        Pick
                      </span>
                    )}
                    {existing && (
                      <span
                        className="text-[9px] uppercase tracking-wider"
                        style={{ color: 'var(--aurora-editor-foreground)', opacity: 0.6 }}
                      >
                        in tab
                      </span>
                    )}
                  </div>
                  <div
                    className="text-[10.5px] truncate mt-0.5 ml-[18px]"
                    style={{ color: 'var(--aurora-editor-foreground)', opacity: 0.7 }}
                  >
                    {w.url || '(blank)'}
                  </div>
                </button>
              );
            })}
          </div>
          <button
            onClick={() => {
              setOpen(false);
              openBrowserTab();
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-[11.5px] transition-colors hover:bg-[var(--aurora-sidebar-item-hover)]"
            style={{
              color: 'var(--aurora-common-primary)',
              borderTop: '1px solid var(--aurora-common-border)',
            }}
          >
            <Plus size={12} />
            <span className="font-medium">Open new browser tab</span>
          </button>
        </div>
      )}
    </div>
  );
};
