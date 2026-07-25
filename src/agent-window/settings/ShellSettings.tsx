/**
 * Agent Window — Settings · Tools › Shells (view).
 *
 * A collapsible group in the same family as the per-tool approval groups:
 * shells decide *where* a command runs, approval decides *whether* it runs.
 *
 * The user supplies a path (or scans); Aurora derives the flags and
 * environment from the shell's family, so a profile can never carry wrong
 * arguments. A healthy row therefore carries no badge at all — only shells
 * with something wrong get one, which is what makes a problem visible.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { AgentIcon } from "../shared/AgentIcon";
import {
  addShellProfile,
  EMPTY_SHELL_PROFILES,
  getShellProfiles,
  removeShellProfile,
  resolveDefaultProfile,
  scanShellProfiles,
  setShellProfileEnabled,
  SHELL_KIND_LABELS,
  verifyShellProfile,
  type ShellHealthState,
  type ShellProfile,
  type ShellProfiles,
} from "../../services/shell-profiles";
import { AgwButton, AgwPill, AgwSwitch, AgwTextInput, type PillTone } from "./primitives";

/** Shown only when something is wrong — a working shell needs no badge. */
const HEALTH_BADGE: Partial<Record<ShellHealthState, { label: string; tone: PillTone }>> = {
  degraded: { label: "Limited", tone: "warning" },
  failed: { label: "Not working", tone: "danger" },
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ── One registered shell ─────────────────────────────────────────────────────

const ShellRow: React.FC<{
  profile: ShellProfile;
  /** Used where nothing names a shell (terminal, diagnostics). Derived, not
   *  chosen — so this is a readout, never a control. */
  isFallback: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onRecheck: () => void;
  onRemove: () => void;
}> = ({ profile, isFallback, busy, onToggle, onRecheck, onRemove }) => {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const badge = HEALTH_BADGE[profile.health.state];
  const unusable = profile.health.state === "failed";

  return (
    <div className="agw-shell-row" data-busy={busy || undefined}>
      <div className="agw-shell-row-main">
        <div className="agw-shell-row-head">
          <span className="agw-shell-name">{profile.label}</span>
          {isFallback && (
            <span title="Used by the terminal and diagnostics, where nothing names a shell. The agent names its own on every command.">
              <AgwPill tone="info" dot={false}>
                Fallback
              </AgwPill>
            </span>
          )}
          {badge && <AgwPill tone={badge.tone}>{badge.label}</AgwPill>}
          {profile.preferred && !isFallback && (
            <span className="agw-shell-tag">Your terminal default</span>
          )}
        </div>

        <div className="agw-shell-meta">
          {/* The family is only worth saying when it is not already the name —
              "PowerShell 7 · PowerShell 7" reads as a rendering bug. */}
          {SHELL_KIND_LABELS[profile.kind] !== profile.label && (
            <span>{SHELL_KIND_LABELS[profile.kind]}</span>
          )}
          {profile.version && <span>{profile.version}</span>}
          <span className="agw-shell-path" title={profile.exe || profile.path}>
            {profile.path}
          </span>
        </div>

        {profile.health.detail && (
          <p className="agw-shell-detail" data-state={profile.health.state}>
            {profile.health.detail}
          </p>
        )}

        <div className="agw-shell-actions">
          {/* "Use by default" lived here. Removed with the user-chosen default:
              it asked the user to predict which shell an unwritten command
              would need. Enable/disable is the only decision they can actually
              reason about, and the agent states the shell per command. */}
          {profile.health.state !== "ready" && (
            <button type="button" className="agw-shell-action" onClick={onRecheck}>
              Check again
            </button>
          )}
          {profile.source === "manual" &&
            (confirmingRemove ? (
              <>
                <button
                  type="button"
                  className="agw-shell-action"
                  data-tone="danger"
                  onClick={onRemove}
                >
                  Remove for good
                </button>
                <button
                  type="button"
                  className="agw-shell-action"
                  onClick={() => setConfirmingRemove(false)}
                >
                  Keep
                </button>
              </>
            ) : (
              <button
                type="button"
                className="agw-shell-action"
                onClick={() => setConfirmingRemove(true)}
              >
                Remove
              </button>
            ))}
        </div>
      </div>

      <div className="agw-shell-row-control">
        <AgwSwitch
          checked={profile.enabled && !unusable}
          disabled={unusable || busy}
          onChange={onToggle}
          ariaLabel={`Let the agent use ${profile.label}`}
        />
      </div>
    </div>
  );
};

// ── Collapsible group ────────────────────────────────────────────────────────

export const ShellSettings: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ShellProfiles>(EMPTY_SHELL_PROFILES);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draftPath, setDraftPath] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const pathInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    getShellProfiles()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorText(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Every mutation returns the whole registry, so state is replaced wholesale. */
  const run = useCallback(async (action: () => Promise<ShellProfiles>, id?: string) => {
    setError(null);
    if (id) setBusyId(id);
    try {
      setState(await action());
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      if (id) setBusyId(null);
    }
  }, []);

  const handleScan = useCallback(async () => {
    setScanning(true);
    await run(scanShellProfiles);
    setScanning(false);
  }, [run]);

  const handleAdd = useCallback(async () => {
    const path = draftPath.trim();
    if (!path) {
      setAddError("Enter the full path to a shell executable.");
      pathInputRef.current?.focus();
      return;
    }
    setAddBusy(true);
    setAddError(null);
    try {
      setState(await addShellProfile(path));
      setDraftPath("");
      setAdding(false);
    } catch (cause) {
      // Keep what was typed — the path is usually nearly right.
      setAddError(errorText(cause));
      pathInputRef.current?.focus();
    } finally {
      setAddBusy(false);
    }
  }, [draftPath]);

  const activeDefault = resolveDefaultProfile(state);
  const availableCount = state.profiles.filter(
    (profile) => profile.enabled && profile.health.state !== "failed",
  ).length;
  const degraded = state.profiles.some(
    (profile) => profile.enabled && profile.health.state === "degraded",
  );
  // Aurora's command guidance and its safety checks are written for POSIX
  // shells. Switching the last one off is allowed, but it silently removes
  // `bash` from what the agent can even ask for — worth saying out loud,
  // because the symptom lands later as an agent ignoring a project rule.
  const posixKinds: ShellProfile["kind"][] = ["bash", "sh", "zsh"];
  const hasPosix = state.profiles.some(
    (profile) =>
      profile.enabled && profile.health.state !== "failed" && posixKinds.includes(profile.kind),
  );
  const posixMissing = state.profiles.length > 0 && !hasPosix;
  const needsAttention = degraded || posixMissing;

  // Collapsed summary: how many are usable, and which one commands land in.
  const summary = useMemo(() => {
    if (loading) return "Loading…";
    if (state.profiles.length === 0) return "None set up";
    if (!activeDefault) return `${availableCount} enabled`;
    return `${availableCount} enabled · ${activeDefault.label} fallback`;
  }, [loading, state.profiles.length, availableCount, activeDefault]);

  return (
    <div className="agw-set-groups">
      <div className="agw-set-group" data-open={open || undefined}>
        <button
          type="button"
          className="agw-set-group-head"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <span className="agw-set-group-chev" data-open={open || undefined}>
            <AgentIcon name="chevron-down" size={15} />
          </span>
          <span className="agw-set-group-ico">
            <AgentIcon name="terminal" size={15} />
          </span>
          <span className="agw-set-group-title">Shells</span>
          <span className="agw-set-group-meta">{summary}</span>
          {/* The badge slot reports state, never describes the section — so it
              stays empty while every shell is fine. */}
          {needsAttention && <AgwPill tone="warning">Needs a look</AgwPill>}
        </button>

        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="body"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              style={{ overflow: "hidden" }}
            >
              <div className="agw-shell-panel">
                <div className="agw-shell-toolbar">
                  <AgwButton
                    variant="primary"
                    icon="search"
                    onClick={handleScan}
                    disabled={scanning}
                  >
                    {scanning ? "Scanning…" : "Scan for shells"}
                  </AgwButton>
                  <AgwButton
                    icon="plus"
                    onClick={() => {
                      setAdding((value) => !value);
                      setAddError(null);
                    }}
                  >
                    Add by path
                  </AgwButton>
                </div>

                {adding && (
                  <div className="agw-shell-add">
                    <label className="agw-shell-add-label" htmlFor="agw-shell-path">
                      Shell path
                    </label>
                    <p className="agw-shell-add-hint">
                      bash, sh, zsh, pwsh, powershell, or cmd. Variables like{" "}
                      <code>%PROGRAMFILES%</code> work.
                    </p>
                    <div className="agw-shell-add-row">
                      <AgwTextInput
                        id="agw-shell-path"
                        ref={pathInputRef}
                        value={draftPath}
                        autoFocus
                        placeholder="C:\\Program Files\\Git\\bin\\bash.exe"
                        onChange={(event) => setDraftPath(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void handleAdd();
                          if (event.key === "Escape") setAdding(false);
                        }}
                        aria-invalid={addError ? true : undefined}
                        aria-describedby={addError ? "agw-shell-path-error" : undefined}
                      />
                      <AgwButton variant="primary" onClick={handleAdd} disabled={addBusy}>
                        {addBusy ? "Checking…" : "Add shell"}
                      </AgwButton>
                    </div>
                    {addError && (
                      <p className="agw-shell-add-error" id="agw-shell-path-error" role="alert">
                        {addError}
                      </p>
                    )}
                  </div>
                )}

                {error && (
                  <p className="agw-shell-add-error" role="alert">
                    {error}
                  </p>
                )}

                {posixMissing && (
                  <p className="agw-shell-warn">
                    No bash, sh, or zsh is switched on, so the agent can only run PowerShell or
                    Command Prompt syntax. Project rules that ask for Git Bash cannot be followed.
                  </p>
                )}

                {loading ? (
                  <p className="agw-shell-empty">Loading shells…</p>
                ) : state.profiles.length === 0 ? (
                  <div className="agw-shell-empty">
                    <p>No shells set up yet.</p>
                    <p className="agw-shell-empty-hint">
                      Scan to find the ones installed on this machine, or add one by path.
                    </p>
                  </div>
                ) : (
                  // Only the rows scroll: the toolbar above and the footer below
                  // stay put, so scanning and reading the default never move.
                  <div className="agw-shell-list agw-scroll">
                    {state.profiles.map((profile) => (
                      <ShellRow
                        key={profile.id}
                        profile={profile}
                        isFallback={activeDefault?.id === profile.id}
                        busy={busyId === profile.id}
                        onToggle={(enabled) =>
                          void run(() => setShellProfileEnabled(profile.id, enabled), profile.id)
                        }
                        onRecheck={() => void run(() => verifyShellProfile(profile.id), profile.id)}
                        onRemove={() => void run(() => removeShellProfile(profile.id), profile.id)}
                      />
                    ))}
                  </div>
                )}

                {activeDefault && (
                  <p className="agw-shell-foot">
                    The agent names a shell on every command and can only name the ones switched
                    on here. <strong>{activeDefault.label}</strong> is used where nothing names one
                    — the terminal and diagnostics. Scanning keeps one shell per type; add a
                    specific install by path if you want a different one.
                  </p>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
