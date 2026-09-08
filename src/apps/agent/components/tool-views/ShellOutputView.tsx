/**
 * Agent Window — shell_execute view [tool result].
 *
 * Header chip (status / exit), one prompt-like command row, and a capped
 * scrolling output area. Output is trimmed to the tail (where errors/exit
 * summaries live) so a runaway command can't freeze the renderer. Re-themed with
 * `--agw-*` + `AgentIcon`.
 */

import React, { useMemo } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { hasAnsi, parseAnsi, type AnsiSpan } from "@/apps/agent/components/tool-views/ansi";
import { shellMeta } from "@/apps/agent/components/tool-views/shell-meta";
import { ShellMark } from "@/apps/agent/components/tool-views/ShellMark";
import { useSettingsStore } from "@/kernel/store/useSettingsStore";
import type { ShellOutputData } from "@/apps/agent/components/tool-views/tool-result";

const MAX_CHARS = 60_000;
const MAX_LINES = 600;

/** Styled segment of terminal output — plain text stays plain (no span). */
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

export const ShellOutputView: React.FC<{ data: ShellOutputData }> = ({ data }) => {
  const { text, trimmedLines } = useMemo(() => {
    let working = data.output ?? "";
    if (working.length > MAX_CHARS) working = working.slice(working.length - MAX_CHARS);
    const lines = working.split("\n");
    let trimmedLines = 0;
    if (lines.length > MAX_LINES) {
      trimmedLines = lines.length - MAX_LINES;
      working = lines.slice(lines.length - MAX_LINES).join("\n");
    }
    return { text: working, trimmedLines };
  }, [data.output]);

  // Colorized output (linters, test runners, git) renders through the ANSI
  // parser; ANSI-free output takes the zero-cost plain path.
  const ansiSpans = useMemo(() => (hasAnsi(text) ? parseAnsi(text) : null), [text]);

  // Resolved shell → its own prompt glyph and header name, so a PowerShell run
  // doesn't wear a POSIX "$" costume. Absent (historic threads) → "$" as before.
  const shell = shellMeta(data.shell);
  const explorerIconPack = useSettingsStore((s) => s.explorerIconPack);

  return (
    <div className="agw-rv">
      <div className="agw-rv-head">
        {/* The shell's OWN mark, the same one the row badge shows. A generic
            terminal glyph here meant a bash run wore two different pictures of
            itself eight pixels apart. Colour is set here, not by the mark: a
            brand asset brings its own and the drawn fallback inherits this. */}
        <span className="agw-rv-mark" style={{ color: "var(--agw-accent)" }}>
          {shell ? (
            <ShellMark shell={shell} packId={explorerIconPack} size={12} />
          ) : (
            <AgentIcon name="terminal" size={11} />
          )}
        </span>
        <span className="agw-rv-title">{shell ? shell.name : "Command"}</span>
        {/* A mark, not a pill. `SUCCESS` was bordered, tinted and uppercase —
            the brightest object in the quietest row, announcing the ordinary
            case loudest. This is the same treatment the tool-group header
            already uses for its failure count (see the 2026-08-13 entry in
            .knowledge/knowledge.md): the glyph carries the state, and the exit
            code beside it carries the detail. The label stays for screen
            readers, since a colour and a shape cannot be the only carriers. */}
        {/* A handed-over command has no outcome to mark yet. Drawing the tick
            would state one, and drawing the × would state the opposite one; it
            wears the process list's own glyph instead, because "it is over
            there now" is the whole truth about it. */}
        {data.detached ? (
          <span className="agw-rv-mark-live" title="Still running in the background">
            <AgentIcon name="process-list" size={12} strokeWidth={2.2} />
            <span className="agw-sr-only">Still running in the background</span>
          </span>
        ) : (
          <span
            className={data.success ? "agw-rv-mark-ok" : "agw-rv-mark-bad"}
            title={data.success ? "Succeeded" : "Failed"}
          >
            <AgentIcon
              name={data.success ? "check" : "close"}
              size={12}
              strokeWidth={2.6}
            />
            <span className="agw-sr-only">{data.success ? "Succeeded" : "Failed"}</span>
          </span>
        )}
        {!data.detached && typeof data.exitCode === "number" && (
          <span className="agw-rv-exit">exit {data.exitCode}</span>
        )}
      </div>

      {/* No "moved to the background" banner here. The row above this card
          already says "Running in the background" in words, and the header mark
          beside the shell name says it again in a glyph — a third copy inside
          the body made one short card state the same fact three times. The mark
          carries it; its accessible name says it for a screen reader. */}

      {data.command && (
        <div className="agw-shell-command" title={data.cwd ? `Working directory: ${data.cwd}` : undefined}>
          <span aria-hidden>{shell?.prompt ?? "$"}</span>
          <code>{data.command}</code>
        </div>
      )}

      {data.shellNote && <div className="agw-shell-trim">{data.shellNote}</div>}

      {trimmedLines > 0 && (
        <div className="agw-shell-trim">
          Trimmed — {trimmedLines.toLocaleString()} earlier lines hidden (showing last {MAX_LINES}).
        </div>
      )}

      {text ? (
        <div className="agw-rv-body agw-scroll">
          <pre className="agw-shell-out">
            {ansiSpans ? <AnsiText spans={ansiSpans} /> : text}
          </pre>
        </div>
      ) : null}
    </div>
  );
};
