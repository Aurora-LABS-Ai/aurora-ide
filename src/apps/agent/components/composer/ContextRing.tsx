/**
 * Agent Window — context-usage ring [view].
 *
 * A compact circular gauge in the conversation header (just before Settings)
 * that shows how much of the model's context window the OPEN chat is using.
 * Hovering reveals a portaled card with the exact tokens, cache-hit telemetry,
 * and what the work has cost. Rows appear only when the data behind them
 * actually exists — no empty rows, and no confident figure over a number
 * nobody measured.
 *
 * THREE different numbers live on this card and they come from three places,
 * because they answer three different questions:
 *
 * - **Used %** — the LATEST request's usage (`byThread`). Every request
 *   resends the whole history, so its input size is exactly how full the
 *   window is now. Correctly overwritten per request.
 * - **This/Last turn** — every request the turn made, summed. Live from the
 *   turn accumulator while streaming, from the transcript once settled. A
 *   turn runs one request per tool iteration; showing only the last one is
 *   what made a thirty-minute turn report the price of its final request.
 * - **This chat** — the whole conversation, grouped by the model that ran
 *   each request and summed as MONEY, so a mid-chat model switch is priced at
 *   each model's own rates.
 *
 * Used context = promptTokens + cacheReadTokens (matches the IDE indicator);
 * the window comes from the conversation's own model. All chrome reads
 * `--agw-*` tokens.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { pinnedThreadModel } from "@/apps/agent/lib/thread/thread-model";
import { useAgentContextStore } from "@/apps/agent/store/conversation/useAgentContextStore";
import {
  alignLinesToTotal,
  costPrecision,
  formatCostAt,
  formatRequestCount,
  hasCost,
  modelLabel,
  priceUsage,
  type ModelPrices,
  type ModelUsageGroup,
} from "@/apps/agent/lib/cost/cost";
import { useSettingsStore } from "@/kernel/store/useSettingsStore";
import {
  codexFmtDuration,
  codexUsageGet,
  codexWindowLabel,
  CODEX_PROVIDER_ID,
  type CodexUsageSnapshot,
  type CodexUsageWindow,
} from "@/apps/agent/services/providers/codex";
import {
  fetchOpenCodeUsage,
  openCodeResetLabel,
  OPENCODE_PROVIDER_ID,
  type OpenCodeUsage,
} from "@/apps/agent/services/providers/opencode";
import {
  commandCodeMoney,
  commandCodeResetLabel,
  commandCodeWindowRatio,
  fetchCommandCodeUsage,
  COMMANDCODE_PROVIDER_ID,
  type CommandCodeUsageSnapshot,
} from "@/apps/agent/services/providers/commandcode";
import {
  fetchKenariUsage,
  isKenariProvider,
  kenariResetLabel,
  KENARI_WINDOWS,
  type KenariUsage,
} from "@/apps/agent/services/providers/kenari";
import {
  cursorMeterValue,
  cursorResetLabel,
  cursorUsageGet,
  CURSOR_PROVIDER_ID,
  type CursorUsageSnapshot,
} from "@/apps/agent/services/providers/cursor";
import {
  useReservedCostLines,
  useSticky,
  useThrottled,
} from "@/apps/agent/components/composer/context-card-stability";
import type { TokenUsage } from "@/apps/agent/services";

function formatTokens(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

/** Ring colour by usage band — green (room) → amber → red (near full). */
function bandColor(pct: number): string {
  if (pct >= 85) return "var(--agw-removed)";
  if (pct >= 60) return "var(--agw-warning)";
  return "var(--agw-added)";
}

/**
 * How long a fetched plan quota stays good for.
 *
 * A minute, because these are authenticated round-trips and the ring opens on
 * hover — without a cache, sweeping the mouse across the composer would bill a
 * request per pass. A limit window that moves inside sixty seconds is one you
 * are already watching the provider's own page for.
 */
const PLAN_USAGE_TTL_MS = 60_000;

/** Codex quota. One snapshot serves every ring instance. */
let codexUsageCache: { at: number; snap: CodexUsageSnapshot } | null = null;

async function getCodexUsageCached(): Promise<CodexUsageSnapshot | null> {
  if (codexUsageCache && Date.now() - codexUsageCache.at < PLAN_USAGE_TTL_MS) {
    return codexUsageCache.snap;
  }
  try {
    const snap = await codexUsageGet();
    codexUsageCache = { at: Date.now(), snap };
    return snap;
  } catch {
    // Signed out / offline — the tooltip simply omits the quota section.
    return null;
  }
}

/**
 * OpenCode Go plan headroom, cached the same way and for the same reason.
 *
 * Keyed by the API key so pasting a different one is read as a different
 * account rather than served a minute of the previous account's numbers.
 */
let openCodeUsageCache: { at: number; key: string; usage: OpenCodeUsage } | null = null;

async function getOpenCodeUsageCached(apiKey: string): Promise<OpenCodeUsage | null> {
  if (
    openCodeUsageCache &&
    openCodeUsageCache.key === apiKey &&
    Date.now() - openCodeUsageCache.at < PLAN_USAGE_TTL_MS
  ) {
    return openCodeUsageCache.usage;
  }
  try {
    const usage = await fetchOpenCodeUsage(apiKey);
    openCodeUsageCache = { at: Date.now(), key: apiKey, usage };
    return usage;
  } catch {
    // No key yet, revoked, or offline — the section is omitted rather than
    // shown empty. The provider page is where a broken key gets explained.
    return null;
  }
}

/**
 * Command Code plan headroom, cached the same way and for the same reason.
 *
 * Keyed by the API key like OpenCode's, and an empty key is a real value here
 * rather than a reason to skip: with nothing pasted, Rust falls back to the
 * key the Command Code CLI stored, so the ring still has an account to ask.
 */
