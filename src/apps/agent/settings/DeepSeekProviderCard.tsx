/**
 * Agent Window — DeepSeek account card (view).
 *
 * The identity block in the Providers detail pane for DeepSeek, replacing the
 * generic name/type head the way Atlas, Codex, Cursor, OpenCode, Command Code,
 * kenari, Ark and MiniMax do. Reuses the `.agw-atlas-*` family so all of them
 * read as one system. The connection fields, the wire picker and the model
 * list still render below it.
 *
 * ## Why there is no bar on this card
 *
 * Every other card in this family draws a meter, because those accounts sell a
 * window that refills and refuse requests when it empties — the bar is the
 * distance to a hard stop. DeepSeek is pay-as-you-go. There is no ceiling to
 * fill and no reset to count down to; running out is `402 Insufficient
 * Balance` on the next request. A bar needs a maximum, and the only one
 * available here is the balance itself, which would draw a full bar right up
 * to the moment it is empty.
 *
 * So the reading is the number, DeepSeek's own `is_available` flag, and the
 * rate window.
 *
 * ## Why the rate window is on a balance card
 *
 * Because DeepSeek charges twice as much for the same tokens between
 * 01:00–04:00 and 06:00–10:00 UTC on weekdays, and Aurora's cost figures are
 * priced from a single catalogue number. That number is the off-peak rate —
 * it is what the clock says for 133 hours of every 168 — so during peak the
 * costs shown everywhere else in the app are half the real charge. That is
 * worth saying next to the balance it is draining, rather than leaving for
 * someone to find on the invoice.
 *
 * ## Why this one needs no sign-in
 *
 * kenari's key cannot reach its own account and Volcano's control plane
 * refuses its key outright, so both of those cards ask for a browser session
 * beside a working key. DeepSeek publishes `GET /user/balance` and answers it
 * with the same `sk-` key that serves chat. Paste a key below and this fills
 * in.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";

import {
  deepseekMoney,
  deepseekRateWindow,
  fetchDeepSeekBalance,
  DEEPSEEK_CONSOLE_URL,
  type DeepSeekBalance,
  type DeepSeekBalanceSnapshot,
} from "@/apps/agent/services/providers/deepseek";
import { fmtDuration } from "@/apps/agent/lib/time/duration";
import { fmtRelative } from "@/apps/agent/services/providers/atlascloud";
import { AgentIcon } from "../shared/AgentIcon";
import { ProviderAvatar } from "./ProviderAvatar";
import { AgwPill, AgwSwitch } from "./primitives";

type Phase = "idle" | "loading" | "loaded" | "error";

/** One tile: a label, the figure, and what it is made of. */
const Stat: React.FC<{ label: string; value: string; sub: string }> = ({
  label,
  value,
  sub,
}) => (
  <div className="agw-atlas-stat">
    <div className="agw-atlas-stat-label">{label}</div>
    <div className="agw-atlas-stat-value">{value}</div>
    <div className="agw-atlas-stat-sub">{sub}</div>
  </div>
);

/** A wallet tile. The sub says where the money came from, which decides
 *  nothing on its own but explains a total that does not match a top-up. */
function walletStat(balance: DeepSeekBalance): { label: string; value: string; sub: string } {
  return {
    label: `${balance.currency} balance`,
    value: deepseekMoney(balance.currency, balance.total),
    sub:
      balance.granted > 0
        ? `${deepseekMoney(balance.currency, balance.granted)} granted · ${deepseekMoney(
            balance.currency,
            balance.toppedUp,
          )} paid in`
        : `${deepseekMoney(balance.currency, balance.toppedUp)} paid in`,
  };
}

