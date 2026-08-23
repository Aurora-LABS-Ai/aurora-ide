/**
 * Agent Window — kenari plan card (view).
 *
 * Rendered as the identity block in the Providers detail pane for kenari,
 * replacing the generic name/type head the way Atlas, Codex, Cursor and
 * OpenCode do. The connection fields and the standard Models section still
 * render below it — kenari has a real key and real models to edit, unlike
 * Codex.
 *
 * Reuses the `.agw-atlas-*` presentation family so all five subscription cards
 * read as one system; kenari-only bits are `.agw-kenari-*`.
 *
 * ## Why this card asks for a sign-in next to a working API key
 *
 * Because the key does not reach the account. kenari's `kn-` key drives the
 * models and nothing else: the quota window, the reset clock and the
 * web-search allowance live on the dashboard's `/api/*` surface, which answers
 * `401 no session` to that key however it is presented — as a bearer token, as
 * `x-api-key`, as a cookie. Their own CLI agrees: it contains three kenari URLs
 * and no usage command, and a key minted by `kenari login` is refused by the
 * same endpoints as a hand-made one.
 *
 * kenari's MCP server does expose a key-authenticated `kenari_usage`, and it is
 * genuinely useful — but it reports 30 days of per-model tokens with a WALLET
 * cost that is `Rp 0` for every plan-billed request. It cannot say how much of
 * the window is gone, which is the only number this card exists to show.
 *
 * ## Why the bar matters more here than on the other cards
 *
 * On a subscription that runs out, kenari does not fall through to the balance
 * — it REFUSES the request with `429 plan_limit_reached`, and that applies to
 * every endpoint, not just chat. So this is not a cost readout. It is the
 * distance to a hard stop.
 */

import React, { useCallback, useEffect, useState } from "react";

import {
  fetchKenariUsage,
  kenariConnect,
  kenariDisconnect,
  kenariResetLabel,
  kenariSessionStatus,
  KENARI_WINDOWS,
  type KenariUsage,
} from "@/apps/agent/services/providers/kenari";
import { fmtRelative } from "@/apps/agent/services/providers/atlascloud";
import { AgentIcon } from "../shared/AgentIcon";
import { ProviderAvatar } from "./ProviderAvatar";
import { AgwButton, AgwPill, AgwSwitch } from "./primitives";

/** Where a person goes to see the same numbers on kenari's own page. */
const KENARI_USAGE_URL = "https://kenari.id/usage";

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

/** One row: what the window is, how much of it is gone, when it refills. */
const WindowMeter: React.FC<{ label: string; used: number; caption: string | null }> = ({
  label,
  used,
  caption,
}) => (
  <div className="agw-kenari-window">
    <div className="agw-kenari-window-head">
      <span className="agw-kenari-window-label">{label}</span>
      <span className="agw-kenari-window-meta">
        {Math.round(used * 100)}% used
        {caption ? ` · ${caption}` : ""}
      </span>
    </div>
    <Meter ratio={used} />
  </div>
);

