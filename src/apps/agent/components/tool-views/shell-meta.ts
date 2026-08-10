/**
 * Agent Window — shell identity display metadata (leaf, non-component).
 *
 * The shell tools require a `shell` argument (the command is written in exactly
 * one shell's syntax) and their results echo the RESOLVED shell id — which can
 * differ from the requested one when the runtime substitutes an available
 * shell. This module maps those ids to what the transcript shows: the badge
 * text, the full name for tooltips, the prompt glyph the command row uses, and
 * the family that picks the badge tint.
 *
 * Ids come from Rust `ShellKind::id()` (`bash` / `sh` / `zsh` / `pwsh` /
 * `powershell` / `cmd`). An unknown id still renders — as itself, untinted —
 * because hiding the shell a historic thread named would be less truthful than
 * showing an id we don't recognise.
 */

export interface ShellMeta {
  /** Canonical lowercase id — the badge text ("bash", "pwsh", "cmd"). */
  id: string;
  /** Full name for tooltips ("Windows PowerShell"). */
  name: string;
  /** Prompt glyph for the command row ("$", "%", ">", "PS>"). */
  prompt: string;
  /** Family grouping for the badge tint. */
  family: "posix" | "powershell" | "cmd" | "other";
}

const KNOWN_SHELLS: Record<string, Omit<ShellMeta, "id">> = {
  bash: { name: "Bash", prompt: "$", family: "posix" },
  sh: { name: "sh", prompt: "$", family: "posix" },
  zsh: { name: "Zsh", prompt: "%", family: "posix" },
  pwsh: { name: "PowerShell 7", prompt: "PS>", family: "powershell" },
  powershell: { name: "Windows PowerShell", prompt: "PS>", family: "powershell" },
  cmd: { name: "Command Prompt", prompt: ">", family: "cmd" },
};

/** Display metadata for a shell id, or `null` when there is no id at all. */
export function shellMeta(id: string | null | undefined): ShellMeta | null {
  const key = id?.trim().toLowerCase();
  if (!key) return null;
  const known = KNOWN_SHELLS[key];
  return known ? { id: key, ...known } : { id: key, name: key, prompt: "$", family: "other" };
}
