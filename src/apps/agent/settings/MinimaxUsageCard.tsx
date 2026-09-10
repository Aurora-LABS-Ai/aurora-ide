/**
 * Agent Window — MiniMax Token Plan card (view).
 *
 * The identity block in the Providers detail pane for MiniMax, replacing the
 * generic name/type head the way Atlas, Codex, Cursor, OpenCode, Command Code
 * and kenari do. Reuses the `.agw-atlas-*` family so all of them read as one
 * system.
 *
 * ## Why this one needs no sign-in, unlike kenari's
 *
 * kenari's key drives the models and cannot read the account, so its card has
 * to ask for a browser session next to a working key. MiniMax's subscription
 * key is BOTH: the same `sk-cp-…` that serves chat also authenticates the quota
 * read. Verified against a live Token Plan Max account. So there is nothing to
 * connect here — paste the key on the card below and this fills in.
 *
 * ## What is drawn, and what is deliberately not
 *
 * The plan meters a rolling 5-hour window and a weekly one, and reports what is
 * REMAINING. Every meter in this family draws what is SPENT, so the numbers are
 * flipped once, here.
 *
 * Only the `general` bucket. MiniMax also meters `video`, which a coding agent
 * never spends, and a bar for it would be a number nobody using Aurora can move.
 *
 * The counts that ride alongside are ignored on purpose. On a live Max plan the
 * text bucket reports `total_count: 0` and `usage_count: 0` beside
 * `remaining_percent: 100`, because text is metered as a share while `video` is
 * the one that carries real counts — so "0 of 0" would report an untouched plan
 * as spent.
 *
 * ## The endpoint behind it is undocumented
 *
 * `GET https://www.minimax.io/v1/token_plan/remains`. MiniMax's own pages say
 * only that usage "is shown as a usage bar in the console". It was confirmed
 * against the live account before anything was built on it, but it can change
 * without notice — so a failed read says so plainly here rather than leaving an
 * empty space, which on a plan that refuses requests when it runs out would
 * read as "no limits".
 */

import React, { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchMinimaxUsage,
  minimaxGeneralQuota,
  minimaxResetLabel,
  MINIMAX_CONSOLE_URL,
  type MinimaxQuota,
} from "@/apps/agent/services/providers/minimax";
import { fmtRelative } from "@/apps/agent/services/providers/atlascloud";
import { AgentIcon } from "../shared/AgentIcon";
import { ProviderAvatar } from "./ProviderAvatar";
import { AgwPill, AgwSwitch } from "./primitives";

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
 * One window: what it is, how much is gone, when it refills.
 *
 * States what is LEFT beside the bar, because that is the number someone acts
 * on — the bar already carries "how far along" without needing a second reading
 * of the same fact.
 */
const WindowMeter: React.FC<{
  label: string;
  remainingPercent: number;
  caption: string | null;
}> = ({ label, remainingPercent, caption }) => {
  const left = Math.max(0, Math.min(100, remainingPercent));
  return (
    <div className="agw-kenari-window">
      <div className="agw-kenari-window-head">
        <span className="agw-kenari-window-label">{label}</span>
        <span className="agw-kenari-window-meta">
          {Math.round(left)}% left
          {caption ? ` · ${caption}` : ""}
        </span>
      </div>
      <Meter ratio={(100 - left) / 100} />
    </div>
  );
};

type Phase = "idle" | "loading" | "loaded" | "error";

/**
 * The read, with no React in it at all.
 *
 * Kept outside the component so the mount effect and the refresh button share
 * one copy, and so neither of them calls a function that writes state
 * synchronously — an effect that does cascades renders.
 */
async function readGeneralQuota(apiKey: string): Promise<MinimaxQuota | null> {
  return minimaxGeneralQuota(await fetchMinimaxUsage(apiKey));
}