export const KenariUsageCard: React.FC<{
  enabled: boolean;
  onToggleEnabled: (next: boolean) => void;
}> = ({ enabled, onToggleEnabled }) => {
  const [phase, setPhase] = useState<Phase>("loading");
  const [email, setEmail] = useState<string | null>(null);
  const [usage, setUsage] = useState<KenariUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  const loadUsage = useCallback(async () => {
    try {
      setUsage(await fetchKenariUsage());
      setFetchedAt(Date.now());
      setError(null);
    } catch (err) {
      // A session that has expired is refused here first. Reported rather than
      // swallowed, because the card's whole job is to say why the bar is gone.
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
      const status = await kenariSessionStatus();
      if (!alive) return;
      setEmail(status.email);
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
      const account = await kenariConnect();
      setEmail(account.email);
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
    await kenariDisconnect();
    setConfirmingSignOut(false);
    setEmail(null);
    setUsage(null);
    setError(null);
    setPhase("signed-out");
  };

  return (
    <section className="agw-atlas" aria-label="kenari plan usage">
      <div className="agw-atlas-head">
        <ProviderAvatar provider={{ id: "kenari", name: "kenari" }} />
        <div className="agw-atlas-head-titles">
          <div className="agw-atlas-title">
            kenari
            {/* The plan is a fact about the account, set in the success colour
                and nothing more. `near_limit` keeps a real badge: that one is a
                live status the person has to act on. */}
            {phase === "connected" && usage?.planName && (
              <span className="agw-sub-plan">{usage.planName}</span>
            )}
            {phase === "connected" && usage?.nearLimit && (
              <AgwPill tone="warning">Near limit</AgwPill>
            )}
          </div>
          <div className="agw-atlas-sub">
            {phase === "connected" && (email ? `Signed in as ${email}` : "Signed in")}
            {phase === "signed-out" && "Quota is only reported to a signed-in browser"}
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
            href={KENARI_USAGE_URL}
            target="_blank"
            rel="noreferrer"
            title="Open your kenari usage page"
            aria-label="Open your kenari usage page"
          >
            <AgentIcon name="external" size={14} />
          </a>
          <span className="agw-atlas-head-sep" aria-hidden="true" />
          <AgwSwitch checked={enabled} onChange={onToggleEnabled} ariaLabel="Enable kenari" />
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
            Your API key runs the models but cannot read the account — kenari
            reports quota only to a signed-in browser. Sign in to see how much
            of the weekly window is left before requests start being refused.
            Aurora opens kenari's own page and never sees your password.
          </div>
          {error && (
            <div className="agw-kenari-note" data-tone="error">
              {error}
            </div>
          )}
          <div className="agw-kenari-actions">
            <AgwButton variant="primary" icon="plug" onClick={() => void connect()}>
              Sign in to kenari
            </AgwButton>
          </div>
        </div>
      )}

      {phase === "connecting" && (
        <div className="agw-atlas-body agw-kenari-signin">
          <div className="agw-atlas-hint">
            Finish signing in to kenari in the window that opened. This card
            updates on its own once you're done. Close that window to cancel.
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
              {/* Only the windows this plan actually sets. A plan reports an
                  absent cap as null, and drawing it would render "no limit" as
                  a bar that is 100% spent. */}
              {KENARI_WINDOWS.map(({ key, label }) => {
                const win = usage[key];
                if (!win) return null;
                return (
                  <WindowMeter
                    key={key}
                    label={label}
                    used={win.usedFrac}
                    caption={kenariResetLabel(win)}
                  />
                );
              })}

              {/* Metered and reset separately from the quota windows, so plan
                  quota left says nothing about this. Counts as well as a bar —
                  "163 left" is the number someone acts on, where a percentage
                  of 200 is arithmetic. */}
              {usage.webSearchAllowance != null && usage.webSearchAllowance > 0 && (
                <WindowMeter
                  label="Web searches today"
                  used={(usage.webSearchUsedToday ?? 0) / usage.webSearchAllowance}
                  caption={`${Math.max(
                    0,
                    usage.webSearchAllowance - (usage.webSearchUsedToday ?? 0),
                  )} of ${usage.webSearchAllowance} left`}
                />
              )}

              {/* A plan with no window at all would otherwise render an empty
                  body that reads as a loading state that never finished. */}
              {!usage.window5h && !usage.windowWeek && !usage.windowMonth && (
                <div className="agw-atlas-note">
                  This plan sets no quota window — usage is billed from your
                  balance.
                </div>
              )}
            </div>
          )}

          <div className="agw-kenari-foot">
            {fetchedAt && (
              <span className="agw-atlas-updated">Updated {fmtRelative(fetchedAt)} ago</span>
            )}
            <span className="agw-kenari-foot-spacer" />
            {/* Two-click, and it names what is actually lost. "Sign out" beside
                a provider reads as though it might break the key that drives
                every turn, and it does not. */}
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

export default KenariUsageCard;
