/**
 * Agent Window — Volcano Ark Coding Plan card (view).
 *
 * Rendered as the identity block in the Providers detail pane for Ark,
 * replacing the generic name/type head the way Atlas, Codex, Cursor, OpenCode
 * and kenari do. The connection fields and the standard Models section still
 * render below it: Ark has a real key and eleven real models to edit.
 *
 * Reuses the `.agw-atlas-*` presentation family and the `.agw-kenari-*` sign-in
 * bits rather than adding a parallel `.agw-ark-*` set of identical rules. Those
 * classes are named for the card that first needed them, but what they describe
 * is "a subscription card whose quota comes from a browser session", which is
 * exactly this. A second copy would drift.
 *
 * ## Why this card asks for a sign-in next to a working API key
 *
 * Because the key does not reach the account. The `ark-` key drives the models
 * on `/api/coding/v3` and nothing else; presented to Volcano's control plane it
 * is refused before the account is looked up. The documented quota read is a
 * control-plane action signed with an Access Key pair, and creating one of
 * those requires Volcano's real-name verification, which wants Chinese identity
 * documents — so for a lot of accounts the documented route does not exist.
 *
 * The console's own proxy takes a session instead of a signature, which is what
 * this card connects to. See `commands/ark.rs`.
 *
 * ## Why the bars matter
 *
 * The plan meters three windows and stops serving when one is spent — the quota
 * does not fall through to pay-as-you-go credit. So this is not a cost readout.
 * It is the distance to a hard stop, in the only unit Volcano publishes: a
 * share. There is no request count anywhere in the API to show instead.
 */

import React, { useCallback, useEffect, useState } from "react";

import {
  arkConnect,
  arkDisconnect,
  arkResetLabel,
  arkSessionStatus,
  arkTierLabel,
  ARK_WINDOWS,
  fetchArkUsage,
  type ArkUsage,
} from "@/apps/agent/services/providers/ark";
import { fmtRelative } from "@/apps/agent/services/providers/atlascloud";
import { AgentIcon } from "../shared/AgentIcon";
import { ProviderAvatar } from "./ProviderAvatar";
import { AgwButton, AgwPill, AgwSwitch } from "./primitives";

/** Where a person sees the same numbers on Volcano's own page. */
const ARK_CONSOLE_URL =
  "https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan";

type Phase =
  | "loading" // probing for a stored session
  | "signed-out"
  | "connecting" // the sign-in window is open
  | "connected";

/** A percentage bar reads as pressure, so the tone has to match the reading. */
const Meter: React.FC<{ ratio: number }> = ({ ratio }) => (
  <div className="agw-atlas-meter">
    <span
      className="agw-atlas-meter-fill"
      data-tone={ratio > 0.9 ? "danger" : ratio > 0.7 ? "warn" : "accent"}
      style={{ width: `${Math.min(100, Math.max(0, ratio * 100)).toFixed(1)}%` }}
    />
  </div>
);

/**
 * A used-percentage, worded so a barely-touched window does not read as zero.
 *
 * Volcano's figures start very small — a real reading is `0.104%` of the month
 * — and rounding that to a whole number prints `0% used` over a plan that has
 * genuinely been used. One decimal below 10%, whole numbers above it, where the
 * decimal would be noise.
 */
function usedLabel(percent: number): string {
  if (percent > 0 && percent < 0.1) return "<0.1% used";
  if (percent < 10) return `${percent.toFixed(1)}% used`;
  return `${Math.round(percent)}% used`;
}

/** One row: what the window is, how much of it is gone, when it refills. */
const WindowMeter: React.FC<{
  label: string;
  percent: number;
  caption: string | null;
}> = ({ label, percent, caption }) => (
  <div className="agw-kenari-window">
    <div className="agw-kenari-window-head">
      <span className="agw-kenari-window-label">{label}</span>
      <span className="agw-kenari-window-meta">
        {usedLabel(percent)}
        {caption ? ` · ${caption}` : ""}
      </span>
    </div>
    <Meter ratio={percent / 100} />
  </div>
);