export const MinimaxUsageCard: React.FC<{
  apiKey: string;
  enabled: boolean;
  onToggleEnabled: (next: boolean) => void;
}> = ({ apiKey, enabled, onToggleEnabled }) => {
  // Born loading when there is a key: the read starts on mount, and an "idle"
  // first paint would flash "add a key" at someone who already has one.
  const [phase, setPhase] = useState<Phase>(apiKey.trim() ? "loading" : "idle");
  const [quota, setQuota] = useState<MinimaxQuota | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  /**
   * True when the read worked and the account reported no text bucket.
   *
   * A distinct state from an error, because the answer differs: a pay-as-you-go
   * key reaches this endpoint and honestly has no plan behind it, and telling
   * that person "the read failed" would send them to fix something that is not
   * broken.
   */
  const [noPlan, setNoPlan] = useState(false);

  const key = apiKey.trim();

  /**
   * The pane is a list someone clicks through, so this component mounts and
   * unmounts freely and a read can outlive the row that started it. The ref is
   * what stops a late answer writing into a card that is gone — and it lets the
   * mount effect and the refresh button share ONE copy of the fetch, rather
   * than the two near-identical ones this had at first.
   */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** What a successful read means on screen. */
  const apply = useCallback((general: MinimaxQuota | null) => {
    if (!alive.current) return;
    setQuota(general);
    // A read that worked and found no text bucket is a pay-as-you-go key, not
    // a failure — a distinct state, because telling that person the read broke
    // sends them to fix something that is not broken.
    setNoPlan(general === null);
    setFetchedAt(Date.now());
    setError(null);
    setPhase("loaded");
  }, []);

  /** And what a failed one means. Never silent: an empty space on a plan that
   *  refuses requests when it runs out reads as "no limits". */
  const fail = useCallback((err: unknown) => {
    if (!alive.current) return;
    setQuota(null);
    setNoPlan(false);
    setError(err instanceof Error ? err.message : String(err));
    setPhase("error");
  }, []);

  // Keyed on the key itself, so pasting a different one re-reads rather than
  // leaving the previous account's numbers on screen. "Loading" is the phase
  // this component is BORN in when it has a key, so there is nothing to set on
  // the way in — the callbacks below are the only things that write state.
  useEffect(() => {
    if (!key) return;
    readGeneralQuota(key).then(apply).catch(fail);
  }, [key, apply, fail]);

  /** The refresh button: an event, so it may show "loading" before it starts. */
  const refresh = () => {
    if (!key) return;
    setPhase("loading");
    readGeneralQuota(key).then(apply).catch(fail);
  };

  // Derived, not stored: with no key there is nothing to have read, and a
  // phase written for it would be one more thing to keep in step.
  const view: Phase = key ? phase : "idle";

  return (
    <section className="agw-atlas" aria-label="MiniMax Token Plan usage">
      <div className="agw-atlas-head">
        <ProviderAvatar provider={{ id: "minimax", name: "MiniMax" }} />
        <div className="agw-atlas-head-titles">
          <div className="agw-atlas-title">
            MiniMax
            {view === "loaded" && quota && <span className="agw-sub-plan">Token Plan</span>}
            {view === "loaded" && noPlan && <AgwPill tone="neutral">Pay as you go</AgwPill>}
          </div>
          <div className="agw-atlas-sub">
            {view === "idle" && "Add a key below to see what the plan has left"}
            {view === "loading" && "Reading plan usage…"}
            {view === "loaded" && quota &&
              (fetchedAt ? `Updated ${fmtRelative(fetchedAt)}` : "Up to date")}
            {view === "loaded" && noPlan && "This key bills per token, not from a plan"}
            {view === "error" && "Could not read plan usage"}
          </div>
        </div>
        <div className="agw-atlas-head-actions">
          {key && (
            <button
              type="button"
              className="agw-prov-icon-btn"
              title="Refresh plan usage"
              aria-label="Refresh plan usage"
              onClick={refresh}
            >
              <AgentIcon name="retry" size={14} />
            </button>
          )}
          <a
            className="agw-prov-icon-btn"
            href={MINIMAX_CONSOLE_URL}
            target="_blank"
            rel="noreferrer"
            title="Open your MiniMax console"
            aria-label="Open your MiniMax console"
          >
            <AgentIcon name="external" size={14} />
          </a>
          <span className="agw-atlas-head-sep" aria-hidden="true" />
          <AgwSwitch checked={enabled} onChange={onToggleEnabled} ariaLabel="Enable MiniMax" />
        </div>
      </div>

      {view === "loading" && (
        <div className="agw-atlas-body">
          <div className="agw-atlas-skeleton" />
          <div className="agw-atlas-skeleton" style={{ width: "72%" }} />
        </div>
      )}

      {view === "idle" && (
        <div className="agw-atlas-body">
          <div className="agw-atlas-hint">
            Your Token Plan key is also your account key — paste it below and this
            fills in. On a plan, running out does not fall through to
            pay-as-you-go: requests are refused until the window resets, so these
            two bars are the distance to a hard stop.
          </div>
        </div>
      )}

      {view === "error" && (
        <div className="agw-atlas-body">
          <div className="agw-atlas-error">
            <span>{error}</span>
            <button type="button" className="agw-atlas-retry" onClick={refresh}>
              <AgentIcon name="retry" size={13} /> Try again
            </button>
          </div>
        </div>
      )}

      {view === "loaded" && noPlan && (
        <div className="agw-atlas-body">
          <div className="agw-atlas-hint">
            This key works and has no subscription behind it, so there is no window
            to run out of — usage is billed per token. A Token Plan key shows its
            5-hour and weekly windows here.
          </div>
        </div>
      )}

      {view === "loaded" && quota && (
        <div className="agw-atlas-body">
          <div className="agw-kenari-windows">
            {/* Both windows, not the tighter one: running out for the next few
                hours and running out for the week are different problems, and a
                single blended figure hides which one you are in. */}
            <WindowMeter
              label="Right now"
              remainingPercent={quota.intervalRemainingPercent}
              caption={minimaxResetLabel(quota.intervalResetsInMs)}
            />
            <WindowMeter
              label="This week"
              remainingPercent={quota.weeklyRemainingPercent}
              caption={minimaxResetLabel(quota.weeklyResetsInMs)}
            />
          </div>
        </div>
      )}
    </section>
  );
};
