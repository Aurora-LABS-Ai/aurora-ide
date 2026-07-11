/**
 * Agent Window — shell_execute view [tool result].
 *
 * Header chip (status / exit), one prompt-like command row, and a capped
 * scrolling output area. Output is trimmed to the tail (where errors/exit
 * summaries live) so a runaway command can't freeze the renderer. Re-themed with
 * `--agw-*` + `AgentIcon`.
 */

import React, { useMemo } from "react";

import { AgentIcon } from "../../shared/AgentIcon";
import type { ShellOutputData } from "./tool-result";

const MAX_CHARS = 60_000;
const MAX_LINES = 600;

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

  return (
    <div className="agw-rv">
      <div className="agw-rv-head">
        <AgentIcon name="terminal" size={11} style={{ color: "var(--agw-accent)" }} />
        <span className="agw-rv-title">Command</span>
        <span className={data.success ? "agw-rv-badge agw-rv-badge-ok" : "agw-rv-badge agw-rv-badge-bad"}>
          {data.success ? "Success" : "Failed"}
        </span>
        {typeof data.exitCode === "number" && (
          <span className="agw-rv-exit">exit {data.exitCode}</span>
        )}
      </div>

      {data.command && (
        <div className="agw-shell-command" title={data.cwd ? `Working directory: ${data.cwd}` : undefined}>
          <span aria-hidden>$</span>
          <code>{data.command}</code>
        </div>
      )}

      {trimmedLines > 0 && (
        <div className="agw-shell-trim">
          Trimmed — {trimmedLines.toLocaleString()} earlier lines hidden (showing last {MAX_LINES}).
        </div>
      )}

      {text ? (
        <div className="agw-rv-body agw-scroll">
          <pre className="agw-shell-out">{text}</pre>
        </div>
      ) : null}
    </div>
  );
};
