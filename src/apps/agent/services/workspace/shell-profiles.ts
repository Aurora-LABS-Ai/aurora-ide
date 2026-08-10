/**
 * Shell profiles — the registry of shells Aurora may run commands in.
 *
 * Rust owns discovery, verification, and resolution (`src-tauri/src/shell/`).
 * This module is a thin typed boundary: it mirrors the serialized shapes and
 * forwards the seven commands. Every mutating command returns the **complete**
 * new registry, so callers replace state rather than reconciling it — there is
 * no client-side copy that can drift from what actually runs.
 */

import { auroraInvoke } from "@/kernel/lib/ipc/runtime";

/** Shell families Aurora knows how to drive. */
export type ShellKind = "bash" | "sh" | "zsh" | "pwsh" | "powershell" | "cmd";

/**
 * - `ready` — verified: it starts and its expected utilities are reachable.
 * - `degraded` — it starts, but something will fail later (a bash that cannot
 *   reach `ls`/`sed`/`uname`). Still selectable; the reason is shown.
 * - `failed` — cannot be launched.
 */
export type ShellHealthState = "ready" | "degraded" | "failed";

export interface ShellHealth {
  state: ShellHealthState;
  /** Plain-language reason, present for degraded and failed. */
  detail?: string;
}

export interface ShellProfile {
  id: string;
  kind: ShellKind;
  label: string;
  /** Path as registered — may still contain `%PROGRAMFILES%`-style variables. */
  path: string;
  /** Expanded path recorded at verification time. */
  exe: string;
  enabled: boolean;
  /** Windows Terminal's default profile. A hint, not Aurora's default. */
  preferred: boolean;
  source: "scan" | "manual";
  version?: string;
  health: ShellHealth;
  verifiedAtMs: number;
}

export interface ShellProfiles {
  version: number;
  profiles: ShellProfile[];
}

export const EMPTY_SHELL_PROFILES: ShellProfiles = { version: 1, profiles: [] };

/** Display name per kind, for the row subline. */
export const SHELL_KIND_LABELS: Record<ShellKind, string> = {
  bash: "bash",
  sh: "sh",
  zsh: "zsh",
  pwsh: "PowerShell 7",
  powershell: "Windows PowerShell",
  cmd: "Command Prompt",
};

export const getShellProfiles = (): Promise<ShellProfiles> =>
  auroraInvoke<ShellProfiles>("shell_profiles_get");

/** Re-scan the machine. Existing choices, labels, and manual entries survive. */
export const scanShellProfiles = (): Promise<ShellProfiles> =>
  auroraInvoke<ShellProfiles>("shell_profiles_scan");

/** Register a shell by path. Rejects with a reason if it cannot be run. */
export const addShellProfile = (path: string, label?: string): Promise<ShellProfiles> =>
  auroraInvoke<ShellProfiles>("shell_profiles_add", { path, label: label ?? null });

export const removeShellProfile = (id: string): Promise<ShellProfiles> =>
  auroraInvoke<ShellProfiles>("shell_profiles_remove", { id });

export const setShellProfileEnabled = (id: string, enabled: boolean): Promise<ShellProfiles> =>
  auroraInvoke<ShellProfiles>("shell_profiles_set_enabled", { id, enabled });

/** Re-run verification for one profile, after the user fixes an install. */
export const verifyShellProfile = (id: string): Promise<ShellProfiles> =>
  auroraInvoke<ShellProfiles>("shell_profiles_verify", { id });

/**
 * The shell used when nothing names one — the terminal and diagnostics.
 *
 * Mirrors `ShellProfiles::default_profile` so the settings page can state the
 * behaviour without a round-trip. Purely derived: the first usable shell in
 * kind order, POSIX ahead of PowerShell because Aurora's prompts and command
 * validator are POSIX-shaped. There is no user-chosen default — agent commands
 * name their own shell, so this only covers everything else.
 */
export const resolveDefaultProfile = (state: ShellProfiles): ShellProfile | undefined => {
  const usable = (profile: ShellProfile) => profile.enabled && profile.health.state !== "failed";

  const order: ShellKind[] = ["bash", "zsh", "sh", "pwsh", "powershell", "cmd"];
  for (const kind of order) {
    const candidates = state.profiles.filter((profile) => profile.kind === kind && usable(profile));
    // Ready beats degraded, matching `ShellProfiles::first_usable_of`.
    const ready = candidates.find((profile) => profile.health.state === "ready");
    if (ready) return ready;
    if (candidates.length > 0) return candidates[0];
  }
  return undefined;
};
