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
import {
  getShellProfiles,
  type ShellProfile as ShellProfileEntry,
} from "@/apps/agent/services/workspace/shell-profiles";
import {
  disposeTerminalSession,
  terminalRuntime as runtime,
} from "@/apps/agent/services/terminal/terminal-sessions";
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
  // terminal read as frozen. `pty` is filled in below; the entry existing at
  // all is what makes a concurrent call take the re-attach path instead.
  runtime.set(session.id, { pty: undefined as unknown as IPty, term, fit });

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

  // Exit is wired FIRST, before the data pumps. A shell that dies on its own
  // command line dies in milliseconds — if this is registered after them, the
  // event can land before anyone is listening and the session just sits there
  // eating keystrokes with nothing on screen and no reason given. That is
  // exactly how a `cmd.exe` launched with PowerShell's `-Command` flag
  // presented: a black pane that swallowed everything typed into it.
  const startedAt = Date.now();
  pty.onExit(({ exitCode }) => {
    const instant = Date.now() - startedAt < 1500;
    try {
      if (instant) {
        // Dying this fast is a failure to LAUNCH, not a session that ended, so
        // it names what was run — the command line is the whole diagnosis.
        term.writeln(
          `\r\n\x1b[31m${session.profile} exited immediately (code ${exitCode}).\x1b[0m\r\n` +
            `\x1b[90m${cfg.exe} ${cfg.args.join(" ")}\x1b[0m\r\n` +
            `\x1b[90mThe shell could not start with these arguments. Check Settings → Tools → Shells.\x1b[0m`,
        );
      } else {
        term.writeln(`\r\n\x1b[33m[process exited: ${exitCode}]\x1b[0m`);
      }
    } catch { /* disposed */ }
    onExit();
  });

  pty.onData((d) => term.write(d));
  term.onData((d) => {
    pty.write(d);
    // Enter — remember where this command's output begins, so
    // `readTerminalSession(id, { scope: "last_command" })` can answer without
    // parsing prompts or injecting markers into the user's shell. Aurora owns
    // the PTY, so the keystroke IS the boundary.
    if (d.includes("\r")) {
      const entry = runtime.get(session.id);
      if (entry) {
        const buffer = term.buffer.active;
        entry.lastCommandLine = buffer.baseY + buffer.cursorY;
      }
    }
  });
  term.onResize(({ cols: c, rows: r }) => {
    try { pty.resize(c, r); } catch { /* exited */ }
  });

  runtime.set(session.id, { pty, term, fit });
}

const TerminalView: React.FC<{ session: TermSession }> = ({ session }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const appearance = useAgentThemeStore((s) => selectActiveAgentTheme(s).appearance);
  const setRunning = useAgentTerminalStore((s) => s.setRunning);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isAuroraRuntimeAvailable()) return;
    let cancelled = false;
    attachSession(session, container, () => {
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
  const closeOne = (id: string) => {
    disposeTerminalSession(id);
    removeSession(id);
  };

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
    </div>
  );
};
