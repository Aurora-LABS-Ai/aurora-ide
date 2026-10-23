/**
 * Agent Window — Terminal tab [view].
 *
 * A native multi-session terminal for the agent window. Rust owns the shells
 * (`commands::terminal_pty`: which shell, its prompt, the job holding what it
 * runs, closing it); this view draws with xterm.js and carries keystrokes.
 * Sessions keep running in a module map across tab switches — switching away
 * detaches the xterm element (the shell stays alive); switching back
 * re-attaches it with full scrollback. Themed with `--agw-*` (+ a tuned ANSI
 * palette).
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { AgentConfirm } from "@/apps/agent/components/modals/AgentConfirm";
import { isAuroraRuntimeAvailable } from "@/kernel/lib/ipc/runtime";
import type { ShellProfile } from "@/apps/agent/adapters/shell-config";
import {
  getShellProfiles,
  type ShellProfile as ShellProfileEntry,
} from "@/apps/agent/services/workspace/shell-profiles";
import {
  disposeTerminalSession,
  terminalRuntime as runtime,
  type PtyRuntime,
  type RunningChild,
} from "@/apps/agent/services/terminal/terminal-sessions";
import {
  attachPty,
  killPty,
  openPty,
  resizePty,
  runningInPty,
  writePty,
} from "@/apps/agent/services/terminal/terminal-pty";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentTerminalStore, type TermSession } from "@/apps/agent/store/ui/useAgentTerminalStore";
import { selectActiveAgentTheme, useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";

function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const root = (document.querySelector(".agw-root") as HTMLElement | null) ?? document.documentElement;
  const v = getComputedStyle(root).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Families that carry the Nerd Font symbol block, tried in order after the
 * user's own code font.
 *
 * `Symbols Nerd Font Mono` is last and is the one that matters most: it is the
 * symbols-only face people install precisely so their regular font keeps
 * rendering the text. The rest are the patched monospace faces that ship with
 * a Nerd Font install and are common on Windows.
 */
const NERD_FONT_FALLBACKS = [
  "CaskaydiaCove Nerd Font Mono",
  "CaskaydiaCove NF",
  "JetBrainsMono Nerd Font Mono",
  "JetBrainsMono NF",
  "MesloLGS NF",
  "FiraCode Nerd Font Mono",
  "Hack Nerd Font Mono",
  "Symbols Nerd Font Mono",
] as const;

