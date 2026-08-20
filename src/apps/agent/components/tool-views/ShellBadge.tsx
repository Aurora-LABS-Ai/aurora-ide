/**
 * Agent Window — shell badge on a tool row [view].
 *
 * Names the shell a command actually ran in: a mark plus the id (`bash`,
 * `pwsh`, `cmd`). It replaces a 5px family-tinted dot, which could only ever
 * say "POSIX" — bash and zsh wore the same green, so the picture carried less
 * than the word beside it.
 *
 * The picture itself lives in `ShellMark`, shared with the expanded result and
 * the live stream headers so the three surfaces cannot show a shell three
 * different ways.
 */

import React from "react";

import { ShellMark } from "@/apps/agent/components/tool-views/ShellMark";
import type { ShellMeta } from "@/apps/agent/components/tool-views/shell-meta";

export const ShellBadge: React.FC<{
  shell: ShellMeta;
  /** Active explorer icon pack id; `null` uses the drawn marks throughout. */
  packId: string | null | undefined;
  /** Tooltip — the runtime's substitution note when there is one, else the name. */
  note?: string | null;
}> = ({ shell, packId, note }) => (
  <span
    className="agw-shell-badge"
    data-shell-family={shell.family}
    title={note ?? shell.name}
  >
    <span className="agw-shell-badge-mark" aria-hidden>
      <ShellMark shell={shell} packId={packId} size={12} />
    </span>
    {shell.id}
  </span>
);
