/**
 * Agent Window — Terminal tab [view].
 *
 * A robust, native multi-session PTY terminal built standalone for the agent
 * window. It drives `tauri-plugin-pty` (granted to `agent-window`) through the
 * `tauri-pty` JS API and renders with xterm.js. Sessions keep running in a
 * module map across tab switches — switching away detaches the xterm element
 * (the shell stays alive); switching back re-attaches it with full scrollback.
 *
 * Reuses the IDE's shell prompt/spawn logic (copied into `shell-config.ts`) but
 * none of the IDE's terminal UI. Themed with `--agw-*` (+ a tuned ANSI palette).
 */

import React, { useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { spawn, type IPty } from "tauri-pty";
import "@xterm/xterm/css/xterm.css";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { isAuroraRuntimeAvailable } from "@/kernel/lib/ipc/runtime";
// No `platform()` import: which executable to run is the registry's answer, and
// it already accounts for the platform. Branching on it here is what led to a
// hardcoded Windows Git path in the first place.
import { getShellSpawnConfig, type ShellProfile } from "@/apps/agent/adapters/shell-config";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentTerminalStore, type TermSession } from "@/apps/agent/store/ui/useAgentTerminalStore";
import { selectActiveAgentTheme, useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";

interface PtyRuntime {
  pty: IPty;
  term: Terminal;
  fit: FitAddon;
}

/** Live PTY + xterm per session id — persists across tab/session switches. */
const runtime = new Map<string, PtyRuntime>();

function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const root = (document.querySelector(".agw-root") as HTMLElement | null) ?? document.documentElement;
  const v = getComputedStyle(root).getPropertyValue(name).trim();
  return v || fallback;
}

function xtermTheme(dark: boolean): ITheme {
  const ansi = dark
    ? {
        black: "#3b3b3b", red: "#ff6b6b", green: "#6bd968", yellow: "#e6c07b",
        blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#56cfe1", white: "#d6d6d6",
        brightBlack: "#6b6b6b", brightRed: "#ff8a8a", brightGreen: "#8be889",
        brightYellow: "#f2d59a", brightBlue: "#9bb8ff", brightMagenta: "#d0b8ff",
        brightCyan: "#7fe0ee", brightWhite: "#ffffff",
      }
    : {
        black: "#1a1a1a", red: "#c8341f", green: "#1f8a35", yellow: "#9a6b00",
        blue: "#2257d6", magenta: "#8a2be2", cyan: "#0a8aa0", white: "#3b3b3b",
        brightBlack: "#5a5a5a", brightRed: "#e0432c", brightGreen: "#2aa148",
        brightYellow: "#b98300", brightBlue: "#3a6fe0", brightMagenta: "#9d44ee",
        brightCyan: "#12a0ba", brightWhite: "#111111",
      };
  return {
    background: cssVar("--agw-conversation", dark ? "#0e0e10" : "#ffffff"),
    foreground: cssVar("--agw-text", dark ? "#e6e6e6" : "#1a1a1a"),
    cursor: cssVar("--agw-accent", dark ? "#7aa2f7" : "#2257d6"),
    cursorAccent: cssVar("--agw-conversation", dark ? "#0e0e10" : "#ffffff"),
    selectionBackground: dark ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.12)",
    ...ansi,
  };
}

async function attachSession(session: TermSession, container: HTMLDivElement, onExit: () => void) {
  const existing = runtime.get(session.id);
  if (existing) {
    const el = existing.term.element;
    if (el && el.parentElement !== container) container.appendChild(el);
    else if (!el) existing.term.open(container);
    requestAnimationFrame(() => {
      try { existing.fit.fit(); } catch { /* container not laid out yet */ }
    });
    return;
  }

  const dark = selectActiveAgentTheme(useAgentThemeStore.getState()).appearance !== "light";
  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: "bar",
    fontSize: 12,
    fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "JetBrains Mono", monospace',
    lineHeight: 1.25,
    convertEol: true,
    scrollback: 10000,
    allowProposedApi: true,
    theme: xtermTheme(dark),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(container);
  try { fit.fit(); } catch { /* ignore */ }

  const cols = term.cols || 80;
  const rows = term.rows || 24;
  // A session opened AT a folder (Files panel / project menu) starts there;
  // one opened from the tab bar starts at the chat's project root.
  const cwd = session.cwd ?? useAgentChatStore.getState().projectRoot ?? undefined;

  // Resolved by Rust from the verified shell registry — not a path guessed
  // here. A machine with no registered shell says so and points at the place
  // that fixes it, instead of failing on a hardcoded path the user never chose.
  const cfg = await getShellSpawnConfig(session.profile);
  if (!cfg) {
    term.writeln(
      `\r\n\x1b[31mNo ${session.profile} shell is set up.\x1b[0m\r\n` +
        `Open Settings → Tools → Shells to scan for one, or add it by path.`,
    );
    runtime.set(session.id, { pty: undefined as unknown as IPty, term, fit });
    onExit();
    return;
  }

  let pty: IPty;
  try {
    pty = spawn(cfg.exe, cfg.args, { cols, rows, cwd, env: cfg.env });
  } catch (err) {
    // No second guess: the registry verified this executable by running it, so
    // a failure here is worth reporting rather than papering over with another
    // hardcoded candidate.
    term.writeln(`\r\n\x1b[31mCouldn't start ${cfg.exe}: ${String(err)}\x1b[0m`);
    runtime.set(session.id, { pty: undefined as unknown as IPty, term, fit });
    onExit();
    return;
  }

  pty.onData((d) => term.write(d));
  term.onData((d) => pty.write(d));
  term.onResize(({ cols: c, rows: r }) => {
    try { pty.resize(c, r); } catch { /* exited */ }
  });
  pty.onExit(({ exitCode }) => {
    try { term.writeln(`\r\n\x1b[33m[process exited: ${exitCode}]\x1b[0m`); } catch { /* disposed */ }
    onExit();
  });

  runtime.set(session.id, { pty, term, fit });
}

