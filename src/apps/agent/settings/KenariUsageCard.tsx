/**
 * Agent Window — kenari plan card (view).
 *
 * Rendered as the identity block in the Providers detail pane for kenari,
 * replacing the generic name/type head the way Atlas, Codex, Cursor and
 * OpenCode do. The connection fields and the standard Models section still
 * render below it — kenari has a real key and real models to edit, unlike
 * Codex.
 *
 * Reuses the `.agw-atlas-*` presentation family so all the subscription cards
 * read as one system; kenari-only bits are `.agw-kenari-*`.
 *
 * The quota is read with the API key (`GET /v1/account/quota`, documented by
 * kenari on 2026-10-26). Until then the key could not read the account and
 * this card asked for a browser sign-in beside a working key; that is gone.
 *
 * ## Why the bar matters more here than on the other cards
 *
 * On a subscription that runs out, kenari does not fall through to the balance
 * — it REFUSES the request with `429 plan_limit_reached`, and that applies to
 * every endpoint, not just chat. So this is not a cost readout. It is the
 * distance to a hard stop, in Rupiah.
 */

import React, { useCallback, useEffect, useState } from "react";

import {
  fetchKenariUsage,
  fmtRupiah,
  kenariResetLabel,
  KENARI_WINDOWS,
  type KenariUsage,
} from "@/apps/agent/services/providers/kenari";
import { fmtRelative } from "@/apps/agent/services/providers/atlascloud";
import { AgentIcon } from "../shared/AgentIcon";
import { ProviderAvatar } from "./ProviderAvatar";
import { AgwPill, AgwSwitch } from "./primitives";

/** Where a person goes to see the same numbers on kenari's own page. */
const KENARI_USAGE_URL = "https://kenari.id/usage";

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
  /** The row's key, which reads the quota as well as serving chat. */
  apiKey: string;
  enabled: boolean;
  onToggleEnabled: (next: boolean) => void;
}> = ({ apiKey, enabled, onToggleEnabled }) => {
  const [usage, setUsage] = useState<KenariUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);

  const key = apiKey.trim();

  const loadUsage = useCallback(async () => {
    if (!key) return;
    setLoading(true);
    try {
      const next = await fetchKenariUsage(key);
      setUsage(next);
      setFetchedAt(next.fetchedAtMs);
      setError(null);
    } catch (err) {
      // A shared or restricted key is refused here with a reason. Reported
      // rather than swallowed, because the card's whole job is to say why the
      // bar is gone.
      setUsage(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [key]);

  // Guarded rather than fire-and-forget: the pane is a list someone clicks
  // through, so this component mounts and unmounts freely and a read can
  // outlive the row that started it. Re-read when the key changes: a pasted
  // key is a different account.
  useEffect(() => {
    let alive = true;
    if (!key) {
      setUsage(null);
      setError(null);
      setFetchedAt(null);
      return;
    }
    setLoading(true);
    void fetchKenariUsage(key)
      .then((next) => {
        if (!alive) return;
        setUsage(next);
        setFetchedAt(next.fetchedAtMs);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setUsage(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [key]);

  const noWindows = usage && !usage.window5h && !usage.windowWeek && !usage.windowMonth;

  return (
    <section className="agw-atlas" aria-label="kenari plan usage">
      <div className="agw-atlas-head">
        <ProviderAvatar provider={{ id: "kenari", name: "kenari" }} />
        <div className="agw-atlas-head-titles">
          <div className="agw-atlas-title">
            kenari
            {/* The plan is a fact about the account, set in the success colour
                and nothing more. `nearLimit` keeps a real badge: that one is a
                live status the person has to act on. */}
            {usage?.planName && <span className="agw-sub-plan">{usage.planName}</span>}
            {usage?.nearLimit && <AgwPill tone="warning">Near limit</AgwPill>}
          </div>
          <div className="agw-atlas-sub">
            {!key && "Add your API key to see how much of the plan is left"}
            {key && loading && !usage && "Reading plan quota…"}
            {key && !loading && usage && "Plan quota, read with your API key"}
            {key && !loading && !usage && error && "Plan quota could not be read"}
          </div>
        </div>
        <div className="agw-atlas-head-actions">
          {key && (
            <button
              type="button"
              className="agw-prov-icon-btn"
              title="Refresh plan usage"
              aria-label="Refresh plan usage"
              disabled={loading}
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

      {key && loading && !usage && !error && (
        <div className="agw-atlas-body">
          <div className="agw-atlas-skeleton" />
          <div className="agw-atlas-skeleton" style={{ width: "72%" }} />
        </div>
      )}

      {key && error && !usage && (
        <div className="agw-atlas-body">
          {/* Said in kenari's own terms: a shared or restricted key cannot
              read the account, and the fix is a different key, not a retry. */}
          <div className="agw-atlas-error">
            <span>{error}</span>
            <button
              type="button"
              className="agw-atlas-retry"
              disabled={loading}
              onClick={() => void loadUsage()}
            >
              <AgentIcon name="retry" size={13} /> Try again
            </button>
          </div>
        </div>
      )}

      {usage && (
        <div className="agw-atlas-body">
          <div className="agw-kenari-windows">
            {/* Only the windows this plan actually caps. The endpoint leaves an
                uncapped window out, and drawing it would render "no limit" as
                a bar that is 100% spent. */}
            {KENARI_WINDOWS.map(({ key: windowKey, label }) => {
              const win = usage[windowKey];
              if (!win) return null;
              const caption = [
                win.remainingRp != null && win.budgetRp != null
                  ? `${fmtRupiah(win.remainingRp)} of ${fmtRupiah(win.budgetRp)} left`
                  : null,
                kenariResetLabel(win),
              ]
                .filter((p): p is string => p !== null)
                .join(" · ");
              return (
                <WindowMeter key={windowKey} label={label} used={win.usedFrac} caption={caption || null} />
              );
            })}

            {/* A coupon is spent apart from the plan and can outlive it, so it
                is its own line rather than a window. */}
            {usage.coupon && (
              <div className="agw-kenari-window">
                <div className="agw-kenari-window-head">
                  <span className="agw-kenari-window-label">
                    {usage.coupon.name ? `Coupon · ${usage.coupon.name}` : "Coupon"}
                  </span>
                  <span className="agw-kenari-window-meta">
                    {usage.coupon.remainingRp != null
                      ? `${fmtRupiah(usage.coupon.remainingRp)} left`
                      : "No spending limit"}
                    {usage.coupon.expiresAtMs
                      ? ` · expires ${new Date(usage.coupon.expiresAtMs).toLocaleDateString()}`
                      : ""}
                  </span>
                </div>
              </div>
            )}

            {/* A plan with no window at all would otherwise render an empty
                body that reads as a loading state that never finished. */}
            {noWindows && !usage.coupon && (
              <div className="agw-atlas-note">
                {usage.planName
                  ? "This plan sets no quota window — usage is billed from your balance."
                  : "No active plan — usage is billed from your balance."}
              </div>
            )}
          </div>

          <div className="agw-kenari-foot">
            {fetchedAt && (
              <span className="agw-atlas-updated">Updated {fmtRelative(fetchedAt)} ago</span>
            )}
            {usage.alertPct != null && (
              <span className="agw-kenari-note">Your quota alert fires at {usage.alertPct}%</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
};

export default KenariUsageCard;
