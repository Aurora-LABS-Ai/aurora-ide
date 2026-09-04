/**
 * Agent Window — Command Code provider card.
 *
 * Below this card everything is ordinary: the standard connection fields hold
 * the key, and the standard Models section edits, prices and deletes the
 * catalog with the same controls every other provider's models use.
 *
 * This card carries what is different about a **subscription**:
 *
 * 1. **How much of the plan is left.** Command Code meters spend against two
 *    rolling dollar caps, and both are shown rather than the tighter one:
 *    spending the weekly cap on a Tuesday and spending the five-hour cap for
 *    the next forty minutes are different problems with different answers.
 *    The credit balance leads, because that is the number that decides whether
 *    work can continue at all once the plan allowance is gone.
 * 2. **Where the key comes from.** Pasted into the row, or read from
 *    `~/.commandcode/auth.json`. Which one is live changes what to do next,
 *    and naming the account answers the question a surprise charge raises.
 * 3. **One button to add the catalog**, so nobody types seventy ids by hand.
 *
 * Reuses the `.agw-atlas-*` presentation family (hero, meters, head) so this,
 * the Codex card and the OpenCode card read as one system.
 */

import React, { useCallback, useEffect, useState } from "react";

import {
  commandCodeMoney,
  commandCodeResetLabel,
  commandCodeSignIn,
  commandCodeSignOut,
  commandCodeWindowRatio,
  fetchCommandCodeStatus,
  fetchCommandCodeUsage,
  importCommandCodeModels,
  COMMANDCODE_PROVIDER_ID,
  COMMANDCODE_STUDIO_URL,
  type CommandCodeAuthStatus,
  type CommandCodeUsageSnapshot,
  type CommandCodeWindow,
} from "@/apps/agent/services/providers/commandcode";
import { AgentIcon } from "../shared/AgentIcon";
import { ProviderAvatar } from "./ProviderAvatar";
import { AgwButton, AgwPill, AgwSwitch } from "./primitives";

/** A filled bar reads as pressure, so the tone has to match the reading. */
function toneFor(ratio: number): "accent" | "warn" | "danger" {
  if (ratio > 0.9) return "danger";
  if (ratio > 0.7) return "warn";
  return "accent";
}

const WindowMeter: React.FC<{ label: string; win: CommandCodeWindow }> = ({ label, win }) => {
  const ratio = commandCodeWindowRatio(win);
  const reset = commandCodeResetLabel(win);
  return (
    <div className="agw-opencode-window">
      <div className="agw-opencode-window-head">
        <span className="agw-opencode-window-label">{label}</span>
        <span className="agw-opencode-window-meta">
          {commandCodeMoney(win.used)} of {commandCodeMoney(win.cap)}
          {reset ? ` · ${reset}` : ""}
        </span>
      </div>
      <div className="agw-atlas-meter">
        <div
          className="agw-atlas-meter-fill"
          data-tone={toneFor(ratio)}
          // A hairline at zero, so the track reads as a meter that has not
          // moved rather than as one that failed to render.
          style={{ width: `${Math.max(ratio * 100, 1).toFixed(1)}%` }}
        />
      </div>
    </div>
  );
};

