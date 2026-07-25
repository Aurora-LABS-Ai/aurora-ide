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

import React, { useEffect, useMemo, useRef } from "react";

import { AgentIcon } from "../../shared/AgentIcon";
import { hasAnsi, parseAnsi, type AnsiSpan } from "./ansi";

/** Rendered tail. Beyond this a `<pre>` becomes a renderer-stability risk. */
const MAX_RENDERED_CHARS = 60_000;
/** Distance from the bottom that still counts as "following". */
const FOLLOW_THRESHOLD_PX = 40;

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
  output: string;
}> = ({ command, cwd, output }) => {
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

  return (
    <div className="agw-rv">
      <div className="agw-rv-head">
        <AgentIcon name="terminal" size={11} style={{ color: "var(--agw-accent)" }} />
        <span className="agw-rv-title">Command</span>
        <span className="agw-rv-badge agw-shell-live" aria-live="off">
          Running
        </span>
      </div>

      {command && (
        <div
          className="agw-shell-command"
          title={cwd ? `Working directory: ${cwd}` : undefined}
        >
          <span aria-hidden>$</span>
          <code>{command}</code>
        </div>
      )}

      {text ? (
        <div ref={bodyRef} onScroll={handleScroll} className="agw-rv-body agw-scroll">
          <pre className="agw-shell-out">{ansiSpans ? <AnsiText spans={ansiSpans} /> : text}</pre>
        </div>
      ) : (
        <div className="agw-shell-waiting">Waiting for output…</div>
      )}
    </div>
  );
};
