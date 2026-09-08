/**
 * Agent Window — live shell output [tool running].
 *
 * The terminal view of a command that is still executing. Shares the prompt
 * row, ANSI colouring, and monospace body with `ShellOutputView` so a command
 * does not visually re-flow when it settles — the same output simply stops
 * moving and gains its exit status.
 *
 * The view follows the newest line, the way a terminal does, but only while
 * the user is already at the bottom: scrolling up to read an earlier error
 * must not be yanked away by the next chunk.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { hasAnsi, parseAnsi, type AnsiSpan } from "@/apps/agent/components/tool-views/ansi";
import { shellMeta } from "@/apps/agent/components/tool-views/shell-meta";
import { ShellMark } from "@/apps/agent/components/tool-views/ShellMark";
import { useSettingsStore } from "@/kernel/store/useSettingsStore";

/** Rendered tail. Beyond this a `<pre>` becomes a renderer-stability risk. */
const MAX_RENDERED_CHARS = 60_000;
/** Distance from the bottom that still counts as "following". */
const FOLLOW_THRESHOLD_PX = 40;

/**
 * Whole seconds and whole minutes, both sides of "45s of 2m".
 *
 * Deliberately not `formatToolDuration`: that keeps a decimal under ten
 * seconds, and a tenths digit re-rendering next to a static budget reads as
 * jitter rather than progress.
 */
function formatSeconds(ms: number): string {
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

const AnsiText: React.FC<{ spans: AnsiSpan[] }> = ({ spans }) => (
  <>
    {spans.map((span, index) =>
      span.color || span.bold || span.dim || span.italic || span.underline ? (
        <span
          key={index}
          style={{
            color: span.color,
            fontWeight: span.bold ? 600 : undefined,
            opacity: span.dim ? 0.65 : undefined,
            fontStyle: span.italic ? "italic" : undefined,
            textDecoration: span.underline ? "underline" : undefined,
          }}
        >
          {span.text}
        </span>
      ) : (
        span.text
      ),
    )}
  </>
);

export const ShellStreamView: React.FC<{
  command?: string;
  cwd?: string;
  /** Requested shell id ("bash", "pwsh", …) — picks the prompt glyph + name. */
  shell?: string;
  output: string;
  /** Epoch ms the command started. Absent on a row rebuilt from history. */
  startedAt?: number;
  /** What Rust will kill the command at, so the wait can say when it ends. */
  timeoutMs?: number;
}> = ({ command, cwd, shell: shellId, output, startedAt, timeoutMs }) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  const text = useMemo(
    () =>
      output.length > MAX_RENDERED_CHARS
        ? output.slice(output.length - MAX_RENDERED_CHARS)
        : output,
    [output],
  );
  const ansiSpans = useMemo(() => (hasAnsi(text) ? parseAnsi(text) : null), [text]);

  useEffect(() => {
    const body = bodyRef.current;
    if (body && followRef.current) body.scrollTop = body.scrollHeight;
  }, [text]);

  const handleScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    const distance = body.scrollHeight - body.scrollTop - body.clientHeight;
    followRef.current = distance <= FOLLOW_THRESHOLD_PX;
  };

  const shell = shellMeta(shellId);
  const explorerIconPack = useSettingsStore((s) => s.explorerIconPack);

  // Only ticks while there is nothing to read. Once output arrives the body
  // moving IS the progress, and a second clock beside it is noise.
  const idle = text.length === 0;
  const [now, setNow] = useState(() => Date.now());
  const elapsed = startedAt === undefined ? 0 : Math.max(0, now - startedAt);
  useEffect(() => {
    if (!idle || startedAt === undefined) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [idle, startedAt]);

  const waitLabel =
    startedAt === undefined
      ? null
      : `${formatSeconds(elapsed)}${timeoutMs ? ` of ${formatSeconds(timeoutMs)}` : ""}`;

  return (
    <div className="agw-rv">
      <div className="agw-rv-head">
        {/* Same mark as the row badge and the finished result — one shell, one
            picture, whichever of the three surfaces you are looking at. */}
        <span className="agw-rv-mark" style={{ color: "var(--agw-accent)" }}>
          {shell ? (
            <ShellMark shell={shell} packId={explorerIconPack} size={12} />
          ) : (
            <AgentIcon name="terminal" size={11} />
          )}
        </span>
        <span className="agw-rv-title">{shell ? shell.name : "Command"}</span>
        {/* "Run in background" deliberately does NOT live here. Cards are
            collapsed by default, so a control in this header is behind a click;
            it sits on the row instead (`RunningShellControl`), which is on
            screen whether or not anyone opened the card. */}
        <span className="agw-rv-badge agw-shell-live" aria-live="off">
          Running
        </span>
      </div>

      {command && (
        <div
          className="agw-shell-command"
          title={cwd ? `Working directory: ${cwd}` : undefined}
        >
          <span aria-hidden>{shell?.prompt ?? "$"}</span>
          <code>{command}</code>
        </div>
      )}

      {text ? (
        <div ref={bodyRef} onScroll={handleScroll} className="agw-rv-body agw-scroll">
          <pre className="agw-shell-out">{ansiSpans ? <AnsiText spans={ansiSpans} /> : text}</pre>
        </div>
      ) : (
        // A command that prints nothing until it finishes — `pnpm lint` is the
        // one that started this — used to sit on the bare word "Waiting" for as
        // long as it took, identical at second 3 and second 300. Naming the
        // limit turns it into a wait with an end: silence is what this command
        // does, and it stops at a stated time.
        <div className="agw-shell-waiting">
          Waiting for output…
          {waitLabel && <span className="agw-shell-waiting-clock">{waitLabel}</span>}
        </div>
      )}
    </div>
  );
};
