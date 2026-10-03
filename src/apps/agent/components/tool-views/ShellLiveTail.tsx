/**
 * Agent Window — the last few lines of a running command, under its row.
 *
 * Tool cards are collapsed by default, so the full live view
 * (`ShellStreamView`) only shows to someone who opened the card while the
 * command ran. Most people open it afterwards, which made a command printing
 * 1 to 100 look like it printed everything at the end. This strip shows the
 * newest lines without opening anything (probe 03,
 * Documents/aurora-shell-live-output-designs.html).
 *
 * Its height is fixed, so the transcript holds still while output arrives.
 * The card removes it when the command ends or when the card is opened, since
 * the full view then shows the same output.
 */

import React, { useMemo } from "react";

import { tailLines } from "@/apps/agent/components/tool-views/shell-tail";

export const ShellLiveTail: React.FC<{ output: string }> = ({ output }) => {
  const lines = useMemo(() => tailLines(output), [output]);
  return (
    <div className="agw-shell-tail" aria-hidden>
      <pre>{lines.join("\n")}</pre>
    </div>
  );
};