/** `2026-10-11T15:59:59Z` → `11 Oct 2026`, in the reader's own locale. */
function fmtExpiry(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  return at.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export const ArkUsageCard: React.FC<{
  enabled: boolean;
  onToggleEnabled: (next: boolean) => void;
}> = ({ enabled, onToggleEnabled }) => {
  const [phase, setPhase] = useState<Phase>("loading");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [usage, setUsage] = useState<ArkUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  const loadUsage = useCallback(async () => {
    try {
      setUsage(await fetchArkUsage());
      setFetchedAt(Date.now());
      setError(null);
    } catch (err) {
      // An expired session is refused here first. Reported rather than
      // swallowed, because the card's whole job is to say why the bars are gone.
      setUsage(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Guarded rather than fire-and-forget: the pane is a list someone clicks
  // through, so this component mounts and unmounts freely and a probe can
  // outlive the row that started it.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const status = await arkSessionStatus();
      if (!alive) return;
      setAccountId(status.accountId);
      setPhase(status.connected ? "connected" : "signed-out");
      if (status.connected) await loadUsage();
    })();
    return () => {
      alive = false;
    };
  }, [loadUsage]);

  const connect = async () => {
    setPhase("connecting");
    setError(null);
    try {
      const account = await arkConnect();
      setAccountId(account.accountId);
      setPhase("connected");
      await loadUsage();
    } catch (err) {
      // Covers the ordinary endings as well as the failures — closing the
      // window is a cancellation and reads as one, rather than pretending a
      // sign-in happened.
      setError(err instanceof Error ? err.message : String(err));
      setPhase("signed-out");
    }
  };

  const disconnect = async () => {
    await arkDisconnect();
    setConfirmingSignOut(false);
    setAccountId(null);
    setUsage(null);
    setError(null);
    setPhase("signed-out");
  };

  const tier = arkTierLabel(usage?.tier ?? null);
  const expiry = fmtExpiry(usage?.expiresAt ?? null);

  return (
    <section className="agw-atlas" aria-label="Volcano Ark Coding Plan usage">
      <div className="agw-atlas-head">
        <ProviderAvatar provider={{ id: "ark", name: "Volcano Ark" }} />
        <div className="agw-atlas-head-titles">
          <div className="agw-atlas-title">
            Volcano Ark
            {/* The tier is a fact about the account, set in the success colour
                and nothing more. Bonus quota keeps a real badge: Volcano's own
                flag, and a live status worth acting on. */}
            {phase === "connected" && tier && <span className="agw-sub-plan">{tier}</span>}
            {phase === "connected" && usage?.hasReward && (
              <AgwPill tone="success">Bonus quota</AgwPill>
            )}
            {/* Volcano's own word, shown only when it is NOT the ordinary one.
                "Running" on every card is a row nobody reads by the second
                time they see it — and then it says nothing on the day the
                subscription actually lapses. */}
            {phase === "connected" &&
              usage?.status &&
              usage.status.toLowerCase() !== "running" && (
                <AgwPill tone="warning">{usage.status}</AgwPill>
              )}
          </div>
          <div className="agw-atlas-sub">
            {phase === "connected" &&
              [
                accountId ? `Account ${accountId}` : "Signed in",
                expiry ? `renews ${expiry}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            {phase === "signed-out" && "Quota is only reported to a signed-in console"}
            {phase === "connecting" && "Waiting for the sign-in window…"}
            {phase === "loading" && "Checking sign-in…"}
          </div>
        </div>
        <div className="agw-atlas-head-actions">
          {phase === "connected" && (
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
            href={ARK_CONSOLE_URL}
            target="_blank"
            rel="noreferrer"
            title="Open your Coding Plan page"
            aria-label="Open your Coding Plan page"
          >
            <AgentIcon name="external" size={14} />
          </a>
          <span className="agw-atlas-head-sep" aria-hidden="true" />
          <AgwSwitch
            checked={enabled}
            onChange={onToggleEnabled}
            ariaLabel="Enable Volcano Ark"
          />
        </div>
      </div>

      {phase === "loading" && (
        <div className="agw-atlas-body">
          <div className="agw-atlas-skeleton" />
          <div className="agw-atlas-skeleton" style={{ width: "72%" }} />
        </div>
      )}

      {phase === "signed-out" && (
        <div className="agw-atlas-body agw-kenari-signin">
          {/* Says why a second sign-in exists beside a working API key. Without
              it, this reads as Aurora asking for credentials it already has. */}
          <div className="agw-atlas-hint">
            Your API key runs the models but cannot read the account — Volcano
            reports Coding Plan quota only to a signed-in console. Sign in to see
            how much of the five-hour, weekly and monthly windows is left before
            requests start being refused. Aurora opens Volcano's own page and
            never sees your password.
          </div>
          {error && (
            <div className="agw-kenari-note" data-tone="error">
              {error}
            </div>
          )}
          <div className="agw-kenari-actions">
            <AgwButton variant="primary" icon="plug" onClick={() => void connect()}>
              Sign in to Volcano Engine
            </AgwButton>
          </div>
        </div>
      )}

      {phase === "connecting" && (
        <div className="agw-atlas-body agw-kenari-signin">
          <div className="agw-atlas-hint">
            Finish signing in to Volcano Engine in the window that opened. This
            card updates on its own once you're done. Close that window to
            cancel.
          </div>
        </div>
      )}

      {phase === "connected" && (
        <div className="agw-atlas-body">
          {error && !usage && (
            <div className="agw-atlas-error">
              <span>{error}</span>
              <button
                type="button"
                className="agw-atlas-retry"
                onClick={() => void connect()}
              >
                <AgentIcon name="plug" size={13} /> Sign in again
              </button>
            </div>
          )}

          {usage && (
            <div className="agw-kenari-windows">
              {/* Only the windows Volcano actually reported. A level it stops
                  sending goes absent rather than being drawn at zero, which
                  would claim an unmeasured window is untouched. */}
              {ARK_WINDOWS.map(({ key, label }) => {
                const win = usage[key];
                if (!win) return null;
                return (
                  <WindowMeter
                    key={key}
                    label={label}
                    percent={win.usedPercent}
                    caption={arkResetLabel(win)}
                  />
                );
              })}

              {/* An account with no window at all would otherwise render an
                  empty body that reads as a loading state that never finished. */}
              {!usage.windowSession && !usage.windowWeek && !usage.windowMonth && (
                <div className="agw-atlas-note">
                  Volcano reported no quota window for this account. Check that
                  the Coding Plan subscription is active.
                </div>
              )}
            </div>
          )}

          <div className="agw-kenari-foot">
            {fetchedAt && (
              <span className="agw-atlas-updated">Updated {fmtRelative(fetchedAt)} ago</span>
            )}
            <span className="agw-kenari-foot-spacer" />
            {/* Two-click, and it names what is actually lost. "Disconnect"
                beside a provider reads as though it might break the key that
                drives every turn, and it does not. */}
            {confirmingSignOut ? (
              <span className="agw-kenari-confirm">
                Only stops the quota readout — your key and models keep working.
                <button
                  type="button"
                  className="agw-kenari-link"
                  data-tone="danger"
                  onClick={() => void disconnect()}
                >
                  Disconnect
                </button>
                <button
                  type="button"
                  className="agw-kenari-link"
                  onClick={() => setConfirmingSignOut(false)}
                >
                  Keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="agw-kenari-link"
                onClick={() => setConfirmingSignOut(true)}
              >
                Disconnect
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
};

export default ArkUsageCard;