let commandCodeUsageCache: {
  at: number;
  key: string;
  usage: CommandCodeUsageSnapshot;
} | null = null;

async function getCommandCodeUsageCached(
  apiKey: string,
): Promise<CommandCodeUsageSnapshot | null> {
  if (
    commandCodeUsageCache &&
    commandCodeUsageCache.key === apiKey &&
    Date.now() - commandCodeUsageCache.at < PLAN_USAGE_TTL_MS
  ) {
    return commandCodeUsageCache.usage;
  }
  try {
    const usage = await fetchCommandCodeUsage(apiKey);
    commandCodeUsageCache = { at: Date.now(), key: apiKey, usage };
    return usage;
  } catch {
    // Not connected, revoked, or offline — the section is omitted rather than
    // shown empty. The provider page is where a broken key gets explained.
    return null;
  }
}

/**
 * kenari plan headroom, cached the same way.
 *
 * Not keyed by anything, unlike OpenCode's: the `kn-` key cannot read this data
 * at all, so there is no key to key it by. It comes from a stored sign-in, and
 * there is exactly one of those.
 *
 * `"signed-out"` is a distinct outcome from `null`, because the card says
 * different things about them. No sign-in is a state with an obvious next step;
 * a failed read is not, and offering "sign in" over a network error sends
 * someone to re-authenticate a session that was working fine.
 */
type KenariPlanState = KenariUsage | "signed-out" | null;

let kenariUsageCache: { at: number; state: KenariPlanState } | null = null;

async function getKenariUsageCached(): Promise<KenariPlanState> {
  if (kenariUsageCache && Date.now() - kenariUsageCache.at < PLAN_USAGE_TTL_MS) {
    return kenariUsageCache.state;
  }
  let state: KenariPlanState = null;
  try {
    state = await fetchKenariUsage();
  } catch {
    // Rust refuses with a message for both "never signed in" and "the session
    // expired", and the honest answer to each is the same one: sign in. A read
    // that failed for any other reason is cached as a miss and simply retried
    // after the TTL.
    state = "signed-out";
  }
  kenariUsageCache = { at: Date.now(), state };
  return state;
}

/**
 * Cursor plan usage, cached the same way and for the same reason.
 *
 * Unkeyed, like kenari's: the session comes from the Cursor desktop install
 * and there is exactly one of it.
 */
let cursorUsageCache: { at: number; snap: CursorUsageSnapshot } | null = null;

async function getCursorUsageCached(): Promise<CursorUsageSnapshot | null> {
  if (cursorUsageCache && Date.now() - cursorUsageCache.at < PLAN_USAGE_TTL_MS) {
    return cursorUsageCache.snap;
  }
  try {
    const snap = await cursorUsageGet();
    cursorUsageCache = { at: Date.now(), snap };
    return snap;
  } catch {
    // Not connected, or the account reported nothing readable — the tooltip
    // omits the section rather than explaining it. The provider page is where
    // a broken read gets a reason.
    return null;
  }
}

/** The plan's windows, in the order pressure actually arrives. */
const OPENCODE_WINDOWS: Array<{ key: keyof OpenCodeUsage; label: string }> = [
  { key: "rolling", label: "Right now" },
  { key: "weekly", label: "This week" },
  { key: "monthly", label: "This month" },
];

/**
 * One priced section of the card — a headline total plus its component lines.
 *
 * Renders nothing when there is nothing true to say. Every state that is not
 * a plain measured total names itself: an approximate total is prefixed `~`,
 * and requests whose model carries no pricing are disclosed by count so the
 * headline is never mistaken for the whole bill.
 */
