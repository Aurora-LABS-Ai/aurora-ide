/**
 * Agent Window — Codex (ChatGPT) provider card (view).
 *
 * Rendered inside the Providers detail pane for the Codex provider. No API
 * key: the card owns sign-in (shared with Codex CLI via `~/.codex/auth.json`)
 * and shows live subscription usage — the rolling 5-hour window and the
 * weekly window — from the same endpoint Codex CLI's `/status` reads.
 *
 * Reuses the `.agw-atlas-*` presentation family (stat grid, meters, hero) so
 * both usage cards read as one system; codex-only bits use `.agw-codex-*`.
 */

import React, { useCallback, useEffect, useState } from "react";

import {
  codexAuthCancelLogin,
  codexAuthLogin,
  codexAuthLogout,
  codexAuthStatus,
  codexFmtDuration,
  codexPlanLabel,
  codexUsageGet,
  codexWindowLabel,
  CODEX_USAGE_URL,
  type CodexAuthStatus,
  type CodexUsageSnapshot,
  type CodexUsageWindow,
} from "@/apps/agent/services/providers/codex";
import { fmtRelative } from "@/apps/agent/services/providers/atlascloud";
import { AgentIcon } from "../shared/AgentIcon";
import { ProviderAvatar } from "./ProviderAvatar";
import { AgwButton, AgwPill, AgwSwitch } from "./primitives";

// ── Data hook ────────────────────────────────────────────────────────────────

type Phase =
  | "loading" // initial status probe
  | "signed-out"
  | "signing-in" // waiting for the browser callback
  | "ready" // signed in; usage may still be loading/failed independently
  | "error"; // status probe itself failed (bridge/runtime issue)

interface CodexState {
  phase: Phase;
  auth: CodexAuthStatus | null;
  usage: CodexUsageSnapshot | null;
  usageError: string | null;
  usageLoading: boolean;
  error: string | null;
}

