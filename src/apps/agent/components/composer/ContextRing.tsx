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
  claudeCodeUsageGet,
  CLAUDE_CODE_PROVIDER_ID,
  type ClaudeCodeUsageSnapshot,
} from "@/apps/agent/services/providers/claude-code";
import {
  codexUsageGet,
  CODEX_PROVIDER_ID,
  type CodexUsageSnapshot,
} from "@/apps/agent/services/providers/codex";
import {
  fetchOpenCodeUsage,
  OPENCODE_PROVIDER_ID,
  type OpenCodeUsage,
} from "@/apps/agent/services/providers/opencode";
import {
  fetchCommandCodeUsage,
  COMMANDCODE_PROVIDER_ID,
  type CommandCodeUsageSnapshot,
} from "@/apps/agent/services/providers/commandcode";
import {
  fetchKenariUsage,
  isKenariProvider,
  type KenariUsage,
} from "@/apps/agent/services/providers/kenari";
import {
  fetchArkUsage,
  isArkProvider,
  type ArkUsage,
} from "@/apps/agent/services/providers/ark";
import {
  cursorUsageGet,
  CURSOR_PROVIDER_ID,
  type CursorUsageSnapshot,
} from "@/apps/agent/services/providers/cursor";
import {
  fetchMinimaxUsage,
  isMinimaxProvider,
  type MinimaxUsageSnapshot,
} from "@/apps/agent/services/providers/minimax";
import {
  arkPlanView,
  claudeCodePlanView,
  codexPlanView,
  commandCodePlanView,
  cursorPlanView,
  kenariPlanView,
  minimaxPlanView,
  openCodePlanView,
  type LimitLine,
  type LimitTone,
  type PlanView,
} from "@/apps/agent/services/providers/plan-view";
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

/**
 * When the plan figures on screen were actually read.
 *
 * Module-level because the caches are, and safe because at most one provider
 * matches a given conversation — the card never shows two plans at once. This
 * is what the card states in place of the old "Source: provider" footer: the
 * plan block is the one part of this card that can be a minute out of date, so
 * its age is worth a line where the ordinary provenance never was.
 */
let lastPlanReadAt = 0;

/** `0` → nothing read yet. Otherwise "just now" or "38s ago". */
function planAgeLabel(at: number): string | null {
  if (!at) return null;
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 90) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

/** Codex quota. One snapshot serves every ring instance. */
let codexUsageCache: { at: number; snap: CodexUsageSnapshot } | null = null;

async function getCodexUsageCached(): Promise<CodexUsageSnapshot | null> {
  if (codexUsageCache && Date.now() - codexUsageCache.at < PLAN_USAGE_TTL_MS) {
    lastPlanReadAt = codexUsageCache.at;
    return codexUsageCache.snap;
  }
  try {
    const snap = await codexUsageGet();
    codexUsageCache = { at: Date.now(), snap };
    lastPlanReadAt = codexUsageCache.at;
    return snap;
  } catch {
    // Signed out / offline — the tooltip simply omits the quota section.
    return null;
  }
}

/**
 * Claude plan headroom, cached the same way and for the same reason.
 *
 * Unkeyed, like Codex's: the sign-in is one stored credential for the whole
 * app, so there is nothing to key it by.
 */
let claudeCodeUsageCache: { at: number; snap: ClaudeCodeUsageSnapshot } | null = null;