export const DeepSeekProviderCard: React.FC<{
  apiKey: string;
  baseUrl: string;
  enabled: boolean;
  onToggleEnabled: (next: boolean) => void;
}> = ({ apiKey, baseUrl, enabled, onToggleEnabled }) => {
  // Born loading when there is a key: the read starts on mount, and an "idle"
  // first paint would flash "add a key" at someone who already has one.
  const [phase, setPhase] = useState<Phase>(apiKey.trim() ? "loading" : "idle");
  const [snap, setSnap] = useState<DeepSeekBalanceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const key = apiKey.trim();

  /**
   * The pane is a list someone clicks through, so this component mounts and
   * unmounts freely and a read can outlive the row that started it. The ref is
   * what stops a late answer writing into a card that is gone — and it lets
   * the mount effect and the refresh button share ONE copy of the fetch.
   */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const apply = useCallback((next: DeepSeekBalanceSnapshot) => {
    if (!alive.current) return;
    setSnap(next);
    setError(null);
    setPhase("loaded");
  }, []);

  /** Never silent: an empty space here reads as "no balance", which on a
   *  pay-as-you-go account is the one reading that is never true. */
  const fail = useCallback((err: unknown) => {
    if (!alive.current) return;
    setSnap(null);
    setError(err instanceof Error ? err.message : String(err));
    setPhase("error");
  }, []);

  // Keyed on the key AND the URL, so pasting a different one — or switching
  // the wire, which rewrites the URL — re-reads rather than leaving the
  // previous account's figure on screen.
  useEffect(() => {
    if (!key) return;
    fetchDeepSeekBalance(key, baseUrl).then(apply).catch(fail);
  }, [key, baseUrl, apply, fail]);

  const refresh = () => {
    if (!key) return;
    setPhase("loading");
    fetchDeepSeekBalance(key, baseUrl).then(apply).catch(fail);
  };

  // Derived, not stored: with no key there is nothing to have read.
  const view: Phase = key ? phase : "idle";
  const rate = deepseekRateWindow();
  const wallets = snap?.balances ?? [];
  // Three tiles, always. Two wallets is the normal reply on a live account
  // (one CNY, one USD), and where there is only one the second tile shows what
  // that one is made of rather than leaving a gap in the row.
  const tiles = [
    wallets[0] ? walletStat(wallets[0]) : null,
    wallets[1]
      ? walletStat(wallets[1])
      : wallets[0]
        ? {
            label: "Paid in",
            value: deepseekMoney(wallets[0].currency, wallets[0].toppedUp),
            sub: `${deepseekMoney(wallets[0].currency, wallets[0].granted)} granted`,
          }
        : null,
    {
      label: "Rate now",
      value: rate.peak ? "Peak" : "Off-peak",
      sub: rate.peak
        ? `off-peak in ${fmtDuration(rate.changesInMs / 1000)}`
        : `peak in ${fmtDuration(rate.changesInMs / 1000)}`,
    },
  ].filter((t): t is { label: string; value: string; sub: string } => t !== null);

  return (
    <section className="agw-atlas" aria-label="DeepSeek account balance">
      <div className="agw-atlas-head">
        <ProviderAvatar provider={{ id: "deepseek", name: "DeepSeek" }} />
        <div className="agw-atlas-head-titles">
          <div className="agw-atlas-title">
            DeepSeek
            {/* DeepSeek's own judgement, not a threshold Aurora invented. It
                is the difference between a low balance and an account that has
                already stopped serving. */}
            {view === "loaded" && snap && !snap.isAvailable && (
              <AgwPill tone="warning">Out of balance</AgwPill>
            )}
          </div>
          <div className="agw-atlas-sub">
            {view === "idle" && "Add a key below to see what is left on the account"}
            {view === "loading" && "Reading balance…"}
            {view === "loaded" &&
              snap &&
              `Updated ${fmtRelative(snap.fetchedAtMs)} ago · billed per token, no quota window`}
            {view === "error" && "Could not read the balance"}
          </div>
        </div>
        <div className="agw-atlas-head-actions">
          {key && (
            <button
              type="button"
              className="agw-prov-icon-btn"
              title="Refresh balance"
              aria-label="Refresh balance"
              onClick={refresh}
            >
              <AgentIcon name="retry" size={14} />
            </button>
          )}
          <a
            className="agw-prov-icon-btn"
            href={DEEPSEEK_CONSOLE_URL}
            target="_blank"
            rel="noreferrer"
            title="Open your DeepSeek usage page"
            aria-label="Open your DeepSeek usage page"
          >
            <AgentIcon name="external" size={14} />
          </a>
          <span className="agw-atlas-head-sep" aria-hidden="true" />
          <AgwSwitch checked={enabled} onChange={onToggleEnabled} ariaLabel="Enable DeepSeek" />
        </div>
      </div>

      {view === "loading" && (
        <div className="agw-atlas-body">
          <div className="agw-atlas-skeleton" />
          <div className="agw-atlas-skeleton" style={{ width: "72%" }} />
        </div>
      )}

      {view === "idle" && (
        <div className="agw-atlas-body agw-atlas-hint">
          Your DeepSeek key reads its own balance — there is nothing else to
          connect. Paste it below and this fills in. The account bills per
          token rather than from a plan, so what runs out is money, not a
          window.
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

      {view === "loaded" && snap && (
        <div className="agw-atlas-body">
          <div className="agw-atlas-stat-grid">
            {tiles.map((t) => (
              <Stat key={t.label} label={t.label} value={t.value} sub={t.sub} />
            ))}
          </div>
          {/* Said here because this is where the money is. Every cost figure
              in Aurora is priced from one catalogue rate per model, and that
              rate is the off-peak one — so during peak hours those numbers are
              half of what this balance is actually losing. */}
          <div className="agw-atlas-note">
            {rate.peak
              ? "Peak hours: DeepSeek is charging double, so the costs shown elsewhere in Aurora are half the real figure."
              : "Off-peak: the costs shown elsewhere in Aurora are this rate. Peak hours (01:00–04:00 and 06:00–10:00 UTC, weekdays) cost double."}{" "}
            Chinese public holidays are off-peak in full, and Aurora does not
            know their dates — on one of those days this can say Peak when the
            charge is not.
          </div>
        </div>
      )}
    </section>
  );
};

export default DeepSeekProviderCard;