const CostSection: React.FC<{
  label: string;
  groups: ModelUsageGroup[];
  lookup: (model: string | undefined) => ModelPrices | null;
  /** Shown under the total, e.g. "14 turns · 41 requests". */
  subline?: string;
}> = ({ label, groups, lookup, subline }) => {
  const cost = useMemo(() => priceUsage(groups, lookup), [groups, lookup]);
  // Model KEY only. The raw selection carries the provider row id, which for a
  // user-added provider is a UUID — meaningless to a person and long enough to
  // stretch the card it sits in.
  const unpricedModelLabel = modelLabel(cost.unpricedModels[0]);
  // Every request priced by the provider itself → the total IS the bill, and
  // the per-line token breakdown does not apply to it.
  const allReported = cost.reportedRequests > 0 && cost.reportedRequests === cost.pricedRequests;
  // Every conditional row in this section reserves its slot once it has earned
  // one. Hooks first — a section that returns early cannot call them, so the
  // "does this section exist at all" test is itself sticky and lives below.
  const lines = useReservedCostLines({
    "fresh input": allReported ? 0 : cost.lines.freshInput,
    "cache write": allReported ? 0 : cost.lines.cacheWrite,
    "cached input": allReported ? 0 : cost.lines.cachedInput,
    output: allReported ? 0 : cost.lines.output,
  });
  const showUnpricedNote = useSticky(cost.unpricedRequests > 0);
  // A turn's section does not exist before its first response lands. Without
  // this, every turn began by inserting a whole block into the middle of an
  // open card and pushing the conversation total down the screen.
  const exists = useSticky(hasCost(cost));
  if (!exists) return null;
  const approx = cost.estimated ? "~" : "";
  // One precision for the whole section, and the rounding residual placed on
  // the largest line, so the column visibly adds up to the headline. Rounded
  // independently they did not: $0.0665 + $0.0028 + $0.0006 under $0.0700.
  const decimals = costPrecision(cost.total);
  const shown = alignLinesToTotal(
    lines.map(([, value]) => value),
    cost.total,
  );
  return (
    <>
      <div className="agw-ctx-divider" />
      <div className="agw-ctx-row">
        <span className="agw-ctx-label">{label}</span>
        {/* When NOTHING could be priced there is no figure — say so with a
          * dash. `$0` next to "13 requests not counted" contradicts itself:
          * one claims the work was free, the other says it was never
          * measured. A dash is the only honest headline for "no answer". */}
        <span className="agw-ctx-val">
          {cost.pricedRequests === 0 ? (
            <span style={{ color: "var(--agw-text-subtle)" }}>—</span>
          ) : (
            `${approx}${formatCostAt(cost.total, decimals)}`
          )}
        </span>
      </div>
      {subline && <div className="agw-ctx-sub">{subline}</div>}
      {/* A line that has never been worth anything is not rendered at all — an
        * unused rate is not a charge, and four rows of $0 bury the two that
        * matter. One that HAS been keeps its slot and shows a dash when it
        * falls back to zero, because a row reclaiming its space mid-hover
        * shifts every row beneath it. Absence is designed here, not implied by
        * a gap: the dash says "measured, nothing to charge". */}
      {lines.map(([name, raw], i) => (
        <div key={name} className="agw-ctx-line">
          <span>{name}</span>
          <span style={raw > 0 ? undefined : { opacity: 0.45 }}>
            {raw <= 0
              ? "—"
              : shown[i] > 0
                ? `${approx}${formatCostAt(shown[i], decimals)}`
                : /* Real spend, too small to show at this precision. Says so
                   * rather than printing $0.0000 over a genuine charge. */
                  `<${formatCostAt(1 / 10 ** decimals, decimals)}`}
          </span>
        </div>
      ))}
      {/* Where these figures came from is stated ONCE, in the card's footer.
        * It used to be repeated inside every section as "$0 billed by
        * provider — 13 of 73", which sat directly beneath the total and read
        * as a denial of it, and again as a chip beside Used. One provenance
        * line for one card. */}
      {/* A sentence, not a label/value pair. It was rendered as two columns of
        * a `space-between` row, so the count and the model name touched with
        * no gap and the raw provider UUID stretched the whole card. It also
        * names the fix — a cost we cannot compute is only actionable if the
        * card says where the missing price goes. */}
      {showUnpricedNote && cost.unpricedRequests > 0 && (
        <div className="agw-ctx-note">
          <strong>
            {cost.unpricedRequests}{" "}
            {cost.unpricedRequests === 1 ? "request" : "requests"} not counted
          </strong>{" "}
          {unpricedModelLabel
            ? `— ${unpricedModelLabel} has no price set. Add one in Settings › Providers.`
            : "— these ran before Aurora recorded which model they used, so they cannot be priced."}
        </div>
      )}
    </>
  );
};

/**
 * One limit window inside the tooltip: "5-hour limit — 63% left · resets in 2h".
 *
 * Provider-agnostic on purpose. Every subscription Aurora can see reports the
 * same three facts — which window, how much of it is gone, when it refills —
 * and the reading is only comparable if they are drawn the same way. What each
 * provider keeps to itself is how it *names* its windows and how it words a
 * countdown; both arrive here already said.
 *
 * `usedPercent` is what is spent, and the row shows what is LEFT: the two carry
 * the same fact, but only one answers "can I keep going".
 */
const QuotaRow: React.FC<{ label: string; usedPercent: number; caption?: string | null }> = ({
  label,
  usedPercent,
  caption,
}) => {
  const used = Math.min(100, Math.max(0, usedPercent));
  const left = Math.max(0, Math.round(100 - used));
  return (
    <>
      <div className="agw-ctx-row">
        <span className="agw-ctx-label">{label}</span>
        <span className="agw-ctx-val" style={{ color: bandColor(used) }}>
          {left}% left
        </span>
      </div>
      <div className="agw-ctx-bar">
        <div
          className="agw-ctx-bar-fill"
          style={{ width: `${used}%`, background: bandColor(used) }}
        />
      </div>
      {caption && <div className="agw-ctx-sub">{caption}</div>}
    </>
  );
};

/**
 * One Cursor bucket.
 *
 * Two of its three lines are quota and the third is money, so this cannot be
 * [`QuotaRow`] — that row reports what is LEFT, and "−1% left" is not what an
 * on-demand overage means. Spend states the amount against its cap and lets
 * the pair speak: `$70.46 of $70` needs no adjective.
 */
const CursorPlanRow: React.FC<{ win: CursorUsageSnapshot["windows"][number] }> = ({ win }) => {
  if (win.kind === "quota") {
    return <QuotaRow label={win.label} usedPercent={win.usedPercent} />;
  }
  const over = win.usedUsd != null && win.limitUsd != null && win.usedUsd > win.limitUsd;
  // An overage is past the top of its own band, so it is coloured as the
  // hard stop it is rather than by a percentage that has stopped moving.
  const tone = over ? bandColor(100) : bandColor(win.usedPercent);
  return (
    <>
      <div className="agw-ctx-row">
        <span className="agw-ctx-label">{win.label}</span>
        <span className="agw-ctx-val" style={{ color: tone }}>
          {cursorMeterValue(win)}
        </span>
      </div>
      <div className="agw-ctx-bar">
        <div
          className="agw-ctx-bar-fill"
          style={{ width: `${Math.min(100, win.usedPercent)}%`, background: tone }}
        />
      </div>
      {over && <div className="agw-ctx-sub">billed on top of the subscription</div>}
    </>
  );
};

/** A Codex window, named and counted down the way Codex reports it. */
const CodexQuotaRow: React.FC<{ win: CodexUsageWindow; fallbackLabel: string }> = ({
  win,
  fallbackLabel,
}) => (
  <QuotaRow
    label={codexWindowLabel(win, fallbackLabel)}
    usedPercent={win.usedPercent}
    caption={
      win.resetsInSeconds != null ? `resets in ${codexFmtDuration(win.resetsInSeconds)}` : null
    }
  />
);