async function getClaudeCodeUsageCached(): Promise<ClaudeCodeUsageSnapshot | null> {
  if (claudeCodeUsageCache && Date.now() - claudeCodeUsageCache.at < PLAN_USAGE_TTL_MS) {
    lastPlanReadAt = claudeCodeUsageCache.at;
    return claudeCodeUsageCache.snap;
  }
  try {
    const snap = await claudeCodeUsageGet();
    claudeCodeUsageCache = { at: Date.now(), snap };
    lastPlanReadAt = claudeCodeUsageCache.at;
    return snap;
  } catch {
    // Signed out, or the sign-in lacks the profile scope the usage endpoint
    // needs — the tooltip omits the section rather than explaining it. The
    // provider card is where a broken sign-in gets a reason.
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
    lastPlanReadAt = openCodeUsageCache.at;
    return openCodeUsageCache.usage;
  }
  try {
    const usage = await fetchOpenCodeUsage(apiKey);
    openCodeUsageCache = { at: Date.now(), key: apiKey, usage };
    lastPlanReadAt = openCodeUsageCache.at;
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
    lastPlanReadAt = commandCodeUsageCache.at;
    return commandCodeUsageCache.usage;
  }
  try {
    const usage = await fetchCommandCodeUsage(apiKey);
    commandCodeUsageCache = { at: Date.now(), key: apiKey, usage };
    lastPlanReadAt = commandCodeUsageCache.at;
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
    lastPlanReadAt = kenariUsageCache.at;
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
  lastPlanReadAt = kenariUsageCache.at;
  return state;
}

/**
 * Volcano Ark Coding Plan headroom, cached the same way.
 *
 * Unkeyed for the same reason kenari's is: the `ark-` key cannot read this at
 * all — Volcano's control plane refuses it before looking up the account — so
 * the figures come from a stored console sign-in and there is one of those.
 *
 * `"signed-out"` is a distinct outcome from `null`, as it is for kenari,
 * because the card says different things about them. No sign-in has an obvious
 * next step; a network failure does not, and offering "sign in" over one sends
 * someone to re-authenticate a session that was working fine.
 */
type ArkPlanState = ArkUsage | "signed-out" | null;

let arkUsageCache: { at: number; state: ArkPlanState } | null = null;

async function getArkUsageCached(): Promise<ArkPlanState> {
  if (arkUsageCache && Date.now() - arkUsageCache.at < PLAN_USAGE_TTL_MS) {
    lastPlanReadAt = arkUsageCache.at;
    return arkUsageCache.state;
  }
  let state: ArkPlanState = null;
  try {
    state = await fetchArkUsage();
  } catch {
    // Rust refuses with a message for both "never signed in" and "the session
    // expired", and the honest answer to each is the same one: sign in.
    state = "signed-out";
  }
  arkUsageCache = { at: Date.now(), state };
  lastPlanReadAt = arkUsageCache.at;
  return state;
}

/**
 * Cursor plan usage, cached the same way and for the same reason.
 *
 * Unkeyed, like kenari's: the session comes from the Cursor desktop install
 * and there is exactly one of it.
 */
let cursorUsageCache: { at: number; snap: CursorUsageSnapshot } | null = null;

/**
 * MiniMax Token Plan headroom, cached the same way and for the same reason.
 *
 * Keyed by the API key like OpenCode's: MiniMax's subscription key is both the
 * chat credential and the account credential, so pasting a different one is a
 * different account and must not be served a minute of the previous one's
 * numbers.
 */
let minimaxUsageCache: { at: number; key: string; usage: MinimaxUsageSnapshot } | null = null;

async function getMinimaxUsageCached(apiKey: string): Promise<MinimaxUsageSnapshot | null> {
  if (
    minimaxUsageCache &&
    minimaxUsageCache.key === apiKey &&
    Date.now() - minimaxUsageCache.at < PLAN_USAGE_TTL_MS
  ) {
    lastPlanReadAt = minimaxUsageCache.at;
    return minimaxUsageCache.usage;
  }
  try {
    const usage = await fetchMinimaxUsage(apiKey);
    minimaxUsageCache = { at: Date.now(), key: apiKey, usage };
    lastPlanReadAt = minimaxUsageCache.at;
    return usage;
  } catch {
    // No key yet, a pay-as-you-go key that cannot read the account, or offline.
    // The section is omitted rather than shown empty; the provider page is
    // where a broken key gets explained.
    return null;
  }
}

async function getCursorUsageCached(): Promise<CursorUsageSnapshot | null> {
  if (cursorUsageCache && Date.now() - cursorUsageCache.at < PLAN_USAGE_TTL_MS) {
    lastPlanReadAt = cursorUsageCache.at;
    return cursorUsageCache.snap;
  }
  try {
    const snap = await cursorUsageGet();
    cursorUsageCache = { at: Date.now(), snap };
    lastPlanReadAt = cursorUsageCache.at;
    return snap;
  } catch {
    // Not connected, or the account reported nothing readable — the tooltip
    // omits the section rather than explaining it. The provider page is where
    // a broken read gets a reason.
    return null;
  }
}

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

/** A tone name from [`PlanView`] → the token that paints it. */
const TONE_COLOR: Record<LimitTone, string> = {
  good: "var(--agw-added)",
  warn: "var(--agw-warning)",
  bad: "var(--agw-removed)",
};

/**
 * One metered bucket: a name, a fill, a value, and when it comes back.
 *
 * Provider-agnostic by construction — everything provider-specific was already
 * said by `plan-view.ts`, which is why this renders Codex's two windows,
 * Cursor's five buckets and Command Code's dollar caps without knowing which
 * it is drawing. The value is what the reader acts on, so it carries the
 * colour; the bar is the supporting glance.
 */
const LimitRow: React.FC<{ line: LimitLine }> = ({ line }) => (
  <div className="agw-ctx-limit">
    <div className="agw-ctx-limit-top">
      <span className="agw-ctx-limit-name">{line.name}</span>
      <span className="agw-ctx-limit-val" style={{ color: TONE_COLOR[line.tone] }}>
        {line.value}
      </span>
    </div>
    <div className="agw-ctx-bar agw-ctx-limit-bar">
      <div
        className="agw-ctx-bar-fill"
        style={{ width: `${line.fillPercent}%`, background: TONE_COLOR[line.tone] }}
      />
    </div>
    {line.caption && <div className="agw-ctx-sub">{line.caption}</div>}
  </div>
);

/**
 * The whole subscription block, or nothing.
 *
 * `readAgo` is where the old "Source: provider" footer went. That row said the
 * ordinary thing on every hover, which trains the eye to skip it, so by the
 * time it had news nobody was reading it. The plan figures are the one part of
 * this card that can be genuinely out of date — they are fetched on open and
 * held for a minute — so their AGE is the honest thing to say, and it is said
 * where it applies instead of over the whole card.
 */
const PlanSection: React.FC<{ view: PlanView; readAgo: string | null }> = ({ view, readAgo }) => (
  <>
    <div className="agw-ctx-divider" />
    <div className="agw-ctx-section">
      <span className="agw-ctx-section-name">{view.title}</span>
      {view.flag && <span className="agw-ctx-chip">{view.flag}</span>}
      {readAgo && <span className="agw-ctx-section-age">read {readAgo}</span>}
    </div>
    {view.limits.map((line) => (
      <LimitRow key={line.name} line={line} />
    ))}
    {/* The provider's own words about the provider's own account. Set as a
      * quotation rather than a row, because it is a sentence somebody else
      * wrote and not a measurement Aurora took. */}
    {view.notice && <div className="agw-ctx-quote">{view.notice}</div>}
    {view.balance && (
      <div className="agw-ctx-row agw-ctx-balance">
        <span className="agw-ctx-label">{view.balance.label}</span>
        <span className="agw-ctx-val">{view.balance.value}</span>
      </div>
    )}
  </>
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
  // Primitive selector: the tokens, not the `{model, tokens}` record — reading
  // the object would hand zustand a fresh reference every render. The model
  // inside it is the store's business (it decides when the floor survives a
  // model switch); the ring only ever needs the number.
  const contextFloor = useAgentContextStore((s) =>
    currentThreadId ? (s.contextFloorByThread[currentThreadId]?.tokens ?? 0) : 0,
  );

  const contextWindow = useSettingsStore(
    (s) => s.getLLMConfigFor(selectedModel)?.contextWindow ?? 128_000,
  );
  const isCodex = selectedModel.startsWith(`${CODEX_PROVIDER_ID}:`);
  // The Claude subscription meters the same way Codex does — rolling windows,
  // no per-token bill — so the cost figures above are $0.00 for a conversation
  // that is genuinely spending, and the windows are the whole reading.
  const isClaudeCode = selectedModel.startsWith(`${CLAUDE_CODE_PROVIDER_ID}:`);
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
  // And the fifth: a Token Plan meters a rolling 5-hour and a weekly window,
  // and refuses the request when one runs out. Recognised like kenari rather
  // than by an id prefix, because a row someone added themselves carries a
  // UUID and declares itself through `providerType`.
  const isMinimax = useSettingsStore((s) => {
    const split = selectedModel.indexOf(":");
    if (split <= 0) return false;
    const row = s.providers.find((p) => p.id === selectedModel.slice(0, split));
    return row ? isMinimaxProvider(row) : false;
  });
  // The subscription key, which is also the chat key. Read from the row so
  // pasting a new one changes what the ring reports.
  const minimaxKey = useSettingsStore((s) => {
    const split = selectedModel.indexOf(":");
    if (split <= 0) return "";
    return s.providers.find((p) => p.id === selectedModel.slice(0, split))?.apiKey ?? "";
  });
  const isKenari = useSettingsStore((s) => {
    // First colon only — a provider id never contains one, a model key can.
    const split = selectedModel.indexOf(":");
    if (split <= 0) return false;
    const providerId = selectedModel.slice(0, split);
    const row = s.providers.find((p) => p.id === providerId);
    return row ? isKenariProvider(row) : false;
  });
  // And the sixth: Volcano's Coding Plan meters a rolling five-hour window, a
  // week and a month, all as a share. Recognised like kenari and MiniMax rather
  // than by an id prefix, because a row someone added themselves carries a UUID
  // and declares itself through `providerType`.
  const isArk = useSettingsStore((s) => {
    const split = selectedModel.indexOf(":");
    if (split <= 0) return false;
    const row = s.providers.find((p) => p.id === selectedModel.slice(0, split));
    return row ? isArkProvider(row) : false;
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
  const [claudeCodeUsage, setClaudeCodeUsage] = useState<ClaudeCodeUsageSnapshot | null>(null);
  const [openCodeUsage, setOpenCodeUsage] = useState<OpenCodeUsage | null>(null);
  const [commandCodeUsage, setCommandCodeUsage] = useState<CommandCodeUsageSnapshot | null>(
    null,
  );
  const [kenariPlan, setKenariPlan] = useState<KenariPlanState>(null);
  const [arkPlan, setArkPlan] = useState<ArkPlanState>(null);
  const [cursorUsage, setCursorUsage] = useState<CursorUsageSnapshot | null>(null);
  const [minimaxUsage, setMinimaxUsage] = useState<MinimaxUsageSnapshot | null>(null);
  // When the plan figures above were read. Stamped from the cache entry that
  // served them, not from the moment the promise resolved — a cache hit is a
  // minute-old reading and saying "just now" over it would be the same kind of
  // false confidence the source footer used to project. See `lastPlanReadAt`.
  const [planReadAt, setPlanReadAt] = useState(0);
  const stampPlanRead = useCallback(() => setPlanReadAt(lastPlanReadAt), []);

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
        stampPlanRead();
      });
      return;
    }
    // Nothing to gate on, like Codex's: the credential is a stored sign-in,
    // and whether there is one is exactly what this asks.
    if (isClaudeCode) {
      void getClaudeCodeUsageCached().then((snap) => {
        if (snap) setClaudeCodeUsage(snap);
        stampPlanRead();
      });
      return;
    }
    if (isOpenCode && openCodeKey) {
      void getOpenCodeUsageCached(openCodeKey).then((usage) => {
        if (usage) setOpenCodeUsage(usage);
        stampPlanRead();
      });
      return;
    }
    // No key gate, unlike OpenCode's: an empty key means "use the one the CLI
    // stored", which is a working account, not a missing one.
    if (isCommandCode) {
      void getCommandCodeUsageCached(commandCodeKey).then((usage) => {
        if (usage) setCommandCodeUsage(usage);
        stampPlanRead();
      });
      return;
    }
    // No key to gate on, unlike the other two: kenari's plan data comes from a
    // stored sign-in, and whether there is one is exactly what this asks.
    if (isKenari) {
      void getKenariUsageCached().then((state) => {
        setKenariPlan(state);
        stampPlanRead();
      });
      return;
    }
    // No key to gate on, like kenari's: Volcano's control plane refuses the
    // `ark-` key outright, so the plan data comes from a stored console
    // sign-in and whether there is one is exactly what this asks.
    if (isArk) {
      void getArkUsageCached().then((state) => {
        setArkPlan(state);
        stampPlanRead();
      });
      return;
    }
    // Gated on the key, like OpenCode's: MiniMax has nothing on disk to fall
    // back to, so with nothing pasted there is no account to ask.
    if (isMinimax && minimaxKey) {
      void getMinimaxUsageCached(minimaxKey).then((usage) => {
        if (usage) setMinimaxUsage(usage);
        stampPlanRead();
      });
      return;
    }
    // Nothing to gate on here either: the session is the Cursor app's, and
    // whether Aurora has adopted one is exactly what this asks.
    if (isCursor) {
      void getCursorUsageCached().then((snap) => {
        if (snap) setCursorUsage(snap);
        stampPlanRead();
      });
    }
  }, [
    isCodex,
    isClaudeCode,
    isOpenCode,
    isCommandCode,
    isKenari,
    isArk,
    isMinimax,
    isCursor,
    openCodeKey,
    commandCodeKey,
    minimaxKey,
    stampPlanRead,
  ]);

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
  // The three input slices, side by side, in the order they cost money:
  // a read is cheap, a write costs more than plain input, fresh is full price.
  // The hit percentage alone says none of that — it cannot tell a turn that
  // just rebuilt its whole cache from one that is quietly re-reading it.
  const cacheShare = (n: number) => (cacheInput > 0 ? (n / cacheInput) * 100 : 0);

  // Whichever subscription this conversation's model belongs to, already
  // reduced to a list of limits. At most one can match — the card never shows
  // two plans — so the chain below never fans out.
  const planView: PlanView | null = isCodex
    ? codexPlanView(codexUsage)
    : isClaudeCode
      ? claudeCodePlanView(claudeCodeUsage)
      : isOpenCode && openCodeUsage
        ? openCodePlanView(openCodeUsage)
        : isCommandCode && commandCodeUsage
          ? commandCodePlanView(commandCodeUsage)
          : isKenari && kenariPlan && kenariPlan !== "signed-out"
            ? kenariPlanView(kenariPlan)
            : isArk && arkPlan && arkPlan !== "signed-out"
              ? arkPlanView(arkPlan)
              : isMinimax
                ? minimaxPlanView(minimaxUsage)
                : isCursor && cursorUsage
                  ? cursorPlanView(cursorUsage)
                  : null;

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
            {/* Who is being measured, and the one caveat that outranks every
              * number under it.
              *
              * This is where the "Source: provider" footer went. That row said
              * the ordinary thing on every single hover, which teaches the eye
              * to skip it — so by the time it had news, nobody was reading it.
              * Provenance now speaks only when it has some: this chip, plus the
              * tilde carried by each figure it applies to. */}
            <div className="agw-ctx-head">
              <span className="agw-ctx-who">
                {modelLabel(selectedModel) ?? "Context window"}
              </span>
              {isEstimated && (
                <span className="agw-ctx-chip" data-tone="soft">
                  counted here
                </span>
              )}
            </div>

            {/* The one number this card exists to answer, at a size that can be
              * read without focusing on it. Everything below is a tier down. */}
            <div className="agw-ctx-hero">
              <span className="agw-ctx-hero-n" style={{ color }}>
                {approx}{pct}
              </span>
              <span className="agw-ctx-hero-u" style={{ color }}>
                %
              </span>
              {/* One line. Broken across two it read as two separate figures
                * stacked, and the eye had to reassemble "47.9K of" and "500.0K"
                * into the one fact they are. */}
              <span className="agw-ctx-hero-r">
                {approx}{formatTokens(usedTokens)} of {formatTokens(total)}
              </span>
            </div>
            <div className="agw-ctx-bar agw-ctx-hero-bar">
              <div className="agw-ctx-bar-fill" style={{ width: `${pct}%`, background: color }} />
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
                <div className="agw-ctx-row">
                  <span className="agw-ctx-label">
                    Cache hit
                    {/* Said on the row rather than by disappearing. The
                      * numbers were measured, just not on the newest request —
                      * a distinction worth one word and not worth a blank.
                      *
                      * Neutral chip, not the amber `soft` one the head uses:
                      * "counted here" is a caveat about whether a number can be
                      * trusted, this is only about which request it describes.
                      * Nothing here is doubtful. */}
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
                {/* The three input slices, side by side, in the order they
                  * cost money: a read is cheap, a write costs MORE than plain
                  * input, and fresh is full price. They are disjoint and they
                  * sum to the input, so laying them end to end is the true
                  * picture rather than a decoration.
                  *
                  * The percentage alone cannot separate a turn that is quietly
                  * re-reading its cache from one that just rebuilt the whole
                  * thing — both can read 79%, and only one of them is cheap. */}
                <div className="agw-ctx-bar agw-ctx-cache-split">
                  <div
                    className="agw-ctx-bar-fill"
                    style={{
                      width: `${cacheShare(cacheReading.readTokens)}%`,
                      background: "var(--agw-added)",
                    }}
                  />
                  <div
                    className="agw-ctx-bar-fill"
                    style={{
                      width: `${cacheShare(cacheReading.writeTokens)}%`,
                      background: "var(--agw-warning)",
                    }}
                  />
                  <div
                    className="agw-ctx-bar-fill"
                    style={{
                      width: `${cacheShare(cacheReading.promptTokens)}%`,
                      background: "color-mix(in srgb, var(--agw-text) 22%, transparent)",
                    }}
                  />
                </div>
                <div className="agw-ctx-parts">
                  <span>
                    <b style={{ color: "var(--agw-added)" }}>
                      {formatTokens(cacheReading.readTokens)}
                    </b>{" "}
                    cached
                  </span>
                  <span>
                    <b style={{ color: "var(--agw-warning)" }}>
                      {formatTokens(cacheReading.writeTokens)}
                    </b>{" "}
                    written
                  </span>
                  <span>
                    <b>{formatTokens(cacheReading.promptTokens)}</b> fresh
                  </span>
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

            {/* ONE plan section for every subscription Aurora can read.
              *
              * This replaced five hand-written blocks — Codex, OpenCode,
              * Command Code, Cursor, kenari — that had drifted apart: Codex
              * grew a credit balance the card never drew, Cursor needed a row
              * type the others did not have, and a sixth provider meant a
              * sixth block. `plan-view.ts` does the per-provider wording; this
              * renders a list and knows nothing about who filled it. */}
            {planView && <PlanSection view={planView} readAgo={planAgeLabel(planReadAt)} />}

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

            {/* Said rather than left blank, for kenari's reason: the Coding
              * Plan key reaches the models but Volcano's control plane refuses
              * it, so this is the second provider where Aurora can be correctly
              * configured and still know nothing about the quota. A plan that
              * stops serving when a window runs out must not render that as
              * empty space. */}
            {isArk && arkPlan === "signed-out" && (
              <>
                <div className="agw-ctx-divider" />
                <div className="agw-ctx-note">
                  <strong>Plan usage not connected</strong> — Volcano reports Coding Plan quota
                  to a signed-in console, not to an API key. Connect it in Settings › Providers ›
                  Volcano Ark.
                </div>
              </>
            )}

            {/* No provenance footer. It said "Source: provider" on every
              * ordinary hover, which is the shape of a row people learn to
              * skip — and a row nobody reads is worthless on the day it has
              * something to say. What replaced it says something only when
              * there is something: the amber chip in the head when Aurora did
              * the counting, and the read-time on the plan block, whose
              * figures are the one part of this card that can be a minute old. */}
          </div>,
          portalTarget,
        )}
    </div>
  );
};
