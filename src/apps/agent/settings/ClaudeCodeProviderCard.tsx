/**
 * Agent Window — Claude Code (claude.ai subscription) provider card (view).
 *
 * Rendered inside the Providers detail pane for the Claude Code provider. No
 * API key: the card owns the sign-in and shows the plan's rolling windows —
 * the five-hour window, the seven-day window, and the per-family weekly
 * windows when the plan has them — from the endpoint Claude Code's `/usage`
 * reads.
 *
 * The sign-in is manual on purpose. Aurora shows a link; the user finishes in
 * whichever browser they like (even on another machine) and pastes the code
 * the page shows — or the whole address it lands on — back here. Nothing
 * opens a browser for them, nothing listens on a port, and nothing reads the
 * `~/.claude` directory Claude Code itself keeps.
 *
 * Reuses the `.agw-atlas-*` presentation family (head, meters, skeletons) and
 * the `.agw-codex-*` sign-in pieces so the subscription cards read as one
 * system; what the manual flow adds lives under `.agw-cc-*`.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";

import {
  claudeCodeAuthBegin,
  claudeCodeAuthCancel,
  claudeCodeAuthComplete,
  claudeCodeAuthLogout,
  claudeCodeAuthStatus,
  claudeCodePlanLabel,
  claudeCodeUsageGet,
  claudeCodeWindowMeta,
  CLAUDE_CODE_USAGE_URL,
  type ClaudeCodeAuthStatus,
  type ClaudeCodeUsageSnapshot,
  type ClaudeCodeUsageWindow,
} from "@/apps/agent/services/providers/claude-code";
import { fmtRelative } from "@/apps/agent/services/providers/atlascloud";
import { AgentIcon } from "../shared/AgentIcon";
import { ProviderAvatar } from "./ProviderAvatar";
import { AgwButton, AgwPill, AgwSwitch, AgwTextInput } from "./primitives";

// ── Data hook ────────────────────────────────────────────────────────────────

type Phase =
  | "loading" // initial status probe
  | "signed-out"
  | "awaiting-code" // link shown; waiting for the pasted code
  | "completing" // code sent; waiting for the exchange
  | "ready" // signed in; usage may still be loading/failed independently
  | "error"; // status probe itself failed (bridge/runtime issue)

interface ClaudeCodeState {
  phase: Phase;
  auth: ClaudeCodeAuthStatus | null;
  /** The link for the current sign-in attempt. */
  authUrl: string | null;
  usage: ClaudeCodeUsageSnapshot | null;
  usageError: string | null;
  usageLoading: boolean;
  /** A problem with the sign-in itself — shown beside the code field. */
  signInError: string | null;
  /** The status probe failed; nothing else can be trusted. */
  error: string | null;
}

const errorText = (err: unknown): string => (err as Error)?.message || String(err);