export const ContextRing: React.FC = () => {
  const currentThreadId = useAgentChatStore((s) => s.currentThreadId);
  const currentThread = useAgentChatStore((s) => s.currentThread);
  /*
   * Every store slice below is republished on EVERY API response, and a turn
   * makes one per tool iteration — fifty-odd on a long one. Read raw, the card
   * repaints seventeen numbers fifty times in ninety seconds, which is not a
   * readable card, it is a strobe. `useThrottled` publishes at most once a
   * second and always publishes last, so the settled figure is the true one
   * and nothing in between is a number you were meant to read.
   *
   * The ring itself is throttled too. It is a gauge, not an alarm — a second
   * of latency on "how full is the window" costs nothing, and the ring's own
   * 0.6s stroke transition was already slower than the updates driving it.
   */
  const liveUsage = useThrottled(
    useAgentContextStore((s) =>
      currentThreadId ? s.byThread[currentThreadId] : undefined,
    ),
  );
  // Set only in the gap between a compaction rewriting the context and the
  // first request measured against the new shape. Aurora's own arithmetic, and
  // labelled as such — it is a different claim from "the provider reported
  // nothing", which is what conflating the two used to make the card say.
  const projectedTokens = useThrottled(
    useAgentContextStore((s) =>
      currentThreadId ? s.projectedByThread[currentThreadId] : undefined,
    ),
  );
  // Cache telemetry is read from its OWN record, not from `liveUsage`. A turn
  // overwrites `liveUsage` once per tool iteration, and any response that
  // omits the cache fields used to blank the row — so on a long turn the row
  // flickered in and out with no relation to whether caching was working.
  const cacheReading = useThrottled(
    useAgentContextStore((s) =>
      currentThreadId ? s.cacheByThread[currentThreadId] : undefined,
    ),
  );

  // Primitive selectors only — returning the object from `getLLMConfig()` /
  // `getResolvedActiveModel()` would hand zustand a fresh reference each render
  // and spin "getSnapshot should be cached". `getActiveModel()` is a stable
  // row lookup; the window is read as a number.
  // The ring measures the OPEN conversation against ITS model's window. Reading
  // the app-wide selection would size the bar by another chat's model — a chat
  // on a 32k model would read as comfortable while sitting inside a 200k window
  // it doesn't have. Both selectors stay safe: one returns a number, the other
  // a stable row from the models array.
  const pinnedModel = useAgentChatStore((s) => pinnedThreadModel(s, s.currentThreadId));
  // Primitive (string) selector — safe to derive from on every render.
  const defaultModel = useSettingsStore((s) => s.selectedModel);
  const selectedModel = pinnedModel ?? defaultModel;
  const contextFloor = useAgentContextStore((s) =>
    currentThreadId ? (s.contextFloorByThread[currentThreadId] ?? 0) : 0,
  );

  const contextWindow = useSettingsStore(
    (s) => s.getLLMConfigFor(selectedModel)?.contextWindow ?? 128_000,
  );
  const isCodex = selectedModel.startsWith(`${CODEX_PROVIDER_ID}:`);
  // Same question for the other subscription Aurora can read: a plan bills by
  // headroom, not by the token, so the ring's cost figures say nothing useful
  // and the limit windows say everything.
  const isOpenCode = selectedModel.startsWith(`${OPENCODE_PROVIDER_ID}:`);
  // And the third: a Cursor turn bills against a plan, so the per-token cost
  // figures above are $0.00 for a conversation that is genuinely spending.
  const isCursor = selectedModel.startsWith(`${CURSOR_PROVIDER_ID}:`);
  // The plan's own key — the model list needs no auth, but the usage endpoint
  // is about the account. Read from the provider row rather than held here:
  // pasting a new key in Settings must change what the ring reports.
  const openCodeKey = useSettingsStore(
    (s) => s.providers.find((p) => p.id === OPENCODE_PROVIDER_ID)?.apiKey ?? "",
  );
  // And the fourth: Command Code meters spend against two rolling dollar caps,
  // so the per-token cost lines above are the wrong reading for the same
  // reason they are on the other three.
  const isCommandCode = selectedModel.startsWith(`${COMMANDCODE_PROVIDER_ID}:`);
  // Empty is a legitimate value, unlike OpenCode's: with no key pasted, Rust
  // reads the one the Command Code CLI stored. So this is not gated on.
  const commandCodeKey = useSettingsStore(
    (s) => s.providers.find((p) => p.id === COMMANDCODE_PROVIDER_ID)?.apiKey ?? "",
  );
  // kenari is asked the same question, but it cannot be recognised by an id
  // prefix the way the other two are: the built-in row is `kenari`, while a row
  // someone added themselves carries a UUID and declares itself through
  // `providerType`. `isKenariProvider` knows both, so the row is looked up and
  // asked. Returns a boolean — a primitive selector, safe to derive from.
  const isKenari = useSettingsStore((s) => {
    // First colon only — a provider id never contains one, a model key can.
    const split = selectedModel.indexOf(":");
    if (split <= 0) return false;
    const providerId = selectedModel.slice(0, split);
    const row = s.providers.find((p) => p.id === providerId);
    return row ? isKenariProvider(row) : false;
  });

  // ── Cost inputs ───────────────────────────────────────────────────
  // The running turn's requests (summed live) and the conversation's total
  // (read back from the transcript). Deliberately separate from `liveUsage`
  // above, which is one request and answers a different question.
  const liveTurnGroups = useThrottled(
    useAgentContextStore((s) =>
      currentThreadId ? s.liveTurnByThread[currentThreadId] : undefined,
    ),
  );
  const breakdown = useThrottled(
    useAgentContextStore((s) =>
      currentThreadId ? s.breakdownByThread[currentThreadId] : undefined,
    ),
  );
  /**
   * True while our copy of the transcript predates work that has since
   * happened — set on every completed request and again when the turn settles.
   *
   * The card has to know this, not just the store: a breakdown read mid-turn
   * describes a turn that had not finished, and treating it as current is what
   * made the cost sections vanish the moment streaming stopped.
   */
  const breakdownStale = useAgentContextStore((s) =>
    currentThreadId ? !!s.staleBreakdowns[currentThreadId] : false,
  );
  const loadBreakdown = useAgentContextStore((s) => s.loadBreakdown);
  const isStreaming = useAgentChatStore((s) =>
    currentThreadId ? !!s.liveTurns[currentThreadId] : false,
  );

  /**
   * EXACT price lookup — deliberately not `getModelFor`, which falls back to
   * the currently-selected model when a selection is absent or unresolvable.
   * That fallback is right for "which model will this send to" and utterly
   * wrong here: it would price a request whose model was never recorded, or
   * whose model has since been deleted, at today's rates and present the
   * result as measured. A miss must stay a miss so the card can disclose it.
   */
  const models = useSettingsStore((s) => s.models);
  const priceLookup = useCallback(
    (selection: string | undefined): ModelPrices | null => {
      if (!selection) return null;
      // First colon only — a provider id never contains one, a model key can.
      const split = selection.indexOf(":");
      if (split <= 0) return null;
      const providerId = selection.slice(0, split);
      const modelKey = selection.slice(split + 1);
      const model = models.find(
        (m) => m.providerId === providerId && m.modelKey === modelKey,
      );
      if (!model) return null;
      return {
        cacheMissPerMtok: model.priceCacheMissPerMtok,
        outputPerMtok: model.priceOutputPerMtok,
        cacheHitPerMtok: model.priceCacheHitPerMtok,
        cacheWritePerMtok: model.priceCacheWritePerMtok,
      };
    },
    [models],
  );

  /**
   * While a turn streams, the live accumulator is the only thing that knows
   * about it — the transcript gains those requests only when the turn ends.
   * Once settled, the transcript wins: it is what survives a reload, and it
   * includes anything the event stream missed.
   *
   * The `breakdownStale` arm is what closes the hand-off between the two. The
   * moment a turn settles, `isStreaming` flips to false while our transcript
   * copy still predates that turn — so this used to swap from the live figures
   * to a `lastTurn` describing the PREVIOUS turn, or, on a chat's first turn,
   * to an empty array. An empty array prices to nothing, `CostSection` renders
   * nothing for it, and both cost sections silently disappeared from an open
   * card, reappearing seconds later when the fresh read landed. Keeping the
   * live accumulator until the transcript catches up removes the gap: the
   * numbers stay exactly as they were and are simply confirmed.
   *
   * Memoized because it feeds two other hooks: unmemoized, the `?? []` branch
   * handed both a fresh array on every render, which re-priced the turn each
   * time and — now that the refresh effect below keys off it — would have
   * re-read the transcript on every render of a streaming turn.
   */
  const turnGroups = useMemo(
    () =>
      isStreaming || breakdownStale
        ? liveTurnGroups ?? breakdown?.lastTurn ?? []
        : breakdown?.lastTurn ?? liveTurnGroups ?? [],
    [isStreaming, breakdownStale, liveTurnGroups, breakdown],
  );

  const triggerRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [codexUsage, setCodexUsage] = useState<CodexUsageSnapshot | null>(null);
  const [openCodeUsage, setOpenCodeUsage] = useState<OpenCodeUsage | null>(null);
  const [commandCodeUsage, setCommandCodeUsage] = useState<CommandCodeUsageSnapshot | null>(
    null,
  );
  const [kenariPlan, setKenariPlan] = useState<KenariPlanState>(null);
  const [cursorUsage, setCursorUsage] = useState<CursorUsageSnapshot | null>(null);

  // Loaded from the hover/focus handlers (not an effect): the quota is only
  // wanted while the card is visible, and the module cache absorbs repeat
  // opens. A stale-guard isn't needed — the cache makes late sets idempotent.
  //
  // One call for whichever plan the selected model belongs to. At most one can
  // match, so this never fans out into "ask every provider on hover".
  const loadPlanUsage = useCallback(() => {
    if (isCodex) {
      void getCodexUsageCached().then((snap) => {
        if (snap) setCodexUsage(snap);
      });
      return;
    }
    if (isOpenCode && openCodeKey) {
      void getOpenCodeUsageCached(openCodeKey).then((usage) => {
        if (usage) setOpenCodeUsage(usage);
      });
      return;
    }
    // No key gate, unlike OpenCode's: an empty key means "use the one the CLI
    // stored", which is a working account, not a missing one.
    if (isCommandCode) {
      void getCommandCodeUsageCached(commandCodeKey).then((usage) => {
        if (usage) setCommandCodeUsage(usage);
      });
      return;
    }
    // No key to gate on, unlike the other two: kenari's plan data comes from a
    // stored sign-in, and whether there is one is exactly what this asks.
    if (isKenari) {
      void getKenariUsageCached().then(setKenariPlan);
      return;
    }
    // Nothing to gate on here either: the session is the Cursor app's, and
    // whether Aurora has adopted one is exactly what this asks.
    if (isCursor) {
      void getCursorUsageCached().then((snap) => {
        if (snap) setCursorUsage(snap);
      });
    }
  }, [isCodex, isOpenCode, isCommandCode, isKenari, isCursor, openCodeKey, commandCodeKey]);

  /**
   * Read the conversation's cost basis when the card opens.
   *
   * On open rather than on every turn: parsing a long transcript for a chat
   * nobody is looking at is waste, and the store already knows when its copy
   * went stale. `loadBreakdown` no-ops when a fresh copy is held.
   */
  const loadCost = useCallback(() => {
    if (!currentThreadId) return;
    void loadBreakdown(currentThreadId);
  }, [currentThreadId, loadBreakdown]);
  // Portal INTO `.agw-root` (not document.body) so the `--agw-*` tokens cascade
  // — otherwise the card's `var(--agw-surface-elevated)` resolves to nothing and
  // renders transparent (the "glassmorphic" bug).
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const attachRoot = useCallback((el: HTMLDivElement | null) => {
    triggerRef.current = el;
    if (el) setPortalTarget((el.closest(".agw-root") as HTMLElement) ?? document.body);
  }, []);

  const place = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onMove = () => place();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, place]);

  /**
   * Keep "This chat" current while a turn runs.
   *
   * The conversation total comes from the transcript, which the store only
   * re-reads when it has been marked stale — so with the card held open during
   * a long turn it froze at whatever it read on hover, and the headline sat
   * below the real spend by the whole running turn plus any compaction inside
   * it. Re-reading on each completed request closes that gap: `onUsage` marks
   * the copy stale, the request count below changes, and this pulls the fresh
   * one.
   *
   * Keyed on STALENESS rather than on streaming. The old gate stopped firing
   * the instant a turn settled — which is the one moment the stored copy is
   * guaranteed to be out of date, since the turn's requests were only just
   * written. An open card then sat on pre-turn numbers until something else
   * happened to re-trigger a load, which is why the totals appeared to jump a
   * few seconds after the turn finished rather than at the end of it.
   *
   * Deliberately still gated on `open` — parsing a long transcript for a card
   * nobody is looking at is the waste `loadBreakdown` exists to avoid.
   */
  useEffect(() => {
    if (!open) return;
    loadCost();
  }, [open, breakdownStale, loadCost]);

  // Prefer live usage; fall back to the thread's persisted snapshot.
  const usage: TokenUsage | null =
    liveUsage ?? (currentThread?.token_usage as TokenUsage | undefined) ?? null;

  // How much of the window the last measured request occupied — EVERY slice
  // of it. The three input fields are disjoint: Anthropic reports fresh,
  // cache-write and cache-read separately, and Aurora's OpenAI adapter
  // subtracts the cache hit out of `prompt_tokens` so the same sum holds
  // there. Dropping cache-write understated a cache-writing turn by most of
  // its prompt.
  //
  // Output counts too, and is not a cost figure sneaking in: the assistant's
  // reply is re-sent as input on the very next request, so a window that
  // reads comfortable without it is not comfortable. Cost still comes from
  // the turn and chat totals below, which sum every request; this is one
  // request and answers only "how full is it".
  const promptTokens = usage?.promptTokens ?? 0;
  const cacheReadTokens = usage?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage?.cacheWriteTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? 0;
  const rawMeasuredTokens =
    promptTokens + cacheWriteTokens + cacheReadTokens + completionTokens;
  // Never let the reading fall while the conversation is only growing. A
  // provider that fans one model out across several upstream accounts returns
  // different counts for the same bytes depending on which one served the
  // request, and showing whichever landed last made this number jump between
  // two bands all turn. See `raiseContextFloor`.
  const measuredTokens = Math.max(rawMeasuredTokens, contextFloor);
  // A fresh compaction outranks the last measurement: that request described a
  // context that no longer exists. Holds only until the next real response.
  const isProjected = typeof projectedTokens === "number";
  const usedTokens = isProjected ? projectedTokens : measuredTokens;
  // Local tiktoken estimate (provider didn't report usage) → prefix everything
  // with `~` and add a clarifying note so the number never reads as exact.
  // A projection is approximate too, but for a different reason, and the two
  // must never share a caption — one is about the provider, one is about us.
  const isEstimated = usage?.estimated === true;
  const approx = isEstimated || isProjected ? "~" : "";

  if (!currentThreadId || usedTokens === 0) return null;

  const total = contextWindow > 0 ? contextWindow : 128_000;
  const pct = Math.min(100, Math.round((usedTokens / total) * 100));
  const color = bandColor(pct);

  // Geometry
  const size = 17;
  const stroke = 2.4;
  const radius = (size - stroke) / 2;
  const circ = radius * 2 * Math.PI;
  const offset = circ - (pct / 100) * circ;

  // Cache telemetry — shown from the moment a provider first reports it, and
  // not withdrawn afterwards.
  //
  // Hit rate is a property of the INPUT only: the completion was generated,
  // not read from or written to cache, so including it would quietly deflate
  // every percentage. Cache writes belong in the denominator — they are prompt
  // the provider had to read in full this time.
  //
  // A reported 0% is DISPLAYED, not hidden. It is the single most useful thing
  // this row can say ("your cache just broke") and it used to be rendered as
  // an empty gap, identical to a provider that reports no cache at all.
  const cacheInput = cacheReading
    ? cacheReading.promptTokens + cacheReading.writeTokens + cacheReading.readTokens
    : 0;
  const cacheHitPct =
    cacheReading && cacheInput > 0
      ? Math.round((cacheReading.readTokens / cacheInput) * 100)
      : 0;
  // Suppressed while projecting: that reading belongs to a request built from
  // a context compaction has since replaced, so showing it beside the new size
  // would describe two different conversations as one.
  const showCache = !!cacheReading && cacheInput > 0 && !isProjected;

  return (
    <div
      ref={attachRoot}
      className="agw-ctx-ring"
      role="img"
      aria-label={`Context used ${isEstimated || isProjected ? "approximately " : ""}${pct}%`}
      tabIndex={0}
      onMouseEnter={() => {
        place();
        setOpen(true);
        loadPlanUsage();
        loadCost();
      }}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => {
        place();
        setOpen(true);
        loadPlanUsage();
        loadCost();
      }}
      onBlur={() => setOpen(false)}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="color-mix(in srgb, var(--agw-text) 14%, transparent)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={circ}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.6s ease-out, stroke 0.3s ease" }}
        />
      </svg>

      {open &&
        pos &&
        portalTarget &&
        createPortal(
          <div
            className="agw-ctx-card"
            style={{ position: "fixed", top: pos.top, right: pos.right, zIndex: 12000 }}
          >
            <div className="agw-ctx-card-head">
              <AgentIcon name="database" size={11} />
              <span>Context window</span>
            </div>

            {/* Provenance is a property of the whole card, not of this one
              * row, so it lives in the footer. As a chip here it competed with
              * the headline percentage for the first glance and repeated
              * itself against the per-section "billed by provider" lines —
              * three statements of the same fact, none of them the thing you
              * opened the card to read. */}
            <div className="agw-ctx-row">
              <span className="agw-ctx-label">Used</span>
              <span className="agw-ctx-val" style={{ color }}>
                {approx}{pct}%
              </span>
            </div>
            <div className="agw-ctx-bar">
              <div className="agw-ctx-bar-fill" style={{ width: `${pct}%`, background: color }} />
            </div>
            <div className="agw-ctx-sub">
              {approx}{formatTokens(usedTokens)} / {formatTokens(total)} tokens
            </div>
            {/* Kept here, not in the footer: this is not provenance, it is a
              * temporary caveat about THIS number that clears on the next
              * message. The footer answers "who counted"; this answers "is
              * this figure final yet". */}
            {isProjected && (
              <div
                className="agw-ctx-sub"
                style={{ color: "var(--agw-text-subtle)", marginTop: 4, fontStyle: "italic" }}
              >
                Projected after compacting — exact from the next message
              </div>
            )}

            {showCache && cacheReading && (
              <>
                <div className="agw-ctx-divider" />
                <div className="agw-ctx-row">
                  <span className="agw-ctx-label">
                    Cache hit
                    {/* Said on the row rather than by disappearing. The
                      * numbers were measured, just not on the newest request —
                      * a distinction worth one word and not worth a blank.
                      *
                      * Neutral chip, not the amber `soft` one the Used row
                      * uses: "projected" and "our estimate" are caveats about
                      * whether a number is trustworthy, this is only about
                      * which request it describes. Nothing here is doubtful. */}
                    {!cacheReading.fresh && (
                      <span className="agw-ctx-chip">last reported</span>
                    )}
                  </span>
                  <span
                    className="agw-ctx-val"
                    style={{
                      color:
                        cacheReading.readTokens > 0
                          ? "var(--agw-added)"
                          : "var(--agw-text-subtle)",
                    }}
                  >
                    {cacheHitPct}%
                  </span>
                </div>
                <div className="agw-ctx-sub">
                  {formatTokens(cacheReading.readTokens)} cached /{" "}
                  {formatTokens(cacheInput)} input
                </div>
              </>
            )}

            {/* Cost of the whole turn — every request it made, not just the
              * last one. A turn runs one request per tool iteration, so the
              * previous per-request figure under-reported a long turn by the
              * number of tools it used. */}
            <CostSection
              label={isStreaming ? "This turn" : "Last turn"}
              groups={turnGroups}
              lookup={priceLookup}
            />

            {/* The conversation total, summed per model from the transcript so
              * a mid-chat model switch is priced at each model's own rates. */}
            {breakdown && (
              <CostSection
                label="This chat"
                groups={breakdown.byModel}
                lookup={priceLookup}
                subline={formatRequestCount(breakdown.turns, breakdown.requests)}
              />
            )}

            {isCodex && codexUsage && (codexUsage.primary || codexUsage.secondary) && (
              <>
                <div className="agw-ctx-divider" />
                <div className="agw-ctx-card-head">
                  <AgentIcon name="chat" size={11} />
                  <span>ChatGPT plan</span>
                </div>
                {codexUsage.primary && (
                  <CodexQuotaRow win={codexUsage.primary} fallbackLabel="5-hour limit" />
                )}
                {codexUsage.secondary && (
                  <CodexQuotaRow win={codexUsage.secondary} fallbackLabel="Weekly limit" />
                )}
              </>
            )}

            {/* The same section for OpenCode Go, because it answers the same
              * question. A subscription has no per-token price, so the cost
              * figures above read $0.00 for a plan that is genuinely being
              * spent — headroom is the number that means anything here.
              *
              * All three windows, not the tightest one: running out weekly on
              * a Tuesday and running out for the next ten minutes are
              * different problems, and a single blended figure hides which one
              * you are in. */}
            {isOpenCode && openCodeUsage && (
              <>
                <div className="agw-ctx-divider" />
                <div className="agw-ctx-card-head">
                  <AgentIcon name="chat" size={11} />
                  <span>OpenCode plan</span>
                </div>
                {OPENCODE_WINDOWS.map(({ key, label }) => {
                  const win = openCodeUsage[key];
                  if (!win) return null;
                  return (
                    <QuotaRow
                      key={key}
                      label={label}
                      usedPercent={win.percent}
                      caption={openCodeResetLabel(win)}
                    />
                  );
                })}
              </>
            )}

            {/* Command Code, for the same reason as the two above. Its caps are
              * in DOLLARS rather than percent, which is the one number the
              * cost lines above cannot give you here: they price the
              * conversation, this prices what the plan has left.
              *
              * Both windows, not the tighter one — running out for the next
              * forty minutes and running out for the week are different
              * problems. Credits come last because they only matter once a
              * window is spent, but they are what says whether work can
              * continue at all. */}
            {isCommandCode && commandCodeUsage && (
              <>
                <div className="agw-ctx-divider" />
                <div className="agw-ctx-card-head">
                  <AgentIcon name="chat" size={11} />
                  <span>
                    Command Code
                    {commandCodeUsage.planLabel ? ` ${commandCodeUsage.planLabel}` : " plan"}
                  </span>
                </div>
                {commandCodeUsage.limited ? (
                  <>
                    {commandCodeUsage.fiveHour && (
                      <QuotaRow
                        label="Right now"
                        usedPercent={commandCodeWindowRatio(commandCodeUsage.fiveHour) * 100}
                        caption={[
                          `${commandCodeMoney(commandCodeUsage.fiveHour.used)} of ${commandCodeMoney(commandCodeUsage.fiveHour.cap)}`,
                          commandCodeResetLabel(commandCodeUsage.fiveHour),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      />
                    )}
                    {commandCodeUsage.weekly && (
                      <QuotaRow
                        label="This week"
                        usedPercent={commandCodeWindowRatio(commandCodeUsage.weekly) * 100}
                        caption={[
                          `${commandCodeMoney(commandCodeUsage.weekly.used)} of ${commandCodeMoney(commandCodeUsage.weekly.cap)}`,
                          commandCodeResetLabel(commandCodeUsage.weekly),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      />
                    )}
                  </>
                ) : null}
                <div className="agw-ctx-row">
                  <span className="agw-ctx-label">Credits</span>
                  <span className="agw-ctx-val">
                    {commandCodeMoney(
                      commandCodeUsage.credits.monthly +
                        commandCodeUsage.credits.purchased +
                        commandCodeUsage.credits.free,
                    )}{" "}
                    left
                  </span>
                </div>
              </>
            )}

            {/* Cursor, for the same reason as the two above — a subscription
              * turn has no per-token price, so the cost lines read $0.00 while
              * the plan is genuinely being spent.
              *
              * All three buckets, not a blended one: Cursor Models and Other
              * Models empty independently (this account sits at 16% and 100%
              * of the same allowance), and On-Demand is not an allowance at
              * all — it is money billed afterwards. One number would hide
              * which of the three you are actually out of. */}
            {isCursor && cursorUsage && cursorUsage.windows.length > 0 && (
              <>
                <div className="agw-ctx-divider" />
                <div className="agw-ctx-card-head">
                  <AgentIcon name="chat" size={11} />
                  <span>Cursor plan</span>
                </div>
                {/* Cursor's own sentence about its own account, carried
                  * verbatim rather than reworded from the percentages. */}
                {cursorUsage.notice && (
                  <div className="agw-ctx-sub">{cursorUsage.notice}</div>
                )}
                {cursorUsage.windows.map((win) => (
                  <CursorPlanRow key={win.label} win={win} />
                ))}
                {cursorResetLabel(cursorUsage.resetsAtMs) && (
                  <div className="agw-ctx-sub">
                    {cursorResetLabel(cursorUsage.resetsAtMs)}
                  </div>
                )}
              </>
            )}

            {/* kenari, and the reason it looks different from the two above:
              * on a plan, exceeding a window does not fall through to the
              * balance — the request is REFUSED with `plan_limit_reached`, and
              * that applies to every endpoint, not only chat. So this bar is
              * not a cost readout, it is the distance to a hard stop, and it is
              * worth the space even when the cost sections say nothing. */}
            {isKenari && kenariPlan && kenariPlan !== "signed-out" && (
              <>
                <div className="agw-ctx-divider" />
                <div className="agw-ctx-card-head">
                  <AgentIcon name="chat" size={11} />
                  <span>{kenariPlan.planName ? `${kenariPlan.planName} plan` : "kenari plan"}</span>
                  {/* kenari's own judgement, not a threshold Aurora invented. */}
                  {kenariPlan.nearLimit && <span className="agw-ctx-chip">near limit</span>}
                </div>
                {/* Only the windows this plan actually sets. A plan reports no
                  * 5-hour or monthly cap as absent rather than as zero, and
                  * drawing an unset window would render "no limit" as a bar
                  * that is 100% spent. */}
                {KENARI_WINDOWS.map(({ key, label }) => {
                  const win = kenariPlan[key];
                  if (!win) return null;
                  return (
                    <QuotaRow
                      key={key}
                      label={label}
                      /* A FRACTION on the wire (0.202), not a percent. Passed
                       * through raw it draws a 0.2%-full bar over a
                       * fifth-spent week. */
                      usedPercent={win.usedFrac * 100}
                      caption={kenariResetLabel(win)}
                    />
                  );
                })}
                {/* Metered separately from the quota windows and separately
                  * reset, so having plan quota left says nothing about this.
                  * Shown as counts as well as a bar — "37 left" is the number
                  * someone acts on, where a percentage of 200 is arithmetic. */}
                {kenariPlan.webSearchAllowance != null && kenariPlan.webSearchAllowance > 0 && (
                  <QuotaRow
                    label="Web searches"
                    usedPercent={
                      ((kenariPlan.webSearchUsedToday ?? 0) / kenariPlan.webSearchAllowance) * 100
                    }
                    caption={`${Math.max(
                      0,
                      kenariPlan.webSearchAllowance - (kenariPlan.webSearchUsedToday ?? 0),
                    )} of ${kenariPlan.webSearchAllowance} left today`}
                  />
                )}
              </>
            )}

            {/* Said rather than left blank. kenari's key reaches the models but
              * not the account, so this is the one provider where Aurora can
              * be correctly configured and still know nothing about the plan —
              * an empty space here reads as "no limits", which is the opposite
              * of the truth on a plan that refuses requests when it runs out. */}
            {isKenari && kenariPlan === "signed-out" && (
              <>
                <div className="agw-ctx-divider" />
                <div className="agw-ctx-note">
                  <strong>Plan usage not connected</strong> — kenari only reports quota to a
                  signed-in browser, not to an API key. Connect it in Settings › Providers ›
                  kenari.
                </div>
              </>
            )}

            {/* Who counted these numbers. One statement, at the end, where a
              * provenance note belongs — you read the figures first and check
              * where they came from second, which is the order the card now
              * presents them in. */}
            <div className="agw-ctx-source">
              <span className="agw-ctx-source-dot" data-tone={isEstimated ? "soft" : undefined} />
              <span>
                Source
                <strong>{isEstimated ? "local estimate" : "provider"}</strong>
              </span>
            </div>
          </div>,
          portalTarget,
        )}
    </div>
  );
};