/** Kill a session's shell + xterm and drop it from the runtime map. */
// eslint-disable-next-line react-refresh/only-export-components -- co-located PTY lifecycle helper
export function disposeTerminalSession(id: string): void {
  const rt = runtime.get(id);
  if (!rt) return;
  try { rt.pty?.kill(); } catch { /* already dead */ }
  try { rt.term.dispose(); } catch { /* already disposed */ }
  runtime.delete(id);
}

// Reap every live shell when the window unloads.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    for (const id of Array.from(runtime.keys())) disposeTerminalSession(id);
  });
}

const TerminalView: React.FC<{ session: TermSession }> = ({ session }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const appearance = useAgentThemeStore((s) => selectActiveAgentTheme(s).appearance);
  const setRunning = useAgentTerminalStore((s) => s.setRunning);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isAuroraRuntimeAvailable()) return;
    let cancelled = false;
    void attachSession(session, container, () => {
      if (!cancelled) setRunning(session.id, false);
    });

    const ro = new ResizeObserver(() => {
      const rt = runtime.get(session.id);
      if (rt) try { rt.fit.fit(); } catch { /* hidden */ }
    });
    ro.observe(container);
    const settle = window.setTimeout(() => {
      const rt = runtime.get(session.id);
      if (rt) try { rt.fit.fit(); rt.term.focus(); } catch { /* hidden */ }
    }, 30);

    return () => {
      cancelled = true;
      ro.disconnect();
      window.clearTimeout(settle);
      // Keep the PTY alive; just detach. Re-mount re-attaches the element.
    };
  }, [session.id, setRunning]);

  // Recolor a live terminal when the theme flips.
  useEffect(() => {
    const rt = runtime.get(session.id);
    if (rt) rt.term.options.theme = xtermTheme(appearance !== "light");
  }, [appearance, session.id]);

  return (
    <div
      ref={containerRef}
      className="agw-term-surface"
      onMouseDown={() => runtime.get(session.id)?.term.focus()}
    />
  );
};

const NewTermMenu: React.FC<{ onPick: (p: ShellProfile) => void }> = ({ onPick }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
        className="agw-icon-btn"
        title="New terminal"
        aria-label="New terminal"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <AgentIcon name="plus" size={15} />
      </button>
      {open && (
        <div className="agw-addmenu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="agw-addmenu-item"
            onClick={() => { onPick("powershell"); setOpen(false); }}
          >
            <AgentIcon name="terminal" size={14} />
            <span className="agw-addmenu-label">PowerShell</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="agw-addmenu-item"
            onClick={() => { onPick("bash"); setOpen(false); }}
          >
            <AgentIcon name="terminal" size={14} />
            <span className="agw-addmenu-label">bash</span>
          </button>
        </div>
      )}
    </div>
  );
};

export const TerminalPanel: React.FC = () => {
  const sessions = useAgentTerminalStore((s) => s.sessions);
  const activeId = useAgentTerminalStore((s) => s.activeId);
  const createSession = useAgentTerminalStore((s) => s.createSession);
  const removeSession = useAgentTerminalStore((s) => s.removeSession);
  const setActive = useAgentTerminalStore((s) => s.setActive);

  // Open one shell automatically the first time the tab is shown.
  useEffect(() => {
    if (sessions.length === 0) createSession("powershell");
  }, [sessions.length, createSession]);

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0] ?? null;
  const closeOne = (id: string) => {
    disposeTerminalSession(id);
    removeSession(id);
  };

  return (
    <div className="agw-term-root">
      <div className="agw-term-bar">
        <div className="agw-term-sessions agw-scroll">
          {sessions.map((s) => (
            <div key={s.id} className="agw-term-pill" data-active={s.id === active?.id || undefined}>
              <button
                type="button"
                className="agw-term-pill-main"
                onClick={() => setActive(s.id)}
                title={s.title}
              >
                <span className="agw-term-dot" data-dead={!s.running || undefined} />
                <span className="agw-term-pill-label">{s.title}</span>
              </button>
              <button
                type="button"
                className="agw-term-pill-close"
                onClick={(e) => { e.stopPropagation(); closeOne(s.id); }}
                title="Close terminal"
                aria-label={`Close ${s.title}`}
              >
                <AgentIcon name="close" size={11} />
              </button>
            </div>
          ))}
        </div>
        <NewTermMenu onPick={(p) => createSession(p)} />
      </div>
      {active ? (
        <TerminalView key={active.id} session={active} />
      ) : (
        <div className="agw-files-empty">
          <AgentIcon name="terminal" size={22} style={{ color: "var(--agw-text-subtle)" }} />
          <div style={{ fontSize: "var(--agw-fs-ui)", color: "var(--agw-text-muted)", fontWeight: "var(--agw-fw-medium)" }}>No terminal open</div>
        </div>
      )}
    </div>
  );
};