function useCodex() {
  const [state, setState] = useState<CodexState>({
    phase: "loading",
    auth: null,
    usage: null,
    usageError: null,
    usageLoading: false,
    error: null,
  });

  const loadUsage = useCallback(() => {
    setState((s) => ({ ...s, usageLoading: true, usageError: null }));
    codexUsageGet()
      .then((usage) =>
        setState((s) => ({ ...s, usage, usageLoading: false, usageError: null })),
      )
      .catch((err) =>
        setState((s) => ({
          ...s,
          usageLoading: false,
          usageError: (err as Error)?.message || String(err),
        })),
      );
  }, []);

  const refreshStatus = useCallback(() => {
    codexAuthStatus()
      .then((auth) => {
        const signedIn = auth.signedIn;
        setState((s) => ({
          ...s,
          // Don't stomp an in-flight browser sign-in with a stale probe.
          phase: s.phase === "signing-in" ? s.phase : signedIn ? "ready" : "signed-out",
          auth,
          error: null,
        }));
        if (signedIn) loadUsage();
      })
      .catch((err) =>
        setState((s) => ({
          ...s,
          phase: "error",
          error: (err as Error)?.message || String(err),
        })),
      );
  }, [loadUsage]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const signIn = useCallback(() => {
    setState((s) => ({ ...s, phase: "signing-in", error: null }));
    codexAuthLogin()
      .then((auth) => {
        setState((s) => ({ ...s, phase: "ready", auth, error: null }));
        loadUsage();
      })
      .catch((err) =>
        setState((s) => ({
          ...s,
          phase: "signed-out",
          error: (err as Error)?.message || String(err),
        })),
      );
  }, [loadUsage]);

  const cancelSignIn = useCallback(() => {
    void codexAuthCancelLogin();
    setState((s) => ({ ...s, phase: "signed-out" }));
  }, []);

  const signOut = useCallback(() => {
    codexAuthLogout()
      .then(() =>
        setState((s) => ({
          ...s,
          phase: "signed-out",
          auth: null,
          usage: null,
          usageError: null,
        })),
      )
      .catch((err) =>
        setState((s) => ({ ...s, error: (err as Error)?.message || String(err) })),
      );
  }, []);

  return { ...state, refreshStatus, loadUsage, signIn, cancelSignIn, signOut };
}

// ── Small presentational bits (Atlas family) ─────────────────────────────────

const Meter: React.FC<{ ratio: number }> = ({ ratio }) => (
  <div className="agw-atlas-meter">
    <span
      className="agw-atlas-meter-fill"
      data-tone={ratio > 0.9 ? "danger" : ratio > 0.7 ? "warn" : "accent"}
      style={{ width: `${Math.min(100, Math.max(0, ratio * 100)).toFixed(1)}%` }}
    />
  </div>
);

const WindowMeter: React.FC<{ win: CodexUsageWindow; fallbackLabel: string }> = ({
  win,
  fallbackLabel,
}) => {
  const used = Math.min(100, Math.max(0, win.usedPercent));
  return (
    <div className="agw-codex-window">
      <div className="agw-codex-window-head">
        <span className="agw-codex-window-label">{codexWindowLabel(win, fallbackLabel)}</span>
        <span className="agw-codex-window-meta">
          {Math.round(used)}% used
          {win.resetsInSeconds != null && (
            <> · resets in {codexFmtDuration(win.resetsInSeconds)}</>
          )}
        </span>
      </div>
      <Meter ratio={used / 100} />
    </div>
  );
};

// ── Card ─────────────────────────────────────────────────────────────────────

export const CodexUsageCard: React.FC<{
  enabled: boolean;
  onToggleEnabled: (next: boolean) => void;
}> = ({ enabled, onToggleEnabled }) => {
  const {
    phase,
    auth,
    usage,
    usageError,
    usageLoading,
    error,
    loadUsage,
    signIn,
    cancelSignIn,
    signOut,
  } = useCodex();
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  const plan = codexPlanLabel(usage?.planType ?? auth?.planType);

  return (
    <section className="agw-atlas" aria-label="Codex usage">
      <div className="agw-atlas-head">
        {/* Codex's real mark, from the same brand set the provider rail uses.
            A generic chat glyph stood in for it here while the rail beside it
            showed the logo — one provider wearing two different faces. */}
        <ProviderAvatar provider={{ id: "codex", name: "Codex" }} />
        <div className="agw-atlas-head-titles">
          <div className="agw-atlas-title">
            Codex
            {/* The plan is a fact about the account — set in the success
                colour and nothing more. "Limit reached" keeps its chip: that
                one is a live status that changes and that the user has to act
                on, which is exactly what a badge is for. */}
            {phase === "ready" && plan && <span className="agw-sub-plan">{plan}</span>}
            {phase === "ready" && usage?.limitReached && (
              <AgwPill tone="warning">Limit reached</AgwPill>
            )}
          </div>
          <div className="agw-atlas-sub">
            {phase === "ready" &&
              (auth?.email ? `Signed in as ${auth.email}` : "Signed in with ChatGPT")}
            {phase === "signed-out" && "Uses your ChatGPT plan — no API key"}
            {phase === "signing-in" && "Waiting for the browser…"}
            {phase === "loading" && "Checking sign-in…"}
            {phase === "error" && "Couldn't check sign-in"}
          </div>
        </div>
        <div className="agw-atlas-head-actions">
          {phase === "ready" && (
            <button
              type="button"
              className="agw-prov-icon-btn"
              title="Refresh usage"
              aria-label="Refresh usage"
              onClick={loadUsage}
            >
              <AgentIcon name="retry" size={14} />
            </button>
          )}
          <a
            className="agw-prov-icon-btn"
            href={CODEX_USAGE_URL}
            target="_blank"
            rel="noreferrer"
            title="Open ChatGPT usage settings"
            aria-label="Open ChatGPT usage settings"
          >
            <AgentIcon name="external" size={14} />
          </a>
          <span className="agw-atlas-head-sep" aria-hidden="true" />
          <AgwSwitch checked={enabled} onChange={onToggleEnabled} ariaLabel="Enable Codex" />
        </div>
      </div>

      {phase === "loading" && (
        <div className="agw-atlas-body">
          <div className="agw-atlas-skeleton" />
          <div className="agw-atlas-skeleton" style={{ width: "72%" }} />
        </div>
      )}

      {phase === "error" && <div className="agw-atlas-error"><span>{error}</span></div>}

      {phase === "signed-out" && (
        <div className="agw-atlas-body agw-codex-signin">
          <div className="agw-atlas-hint">
            Chat with GPT-5.5 and the Codex models using your ChatGPT Plus or Pro
            subscription. Already signed in to Codex CLI? Aurora picks that up
            automatically — otherwise sign in below.
          </div>
          {error && <div className="agw-codex-note" data-tone="error">{error}</div>}
          <div className="agw-codex-actions">
            <AgwButton variant="primary" onClick={signIn}>
              Sign in with ChatGPT
            </AgwButton>
          </div>
        </div>
      )}

      {phase === "signing-in" && (
        <div className="agw-atlas-body agw-codex-signin">
          <div className="agw-atlas-hint">
            Finish signing in to ChatGPT in your browser. This card updates
            automatically once you're done.
          </div>
          <div className="agw-codex-actions">
            <AgwButton onClick={cancelSignIn}>Cancel</AgwButton>
          </div>
        </div>
      )}

      {phase === "ready" && (
        <div className="agw-atlas-body">
          {usageLoading && !usage && (
            <>
              <div className="agw-atlas-skeleton" />
              <div className="agw-atlas-skeleton" style={{ width: "72%" }} />
            </>
          )}

          {usageError && !usage && (
            <div className="agw-atlas-error">
              <span>{usageError}</span>
              <button type="button" className="agw-atlas-retry" onClick={loadUsage}>
                <AgentIcon name="retry" size={13} /> Retry
              </button>
            </div>
          )}

          {usage && (
            <>
              {usage.primary && <WindowMeter win={usage.primary} fallbackLabel="5-hour limit" />}
              {usage.secondary && <WindowMeter win={usage.secondary} fallbackLabel="Weekly limit" />}
              {!usage.primary && !usage.secondary && (
                <div className="agw-atlas-note">
                  No usage reported yet — limits appear after your first Codex chat.
                </div>
              )}
              {usage.credits?.hasCredits && usage.credits.balance && (
                <div className="agw-atlas-note">
                  {usage.credits.unlimited
                    ? "Extra credits: unlimited"
                    : `Extra credits: ${usage.credits.balance}`}
                </div>
              )}
            </>
          )}

          <div className="agw-codex-foot">
            {usage && (
              <span className="agw-atlas-updated">
                Updated {fmtRelative(usage.fetchedAtMs)} ago
              </span>
            )}
            <span className="agw-codex-foot-spacer" />
            {confirmingSignOut ? (
              <span className="agw-codex-confirm">
                Also signs out Codex CLI on this machine.
                <button type="button" className="agw-codex-link" data-tone="danger" onClick={signOut}>
                  Sign out
                </button>
                <button
                  type="button"
                  className="agw-codex-link"
                  onClick={() => setConfirmingSignOut(false)}
                >
                  Keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="agw-codex-link"
                onClick={() => setConfirmingSignOut(true)}
              >
                Sign out
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
};

export default CodexUsageCard;