function renewalLabel(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  return at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const CommandCodeProviderCard: React.FC<{
  apiKey: string;
  enabled: boolean;
  onToggleEnabled: (next: boolean) => void;
}> = ({ apiKey, enabled, onToggleEnabled }) => {
  // `undefined` while the first read is in flight, so the card shows nothing
  // rather than flashing "not connected" at someone who is.
  const [status, setStatus] = useState<CommandCodeAuthStatus | undefined>(undefined);
  const [usage, setUsage] = useState<CommandCodeUsageSnapshot | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [busy, setBusy] = useState<"signin" | "signout" | "import" | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const key = apiKey.trim();
  const connected = Boolean(key) || status?.signedIn === true;
  /** Which key a request sends. The pasted one wins. */
  const source = key ? "pasted" : status?.signedIn ? "cli" : "none";

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await fetchCommandCodeStatus());
    } catch (err) {
      setStatus(undefined);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadUsage = useCallback(async () => {
    if (!connected) {
      setUsage(null);
      setUsageError(null);
      return;
    }
    setUsageLoading(true);
    try {
      setUsage(await fetchCommandCodeUsage(key));
      setUsageError(null);
    } catch (err) {
      setUsage(null);
      setUsageError(err instanceof Error ? err.message : String(err));
    } finally {
      setUsageLoading(false);
    }
  }, [connected, key]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const signIn = async () => {
    setBusy("signin");
    setError(null);
    setNote(null);
    try {
      setStatus(await commandCodeSignIn());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const signOut = async () => {
    setBusy("signout");
    setError(null);
    setNote(null);
    try {
      setStatus(await commandCodeSignOut());
      setUsage(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setConfirmSignOut(false);
    }
  };

  const addModels = async () => {
    setBusy("import");
    setError(null);
    setNote(null);
    try {
      const { added, skipped } = await importCommandCodeModels(key);
      setNote(
        added === 0
          ? `All ${skipped} models are already listed below.`
          : `Added ${added} model${added === 1 ? "" : "s"} below. Remove any you don't want.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const account = usage?.accountEmail ?? usage?.accountName ?? status?.userName ?? null;
  const creditsLeft = usage
    ? usage.credits.monthly + usage.credits.purchased + usage.credits.free
    : null;
  const renews = renewalLabel(usage?.renewsAt ?? null);
  const capped = Boolean(usage?.fiveHour?.exceeded || usage?.weekly?.exceeded);

  return (
    <section className="agw-atlas" aria-label="Command Code">
      <div className="agw-atlas-head">
        <ProviderAvatar provider={{ id: COMMANDCODE_PROVIDER_ID, name: "Command Code" }} />
        <div className="agw-atlas-head-titles">
          <div className="agw-atlas-title">
            Command Code
            {/* The plan is a fact about the account, so it gets the quiet
                treatment. "Cap reached" keeps a real badge: it is a live
                status the user has to act on. */}
            {usage?.planLabel && <span className="agw-sub-plan">{usage.planLabel}</span>}
            {capped && <AgwPill tone="warning">Cap reached</AgwPill>}
          </div>
          <div className="agw-atlas-sub">
            {source === "none"
              ? "Connect an account to load its models"
              : account
                ? `Signed in as ${account}`
                : source === "cli"
                  ? "Using the key from your Command Code CLI"
                  : "Using the key below"}
          </div>
        </div>
        <div className="agw-atlas-head-actions">
          {connected && (
            <button
              type="button"
              className="agw-prov-icon-btn"
              title="Refresh plan usage"
              aria-label="Refresh plan usage"
              onClick={() => void loadUsage()}
            >
              <AgentIcon name="retry" size={14} />
            </button>
          )}
          <a
            className="agw-prov-icon-btn"
            href={COMMANDCODE_STUDIO_URL}
            target="_blank"
            rel="noreferrer"
            title="Open your Command Code dashboard"
            aria-label="Open your Command Code dashboard"
          >
            <AgentIcon name="external" size={14} />
          </a>
          <span className="agw-atlas-head-sep" aria-hidden="true" />
          <AgwSwitch
            checked={enabled}
            onChange={onToggleEnabled}
            ariaLabel="Enable Command Code"
          />
        </div>
      </div>

      <div className="agw-atlas-body agw-opencode-body">
        {!connected ? (
          <div className="agw-opencode-connect">
            <p>
              One subscription covering DeepSeek, GLM, Kimi, MiniMax and Qwen,
              with Claude, GPT and Gemini on the higher plans.
            </p>
            <p>
              Paste a key from your dashboard into the API key field below, or
              sign in here and Aurora will store it where the Command Code CLI
              keeps yours.
            </p>
            <AgwButton
              variant="primary"
              icon="plug"
              onClick={() => void signIn()}
              disabled={busy !== null}
            >
              {busy === "signin" ? "Waiting for your browser…" : "Sign in to Command Code"}
            </AgwButton>
            {status && !status.cliInstalled && status.authPath && (
              <p className="agw-opencode-hint">
                No Command Code sign-in found. Looked in <code>{status.authPath}</code>.
              </p>
            )}
          </div>
        ) : (
          <>
            {usageError ? (
              <div className="agw-opencode-error" role="status">
                {usageError}
              </div>
            ) : usage ? (
              <>
                {/* What is LEFT leads. Spend is on the meters below; only one
                    of the two answers "can I keep going". */}
                <div className="agw-atlas-hero">
                  <div className="agw-atlas-hero-main">
                    <div className="agw-atlas-hero-num">
                      {commandCodeMoney(creditsLeft ?? 0)}
                    </div>
                    <div className="agw-atlas-hero-unit">
                      credits left{renews ? ` · renews ${renews}` : ""}
                      {usage.cancelAtPeriodEnd ? " · ends then" : ""}
                    </div>
                  </div>
                </div>

                {usage.limited ? (
                  <div className="agw-opencode-windows">
                    {usage.fiveHour && (
                      <WindowMeter label="Right now" win={usage.fiveHour} />
                    )}
                    {usage.weekly && <WindowMeter label="This week" win={usage.weekly} />}
                  </div>
                ) : (
                  <div className="agw-atlas-hint">
                    This plan reports no spend windows, so there is no cap to
                    show. Credits are the only limit.
                  </div>
                )}
              </>
            ) : usageLoading ? (
              <div className="agw-atlas-skeleton" />
            ) : null}

            {source === "cli" && (
              <div className="agw-opencode-connect">
                {/* The consequence rides on the confirm, not on the card. It
                    only matters at the moment of the click, and as permanent
                    text it was three lines explaining a button that already
                    says what it does. */}
                <AgwButton
                  icon="close"
                  onClick={() => (confirmSignOut ? void signOut() : setConfirmSignOut(true))}
                  disabled={busy !== null}
                >
                  {busy === "signout"
                    ? "Signing out…"
                    : confirmSignOut
                      ? "Sign out here and in the CLI?"
                      : "Sign out"}
                </AgwButton>
              </div>
            )}

            {/* Saves typing seventy ids by hand. Everything after this happens
                in the standard Models section below. */}
            <div className="agw-opencode-import">
              <AgwButton icon="plus" onClick={() => void addModels()} disabled={busy !== null}>
                {busy === "import" ? "Adding…" : "Add Command Code models"}
              </AgwButton>
              <span>
                {note ??
                  "Adds every model in the catalog to the list below. Models above your plan stay listed and say so when used."}
              </span>
            </div>
          </>
        )}

        {error && (
          <div className="agw-opencode-error" role="status">
            {error}
          </div>
        )}
      </div>
    </section>
  );
};