function useClaudeCode() {
  const [state, setState] = useState<ClaudeCodeState>({
    phase: "loading",
    auth: null,
    authUrl: null,
    usage: null,
    usageError: null,
    usageLoading: false,
    signInError: null,
    error: null,
  });

  const loadUsage = useCallback(() => {
    setState((s) => ({ ...s, usageLoading: true, usageError: null }));
    claudeCodeUsageGet()
      .then((usage) =>
        setState((s) => ({ ...s, usage, usageLoading: false, usageError: null })),
      )
      .catch((err) =>
        setState((s) => ({ ...s, usageLoading: false, usageError: errorText(err) })),
      );
  }, []);

  const refreshStatus = useCallback(() => {
    claudeCodeAuthStatus()
      .then((auth) => {
        setState((s) => ({
          ...s,
          // Don't stomp a sign-in in progress with a stale probe.
          phase:
            s.phase === "awaiting-code" || s.phase === "completing"
              ? s.phase
              : auth.signedIn
                ? "ready"
                : "signed-out",
          auth,
          error: null,
        }));
        if (auth.signedIn) loadUsage();
      })
      .catch((err) => setState((s) => ({ ...s, phase: "error", error: errorText(err) })));
  }, [loadUsage]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const startSignIn = useCallback(() => {
    setState((s) => ({ ...s, signInError: null }));
    claudeCodeAuthBegin()
      .then((authUrl) =>
        setState((s) => ({ ...s, phase: "awaiting-code", authUrl, signInError: null })),
      )
      .catch((err) =>
        setState((s) => ({ ...s, phase: "signed-out", signInError: errorText(err) })),
      );
  }, []);

  const completeSignIn = useCallback(
    (input: string) => {
      setState((s) => ({ ...s, phase: "completing", signInError: null }));
      claudeCodeAuthComplete(input)
        .then((auth) => {
          setState((s) => ({ ...s, phase: "ready", auth, authUrl: null, signInError: null }));
          loadUsage();
        })
        .catch((err) =>
          // Back to the code step with the input kept — the link is the same
          // one unless the error says otherwise, so the user can retry a
          // typo without starting over.
          setState((s) => ({ ...s, phase: "awaiting-code", signInError: errorText(err) })),
        );
    },
    [loadUsage],
  );

  const cancelSignIn = useCallback(() => {
    void claudeCodeAuthCancel();
    setState((s) => ({ ...s, phase: "signed-out", authUrl: null, signInError: null }));
  }, []);

  const signOut = useCallback(() => {
    claudeCodeAuthLogout()
      .then(() =>
        setState((s) => ({
          ...s,
          phase: "signed-out",
          auth: null,
          usage: null,
          usageError: null,
          signInError: null,
        })),
      )
      .catch((err) => setState((s) => ({ ...s, signInError: errorText(err) })));
  }, []);

  return { ...state, loadUsage, startSignIn, completeSignIn, cancelSignIn, signOut };
}

// ── Clipboard ────────────────────────────────────────────────────────────────

/**
 * Copy text, falling back to a selection copy where the async clipboard is
 * unavailable. Returns whether it worked, so the control can say so.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the legacy path.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
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

const WindowMeter: React.FC<{ win: ClaudeCodeUsageWindow; label: string }> = ({ win, label }) => (
  <div className="agw-codex-window">
    <div className="agw-codex-window-head">
      <span className="agw-codex-window-label">{label}</span>
      <span className="agw-codex-window-meta">{claudeCodeWindowMeta(win)}</span>
    </div>
    <Meter ratio={Math.min(100, Math.max(0, win.usedPercent)) / 100} />
  </div>
);

// ── Sign-in steps ────────────────────────────────────────────────────────────

const SignInSteps: React.FC<{
  authUrl: string;
  busy: boolean;
  error: string | null;
  onComplete: (input: string) => void;
  onCancel: () => void;
}> = ({ authUrl, busy, error, onComplete, onCancel }) => {
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const copiedTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const copyLink = async () => {
    const ok = await copyText(authUrl);
    setCopied(ok);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 2000);
    // The next thing to do is paste the code, so put the caret there.
    if (ok) codeRef.current?.focus();
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed || busy) return;
    onComplete(trimmed);
  };

  return (
    <form className="agw-atlas-body agw-codex-signin" onSubmit={submit}>
      <div className="agw-cc-steps">
        <div className="agw-cc-step">
          <span className="agw-cc-step-num" aria-hidden="true">1</span>
          <label className="agw-cc-step-label" htmlFor="agw-cc-link">
            Open this link and sign in to Claude
          </label>
          <div className="agw-cc-step-body">
            <div className="agw-cc-field">
              <AgwTextInput
                id="agw-cc-link"
                value={authUrl}
                readOnly
                onFocus={(e) => e.currentTarget.select()}
                aria-label="Sign-in link"
              />
              <div className="agw-cc-field-actions">
                <AgwButton icon="copy" onClick={() => void copyLink()}>
                  {copied ? <span className="agw-cc-copied">Copied</span> : "Copy link"}
                </AgwButton>
                <a
                  className="agw-prov-icon-btn"
                  href={authUrl}
                  target="_blank"
                  rel="noreferrer"
                  title="Open the link in your browser"
                  aria-label="Open the link in your browser"
                >
                  <AgentIcon name="external" size={14} />
                </a>
              </div>
            </div>
          </div>
        </div>

        <div className="agw-cc-step">
          <span className="agw-cc-step-num" aria-hidden="true">2</span>
          <label className="agw-cc-step-label" htmlFor="agw-cc-code">
            Paste the code the page shows
          </label>
          <div className="agw-cc-step-body">
            <div className="agw-cc-field">
              <AgwTextInput
                id="agw-cc-code"
                ref={codeRef}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Code, or the full address the page sent you to"
                disabled={busy}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "agw-cc-code-error" : undefined}
              />
            </div>
            {error && (
              <div id="agw-cc-code-error" className="agw-codex-note" data-tone="error">
                {error}
              </div>
            )}
            <div className="agw-cc-hint">
              The code is only good for this link. If you start over, use the new link.
            </div>
          </div>
        </div>
      </div>

      <div className="agw-codex-actions">
        <AgwButton variant="primary" type="submit" disabled={busy || !code.trim()}>
          {busy ? "Signing in…" : "Finish sign-in"}
        </AgwButton>
        <AgwButton onClick={onCancel} disabled={busy}>
          Cancel
        </AgwButton>
      </div>
    </form>
  );
};

// ── Card ─────────────────────────────────────────────────────────────────────

export const ClaudeCodeProviderCard: React.FC<{
  enabled: boolean;
  onToggleEnabled: (next: boolean) => void;
}> = ({ enabled, onToggleEnabled }) => {
  const {
    phase,
    auth,
    authUrl,
    usage,
    usageError,
    usageLoading,
    signInError,
    error,
    loadUsage,
    startSignIn,
    completeSignIn,
    cancelSignIn,
    signOut,
  } = useClaudeCode();
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  const plan = claudeCodePlanLabel(auth?.plan);
  const who = auth?.email || auth?.displayName || null;
  const signingIn = phase === "awaiting-code" || phase === "completing";

  return (
    <section className="agw-atlas" aria-label="Claude Code sign-in and usage">
      <div className="agw-atlas-head">
        <ProviderAvatar provider={{ id: "claude-code", name: "Claude Code" }} />
        <div className="agw-atlas-head-titles">
          <div className="agw-atlas-title">
            Claude Code
            {/* The plan is a fact about the account — the quiet plan colour.
                "Can't chat" is a live problem the user has to act on, which
                is what a chip is for. */}
            {phase === "ready" && plan && <span className="agw-sub-plan">{plan}</span>}
            {phase === "ready" && auth && !auth.canInfer && (
              <AgwPill tone="warning">Can't chat</AgwPill>
            )}
          </div>
          <div className="agw-atlas-sub">
            {phase === "ready" && (who ? `Signed in as ${who}` : "Signed in to Claude")}
            {phase === "signed-out" && "Uses your Claude Pro or Max plan — no API key"}
            {phase === "awaiting-code" && "Waiting for the code from the sign-in page"}
            {phase === "completing" && "Checking the code…"}
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
            href={CLAUDE_CODE_USAGE_URL}
            target="_blank"
            rel="noreferrer"
            title="Open usage on claude.ai"
            aria-label="Open usage on claude.ai"
          >
            <AgentIcon name="external" size={14} />
          </a>
          <span className="agw-atlas-head-sep" aria-hidden="true" />
          <AgwSwitch checked={enabled} onChange={onToggleEnabled} ariaLabel="Enable Claude Code" />
        </div>
      </div>

      {phase === "loading" && (
        <div className="agw-atlas-body">
          <div className="agw-atlas-skeleton" />
          <div className="agw-atlas-skeleton" style={{ width: "72%" }} />
        </div>
      )}

      {phase === "error" && (
        <div className="agw-atlas-error">
          <span>{error}</span>
        </div>
      )}

      {phase === "signed-out" && (
        <div className="agw-atlas-body agw-codex-signin">
          <div className="agw-atlas-hint">
            Chat with Claude Sonnet 5, Opus 5 and Fable 5.1 on your Claude Pro or
            Max plan. Sign in once; Aurora keeps its own copy of the sign-in and
            never touches what Claude Code stores on this machine.
          </div>
          {signInError && (
            <div className="agw-codex-note" data-tone="error">
              {signInError}
            </div>
          )}
          <div className="agw-codex-actions">
            <AgwButton variant="primary" onClick={startSignIn}>
              Sign in with Claude
            </AgwButton>
          </div>
        </div>
      )}

      {signingIn && authUrl && (
        <SignInSteps
          authUrl={authUrl}
          busy={phase === "completing"}
          error={signInError}
          onComplete={completeSignIn}
          onCancel={cancelSignIn}
        />
      )}

      {phase === "ready" && (
        <div className="agw-atlas-body">
          {auth && !auth.canInfer && (
            <div className="agw-codex-note" data-tone="error">
              This sign-in was granted without chat access, so requests will be
              refused. Sign out and sign in again, approving everything the page
              asks for.
            </div>
          )}

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
            <div className="agw-cc-windows">
              {usage.fiveHour && <WindowMeter win={usage.fiveHour} label="5-hour limit" />}
              {usage.sevenDay && <WindowMeter win={usage.sevenDay} label="Weekly limit" />}
              {usage.sevenDayOpus && (
                <WindowMeter win={usage.sevenDayOpus} label="Weekly limit · Opus" />
              )}
              {usage.sevenDaySonnet && (
                <WindowMeter win={usage.sevenDaySonnet} label="Weekly limit · Sonnet" />
              )}
              {!usage.fiveHour && !usage.sevenDay && (
                <div className="agw-atlas-note">
                  No usage reported yet — limits appear after your first chat.
                </div>
              )}
              {usage.extraUsage?.enabled && usage.extraUsage.usedCredits != null && (
                <div className="agw-atlas-note">
                  Extra usage on: {usage.extraUsage.usedCredits.toLocaleString()}
                  {usage.extraUsage.monthlyLimit != null &&
                    ` of ${usage.extraUsage.monthlyLimit.toLocaleString()}`}{" "}
                  credits used this month.
                </div>
              )}
            </div>
          )}

          <div className="agw-codex-foot">
            {usage && (
              <span className="agw-atlas-updated">Updated {fmtRelative(usage.fetchedAtMs)} ago</span>
            )}
            <span className="agw-codex-foot-spacer" />
            {confirmingSignOut ? (
              <span className="agw-codex-confirm">
                Removes the sign-in from Aurora. Claude Code on this machine keeps
                its own.
                <button
                  type="button"
                  className="agw-codex-link"
                  data-tone="danger"
                  onClick={() => {
                    setConfirmingSignOut(false);
                    signOut();
                  }}
                >
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

export default ClaudeCodeProviderCard;
