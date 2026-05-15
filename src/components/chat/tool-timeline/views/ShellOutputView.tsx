import React, { useEffect, useRef } from "react";
import { Terminal } from "lucide-react";
import { cn } from "../helpers";
import type { ShellOutputData } from "../types";

type ShellOutputViewProps = ShellOutputData;

/**
 * Render `shell_execute` results: a header chip with mode/success/exit
 * code, a metadata block (command + cwd), and a scrolling pre-formatted
 * output area. Empty `output` collapses the whole card to nothing — the
 * status line in the parent header already conveys "ran successfully".
 */
export const ShellOutputView: React.FC<ShellOutputViewProps> = ({
  command,
  cwd,
  exitCode,
  mode = "inline",
  output,
  success,
}) => {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [command, cwd, exitCode, mode, output, success]);

  if (!output && output !== "") return null;

  return (
    <div className="mt-2 overflow-hidden rounded-md border border-border/50 bg-code-block">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/50 bg-input/30 px-3 py-1.5">
        <div className="flex items-center gap-1.5 text-text-primary">
          <Terminal size={12} />
          <span className="text-[10.5px] font-medium">
            {mode === "terminal" ? "IDE Terminal" : "Inline Terminal"}
          </span>
        </div>

        {typeof success === "boolean" && (
          <span
            className={cn(
              "rounded border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide",
              success
                ? "border-success/30 bg-success/10 text-success"
                : "border-error/30 bg-error/10 text-error",
            )}
          >
            {success ? "Success" : "Failed"}
          </span>
        )}

        {typeof exitCode === "number" && (
          <span className="rounded border border-border/70 bg-input/40 px-1.5 py-0.5 text-[9px] font-mono text-text-secondary">
            exit {exitCode}
          </span>
        )}

        <span className="ml-auto text-[9px] uppercase tracking-wide text-text-disabled">
          Scroll inside
        </span>
      </div>

      {(command || cwd) && (
        <div className="flex flex-col gap-1 border-b border-border/40 bg-sidebar/30 px-3 py-2 text-[9.5px] text-text-secondary">
          {command && (
            <div className="flex flex-wrap items-start gap-2">
              <span className="shrink-0 uppercase tracking-wide text-text-disabled">
                Command
              </span>
              <code className="break-all font-mono text-text-primary">
                {command}
              </code>
            </div>
          )}
          {cwd && (
            <div className="flex flex-wrap items-start gap-2">
              <span className="shrink-0 uppercase tracking-wide text-text-disabled">
                Cwd
              </span>
              <code className="break-all font-mono">{cwd}</code>
            </div>
          )}
        </div>
      )}

      <div
        ref={contentRef}
        className="max-h-[240px] overflow-auto scrollbar-thin scrollbar-thumb-scrollbar scrollbar-track-transparent"
      >
        <pre className="min-w-full whitespace-pre-wrap break-all px-3 py-2 font-mono text-[10.5px] leading-[1.6] text-text-secondary">
          <code>{output || "No output"}</code>
        </pre>
      </div>
    </div>
  );
};