/** Append the Nerd Font families to a font stack, skipping any already named. */
function withNerdFontFallbacks(stack: string | undefined): string {
  // A theme snapshot can reach here without a code font — a custom theme, or
  // typography overrides pruned by the persist migration. Passing `undefined`
  // to xterm was harmless before this function existed; throwing on it inside
  // the Terminal constructor is not, because that kills the whole attach and
  // renders as an empty pane.
  const base = stack?.trim();
  const present = new Set(
    (base ?? "")
      .split(",")
      .map((family) => family.trim().replace(/^["']|["']$/g, "").toLowerCase())
      .filter(Boolean),
  );
  const extra = NERD_FONT_FALLBACKS.filter((family) => !present.has(family.toLowerCase())).map(
    (family) => `"${family}"`,
  );
  return [...(base ? [base] : []), ...extra, "monospace"].join(", ");
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

/**
 * Remove any xterm DOM tree in `container` that is not `keep`.
 *
 * Heals a container that already has two terminals stacked in it — which is
 * what the reservation below now prevents, but a session created before that
 * fix (or by any future path that races) would otherwise stay broken until the
 * window reloads.
 */
function dropStrayTerminals(container: HTMLDivElement, keep: HTMLElement | undefined): void {
  for (const child of Array.from(container.children)) {
    if (child !== keep && child.classList.contains("xterm")) child.remove();
  }
}

async function attachSession(session: TermSession, container: HTMLDivElement, onExit: () => void) {
  const existing = runtime.get(session.id);
  if (existing) {
    const el = existing.term.element;
    if (el && el.parentElement !== container) container.appendChild(el);
    else if (!el) existing.term.open(container);
    dropStrayTerminals(container, existing.term.element ?? undefined);
    requestAnimationFrame(() => {
      try { existing.fit.fit(); } catch { /* container not laid out yet */ }
    });
    return;
  }

  const activeTheme = selectActiveAgentTheme(useAgentThemeStore.getState());
  const dark = activeTheme.appearance !== "light";
  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: "bar",
    fontSize: 12,
    // The user's Code font (Appearance → Typography), same token every code
    // surface reads — xterm needs the resolved string, not the CSS variable —
    // followed by Nerd Font fallbacks.
    //
    // A real shell prompt is not just text. Prompt themes (oh-my-posh,
    // starship, powerlevel10k) draw with Private Use Area glyphs: powerline
    // separators, a git branch mark, language icons. None of the bundled code
    // faces carry that block, so every one of them rendered as a tofu box and
    // the prompt looked corrupted. Browsers fall back PER GLYPH, so naming the
    // common Nerd Font families after the user's choice keeps their font for
    // the text and borrows only the symbols — from whichever of these they
    // actually have installed.
    fontFamily: withNerdFontFallbacks(activeTheme.tokens.fontCode),
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
  dropStrayTerminals(container, term.element ?? undefined);
  try { fit.fit(); } catch { /* ignore */ }

  // CLAIM THE SLOT NOW — synchronously, before the first `await` below.
  //
  // This function is `async` and the only guard against building a second
  // terminal for a session is `runtime.get(session.id)` at the top. That map
  // used to be written at the very END, after awaiting the shell registry, so
  // any second call arriving during that await saw an empty slot and built a
  // whole second xterm into the SAME container. React 18 mounts effects twice
  // in development, which is exactly such a second call.
  //
  // The result was two stacked terminals — `xterm-dom-renderer-owner-5` and
  // `-6` inside one `.agw-term-surface` — with two cursors (one at the top,
  // one at the bottom of the pane) and the keyboard wired to whichever
  // instance held the live PTY, so typing landed in the invisible one and the
  // terminal read as frozen. `ptyId` is filled in below; the entry existing at
  // all is what makes a concurrent call take the re-attach path instead.
  const slot: PtyRuntime = { term, fit };
  runtime.set(session.id, slot);
  // The session was closed while we were waiting (the shell starts async).
  // `disposeTerminalSession` removes the slot, so "is our slot still there" is
  // the test.
  const closedMeanwhile = () => runtime.get(session.id) !== slot;

  // A session opened AT a folder (Files panel / project menu) starts there;
  // one opened from the tab bar starts at the chat's project root.
  const cwd = session.cwd ?? useAgentChatStore.getState().projectRoot ?? undefined;

  // Keystrokes are wired BEFORE the shell starts, and queued until it has an
  // id. ConPTY asks the terminal where the cursor is (`ESC[6n`) while the shell
  // is starting and holds the shell until xterm answers through this handler;
  // an answer sent before anyone listens is lost and the tab hangs blank.
  const queued: string[] = [];
  const send = (id: number, data: string) => {
    void writePty(id, data).catch((error) => console.error("[agent-terminal] write failed:", error));
  };
  term.onData((d) => {
    if (slot.ptyId === undefined) queued.push(d);
    else send(slot.ptyId, d);
  });
  const onData = (data: string) => {
    try { term.write(data); } catch { /* disposed */ }
  };
  const resizeTo = (id: number) =>
    term.onResize(({ cols: c, rows: r }) => {
      void resizePty(id, c, r).catch(() => { /* exited */ });
    });

  // An agent's terminal already runs in Rust: show what it printed so far,
  // then live output. Its own exit line ("[process exited: n]") is part of
  // that, so nothing is added here.
  if (session.ptyId !== undefined) {
    const ptyId = session.ptyId;
    slot.ptyId = ptyId;
    try {
      await attachPty(ptyId, onData, () => onExit());
    } catch (error) {
      if (closedMeanwhile()) return;
      term.writeln(`\r\n\x1b[31m${String(error)}\x1b[0m`);
      onExit();
      return;
    }
    for (const data of queued.splice(0)) send(ptyId, data);
    void resizePty(ptyId, term.cols || 80, term.rows || 24).catch(() => { /* exited */ });
    resizeTo(ptyId);
    return;
  }

  // Rust resolves the shell from the verified registry, starts it and holds
  // everything it runs in a job; this view only draws and types. A machine with
  // no usable shell gets Rust's sentence naming the place that fixes it.
  const startedAt = Date.now();
  let exe = session.profile as string;
  let opened;
  try {
    opened = await openPty({
      profile: session.profile,
      cwd,
      title: session.title,
      cols: term.cols || 80,
      rows: term.rows || 24,
      onData,
      onExit: (exitCode) => {
        try {
          if (Date.now() - startedAt < 1500) {
            // Dying this fast is a failure to LAUNCH, not a session that
            // ended, so it names what was run.
            term.writeln(
              `\r\n\x1b[31m${session.profile} exited immediately (code ${exitCode}).\x1b[0m\r\n` +
                `\x1b[90m${exe}\x1b[0m\r\n` +
                `\x1b[90mThe shell could not start. Check Settings → Tools → Shells.\x1b[0m`,
            );
          } else {
            term.writeln(`\r\n\x1b[33m[process exited: ${exitCode}]\x1b[0m`);
          }
        } catch { /* disposed */ }
        onExit();
      },
    });
  } catch (error) {
    if (closedMeanwhile()) return;
    term.writeln(`\r\n\x1b[31m${String(error)}\x1b[0m`);
    onExit();
    return;
  }
  exe = opened.exe;
  if (closedMeanwhile()) {
    // Closed while it started: end it now rather than leave a shell with no tab.
    void killPty(opened.id).catch((error) => {
      console.error(`[agent-terminal] could not stop terminal ${opened.id}:`, error);
    });
    return;
  }
  slot.ptyId = opened.id;
  for (const data of queued.splice(0)) send(opened.id, data);
  resizeTo(opened.id);
}

const TerminalView: React.FC<{ session: TermSession }> = ({ session }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const appearance = useAgentThemeStore((s) => selectActiveAgentTheme(s).appearance);
  const setRunning = useAgentTerminalStore((s) => s.setRunning);
  // The session as it stands, for the attach below. The attach runs once per
  // session id: a rename hands this view a new session object, and attaching
  // again for it would rebuild a live terminal. Declared first, so it is
  // current when the attach effect runs in the same commit.
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isAuroraRuntimeAvailable()) return;
    let cancelled = false;
    attachSession(sessionRef.current, container, () => {
      if (!cancelled) setRunning(session.id, false);
    }).catch((error: unknown) => {
      // Never let this fail silently. `attachSession` builds the xterm, asks
      // the registry for a shell and spawns it; a throw anywhere in there used
      // to reject into `void` and leave a blank black pane with no cursor, no
      // prompt and no reason — indistinguishable from a shell that started and
      // printed nothing. Same rule as the tool cards: a failure that renders as
      // "nothing happened" is worse than no feature.
      console.error("[terminal] failed to attach session:", error);
      if (cancelled) return;
      setRunning(session.id, false);
      const message = error instanceof Error ? error.message : String(error);
      container.textContent = "";
      const note = document.createElement("div");
      note.className = "agw-term-fail";
      note.textContent = `This terminal could not start: ${message}`;
      container.appendChild(note);
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
  const [shells, setShells] = useState<ShellProfileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Read when the menu OPENS, not on mount and not in an effect: the registry
  // is on disk and can change while the window is up (a scan, a manual add), so
  // a list captured at startup goes stale — and `react-hooks/set-state-in-effect`
  // rejects loading it from an effect anyway. Opening is an event; this belongs
  // in the handler for it.
  const openMenu = () => {
    setOpen(true);
    setLoading(true);
    void getShellProfiles()
      .then((registry) =>
        setShells(registry.profiles.filter((p) => p.enabled && p.health.state !== "failed")),
      )
      .catch(() => setShells([]))
      .finally(() => setLoading(false));
  };

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
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <AgentIcon name="plus" size={15} />
      </button>
      {open && (
        <div className="agw-addmenu" role="menu">
          {/* Every shell the registry actually found, not two hardcoded names.
              Settings → Tools › Shells already scans for these and knows their
              real paths and versions; the picker offering a fixed pair was the
              only reason an installed PowerShell 7 could not be opened here. */}
          {shells.length === 0 ? (
            <div className="agw-addmenu-empty">
              {loading ? "Looking for shells…" : "No shells found — scan in Settings → Tools."}
            </div>
          ) : (
            shells.map((shell) => (
              <button
                key={shell.id}
                type="button"
                role="menuitem"
                className="agw-addmenu-item"
                title={shell.exe || shell.path}
                onClick={() => { onPick(shell.kind); setOpen(false); }}
              >
                <AgentIcon name="terminal" size={14} />
                <span className="agw-addmenu-label">{shell.label}</span>
                {shell.version && <span className="agw-addmenu-meta">{shell.version}</span>}
              </button>
            ))
          )}
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

  // Open one shell the FIRST time the tab is shown, and only then.
  //
  // This used to key on `sessions.length`, so closing the last terminal
  // immediately spawned a replacement — the empty state below was unreachable
  // and "close" did not close. Reopening the Terminal tab with sessions still
  // running must not add one either, which is why the check reads the store
  // rather than depending on the rendered list.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current) return;
    autoOpened.current = true;
    if (useAgentTerminalStore.getState().sessions.length === 0) createSession();
  }, [createSession]);

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0] ?? null;
  const stripRef = useRef<HTMLDivElement>(null);

  /**
   * Closing a tab ends its shell AND everything that shell started.
   *
   * Both halves of that were missing. The kill stopped at the shell, so a dev
   * server or an Electron app launched from the tab kept running with no
   * window left to stop it from; and nothing asked first, so the work was gone
   * before the user knew it was at risk.
   *
   * The check runs before anything is destroyed. A confirmation that appears
   * after the fact is not a confirmation, and one that appears on every close
   * — including the ordinary idle shell — is one people learn to click
   * through, which costs it the only job it has.
   */
  const [pendingClose, setPendingClose] = useState<{
    id: string;
    title: string;
    children: RunningChild[];
  } | null>(null);

  const closeNow = useCallback(
    (id: string) => {
      const session = useAgentTerminalStore.getState().sessions.find((s) => s.id === id);
      disposeTerminalSession(id, session?.ptyId);
      removeSession(id);
    },
    [removeSession],
  );

  const closeOne = useCallback(
    (id: string) => {
      const session = useAgentTerminalStore.getState().sessions.find((s) => s.id === id);
      const ptyId = runtime.get(id)?.ptyId ?? session?.ptyId;
      if (!session || ptyId === undefined) {
        closeNow(id);
        return;
      }
      // Asked by job membership in Rust: everything the shell started, however
      // it was started. The old check walked from a "pid" that was a session
      // counter, found nothing, and closed without warning.
      void runningInPty(ptyId)
        .then((children) => {
          if (!children || children.length === 0) {
            closeNow(id);
            return;
          }
          setPendingClose({ id, title: session.title, children });
        })
        .catch((error) => {
          // Never block the close on a failed scan — the button must work
          // even when we cannot say what it will stop. Logged, not swallowed.
          console.error("[agent-terminal] could not check for running processes:", error);
          closeNow(id);
        });
    },
    [closeNow],
  );

  /**
   * A vertical wheel over the tab strip scrolls it sideways.
   *
   * Bound natively with `{ passive: false }`, not via React's `onWheel`: React
   * registers `wheel` at the root as PASSIVE, so `preventDefault()` there is a
   * silent no-op (see .knowledge/lesson.md, 2026-07-25). `preventDefault` is
   * only called when the strip can actually take the scroll, so at either end
   * the gesture still passes through instead of dying under the pointer.
   */
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return; // zoom, not scroll
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (delta === 0) return;
      const max = strip.scrollWidth - strip.clientWidth;
      if (max <= 0) return;
      const next = Math.min(max, Math.max(0, strip.scrollLeft + delta));
      if (next === strip.scrollLeft) return;
      event.preventDefault();
      strip.scrollLeft = next;
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the selected terminal in view — switching with the keyboard or opening
  // a new one past the edge must not leave the active pill off screen.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !active) return;
    strip
      .querySelector<HTMLElement>('[data-active] .agw-term-pill-main')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  return (
    <div className="agw-term-root">
      <div className="agw-term-bar">
        <div className="agw-term-sessions agw-scroll" ref={stripRef}>
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
        /* Closing the last session lands here rather than silently spawning a
           replacement. Same anatomy as the Canvas empty state — icon, what is
           true, what to do about it — and one action, because an empty state
           that only states a fact makes the reader go hunting for the control. */
        <div className="agw-term-empty">
          <AgentIcon name="terminal" size={24} />
          <strong>No terminal open</strong>
          <span>
            Terminals start in this chat&apos;s project folder and keep running while you
            work elsewhere in the window.
          </span>
          <button
            type="button"
            className="agw-term-empty-cta"
            onClick={() => createSession()}
          >
            <AgentIcon name="plus" size={13} />
            New terminal
          </button>
        </div>
      )}

      {/* Names what will be stopped, because "processes are running" tells the
        * reader nothing they can decide on — whether to close depends entirely
        * on WHICH process it is. Listed by executable name, longest-running
        * branch first, capped so a shell with fifty children does not push the
        * buttons off screen. */}
      <AgentConfirm
        open={pendingClose !== null}
        title="Stop what this terminal is running?"
        message={
          pendingClose
            ? `Closing ${pendingClose.title} will also stop ${describeChildren(pendingClose.children)}.`
            : ""
        }
        confirmLabel="Close and stop"
        cancelLabel="Keep open"
        destructive
        onConfirm={() => {
          if (pendingClose) closeNow(pendingClose.id);
          setPendingClose(null);
        }}
        onCancel={() => setPendingClose(null)}
      />
    </div>
  );
};

/** How many processes, and which — the two facts the decision needs. */
const MAX_NAMED_CHILDREN = 4;

function describeChildren(children: RunningChild[]): string {
  // Deduplicated: `node.exe` five times over reads as noise, and the count
  // above it already carries "there are several".
  const names = Array.from(new Set(children.map((c) => c.name))).filter(Boolean);
  if (names.length === 0) {
    return `${children.length} running ${children.length === 1 ? "process" : "processes"}`;
  }
  const shown = names.slice(0, MAX_NAMED_CHILDREN).join(", ");
  const rest = names.length - MAX_NAMED_CHILDREN;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}
