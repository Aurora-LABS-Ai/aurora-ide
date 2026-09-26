/**
 * One shape for every subscription Aurora can read.
 *
 * The context card used to carry five hand-written plan sections, one per
 * provider, each with its own JSX, its own row order and its own idea of what
 * a limit looks like. They drifted: Codex grew a credit balance the card never
 * drew, Cursor's overage needed a row type the others did not have, and adding
 * a sixth provider meant adding a sixth block.
 *
 * Every one of them is really saying the same four things about a bucket:
 * what it is called, how much of it is gone, what the reader should act on,
 * and when it comes back. Normalising to that here means the card renders a
 * list and knows nothing about who filled it.
 *
 * What each provider keeps to itself is the WORDING, and that stays with the
 * provider on purpose:
 *
 * - the bucket's name is the provider's own ("Cursor Models", "This week")
 * - the value is worded by the provider's own rules, because the units differ.
 *   Codex, kenari and OpenCode meter a share and read as `66% left`. Command
 *   Code meters dollars against a cap, where a percentage would be a unit it
 *   never used. Cursor does both, and its on-demand bucket bills PAST its cap,
 *   where `-1% left` is not what an overage means.
 */

import {
  ARK_WINDOWS,
  arkResetLabel,
  arkTierLabel,
  type ArkUsage,
} from "./ark";
import {
  claudeCodePlanLabel,
  claudeCodeResetLabel,
  type ClaudeCodeUsageSnapshot,
  type ClaudeCodeUsageWindow,
} from "./claude-code";
import {
  codexCreditsLabel,
  codexFmtDuration,
  codexWindowLabel,
  type CodexUsageSnapshot,
  type CodexUsageWindow,
} from "./codex";
import {
  commandCodeMoney,
  commandCodeResetLabel,
  commandCodeWindowRatio,
  type CommandCodeUsageSnapshot,
  type CommandCodeWindow,
} from "./commandcode";
import {
  cursorMeterValue,
  cursorResetLabel,
  cursorUsd,
  type CursorUsageSnapshot,
} from "./cursor";
import {
  deepseekBalanceLabel,
  deepseekRateLabel,
  deepseekRateWindow,
  type DeepSeekBalanceSnapshot,
} from "./deepseek";
import {
  kenariResetLabel,
  KENARI_WINDOWS,
  type KenariUsage,
} from "./kenari";
import {
  minimaxGeneralQuota,
  minimaxResetLabel,
  type MinimaxUsageSnapshot,
} from "./minimax";
import { openCodeResetLabel, type OpenCodeUsage } from "./opencode";

export type LimitTone = "good" | "warn" | "bad";

/** One metered bucket, however the provider happens to measure it. */
export interface LimitLine {
  /** The provider's own name for the bucket. */
  name: string;
  /** 0–100, clamped, for the bar only. An overage is carried by `tone`. */
  fillPercent: number;
  /** What the reader acts on: `66% left`, `$70.46 of $70`, `37 of 200 left`. */
  value: string;
  /** Reset countdown or status. */
  caption: string | null;
  tone: LimitTone;
}

/** A balance that outlives the windows: credits, or money billed on top. */
export interface PlanBalance {
  label: string;
  value: string;
}

export interface PlanView {
  /** Names the account, e.g. "ChatGPT plan", "Studio plan". */
  title: string;
  limits: LimitLine[];
  balance: PlanBalance | null;
  /** The provider's own sentence about the account, carried verbatim. */
  notice: string | null;
  /** The provider's own judgement, never a threshold Aurora invented. */
  flag: string | null;
}

/**
 * The same bands the context ring uses, so a bar means one thing on this card.
 * Colour never carries the meaning alone: the value sits beside every bar.
 */
export function limitTone(spentPercent: number): LimitTone {
  if (spentPercent >= 85) return "bad";
  if (spentPercent >= 60) return "warn";
  return "good";
}

const clamp = (n: number): number => Math.min(100, Math.max(0, n));

/** `34` spent → `66% left`. Rounded once, here, so no two rows disagree. */
function leftLabel(spentPercent: number): string {
  return `${Math.max(0, Math.round(100 - spentPercent))}% left`;
}

/** A share-metered bucket. Codex, kenari, OpenCode and Cursor's quotas. */
function quotaLine(name: string, spentPercent: number, caption: string | null): LimitLine {
  const spent = clamp(spentPercent);
  return { name, fillPercent: spent, value: leftLabel(spent), caption, tone: limitTone(spent) };
}

// ── Codex ────────────────────────────────────────────────────────────────────

function codexLine(win: CodexUsageWindow, fallback: string): LimitLine {
  return quotaLine(
    codexWindowLabel(win, fallback),
    win.usedPercent,
    win.resetsInSeconds != null ? `resets in ${codexFmtDuration(win.resetsInSeconds)}` : null,
  );
}

/**
 * `null` when the snapshot says nothing at all — no windows and no balance.
 * An empty section is worse than none: on a plan that refuses requests when it
 * runs out, blank space reads as "no limits".
 */
export function codexPlanView(snap: CodexUsageSnapshot | null): PlanView | null {
  if (!snap) return null;
  const limits: LimitLine[] = [];
  if (snap.primary) limits.push(codexLine(snap.primary, "5-hour limit"));
  if (snap.secondary) limits.push(codexLine(snap.secondary, "Weekly limit"));
  // Credits are the reason work continues once a window is spent, so they are
  // part of whether this section exists at all, not just part of its body.
  const credits = codexCreditsLabel(snap.credits);
  if (limits.length === 0 && !credits) return null;
  return {
    title: "ChatGPT plan",
    limits,
    balance: credits ? { label: "Credits", value: credits } : null,
    notice: null,
    flag: null,
  };
}

// ── Claude Code (claude.ai subscription) ─────────────────────────────────────

/** A plain count, for a bucket whose units the plan never named. */
function plainNumber(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * The plan's rolling windows, plus extra usage when the account has it on.
 *
 * Four windows can come back and only two are always present: the five-hour
 * and the week are the plan itself, while the per-model weekly buckets exist
 * only on the plans that meter Opus and Sonnet separately. Each is drawn only
 * when the account reported it — an unset window rendered as zero would say
 * "spent" about a limit that does not exist.
 *
 * No `flag`. Every other provider's flag is the provider's own judgement
 * (`nearLimit`, `belowThreshold`); this endpoint makes none, and a threshold
 * invented here would put Aurora's opinion in a slot readers have learned to
 * take as the account's.
 *
 * `null` when there is nothing at all to draw, for the reason `codexPlanView`
 * returns it: on a plan that stops serving when it runs out, an empty section
 * reads as "no limits".
 */
export function claudeCodePlanView(snap: ClaudeCodeUsageSnapshot | null): PlanView | null {
  if (!snap) return null;
  const windows: Array<[ClaudeCodeUsageWindow | null, string]> = [
    [snap.fiveHour, "Right now"],
    [snap.sevenDay, "This week"],
    [snap.sevenDayOpus, "Opus this week"],
    [snap.sevenDaySonnet, "Sonnet this week"],
    // Fable and any other model the server names; the label is the server's.
    ...(snap.sevenDayModels ?? []).map(
      (m): [ClaudeCodeUsageWindow | null, string] => [m.window, `${m.model} this week`],
    ),
  ];
  const limits: LimitLine[] = [];
  for (const [win, label] of windows) {
    if (!win) continue;
    limits.push(quotaLine(label, win.usedPercent, claudeCodeResetLabel(win)));
  }

  // Extra usage is what keeps the account working once the plan windows are
  // spent, so it belongs in the same list rather than in a footnote — and like
  // Cursor's on-demand bucket it is billed on top, which the caption says
  // because a bar alone cannot.
  const extra = snap.extraUsage;
  if (extra?.enabled) {
    if (extra.monthlyLimit != null && extra.monthlyLimit > 0 && extra.usedCredits != null) {
      const spent = clamp((extra.usedCredits / extra.monthlyLimit) * 100);
      limits.push({
        name: "Extra usage",
        fillPercent: spent,
        // A count against its cap, not a share: the plan meters this in
        // credits and never states a percentage of them.
        value: `${plainNumber(extra.usedCredits)} of ${plainNumber(extra.monthlyLimit)}`,
        caption: "billed on top of the plan",
        tone: limitTone(spent),
      });
    } else if (extra.usedPercent != null) {
      limits.push(quotaLine("Extra usage", extra.usedPercent, "billed on top of the plan"));
    }
  }

  if (limits.length === 0) return null;
  const plan = claudeCodePlanLabel(snap.plan);
  return {
    title: plan ? `Claude ${plan} plan` : "Claude plan",
    limits,
    balance: null,
    notice: null,
    flag: null,
  };
}

// ── kenari ───────────────────────────────────────────────────────────────────

/**
 * Only the windows this plan actually sets. A plan reports an unset window as
 * absent rather than as zero, and drawing one would render "no limit" as a bar
 * that is fully spent.
 */
export function kenariPlanView(usage: KenariUsage): PlanView {
  const limits: LimitLine[] = [];
  for (const { key, label } of KENARI_WINDOWS) {
    const win = usage[key];
    if (!win) continue;
    // A FRACTION on the wire (0.202), not a percent.
    limits.push(quotaLine(label, win.usedFrac * 100, kenariResetLabel(win)));
  }
  // Metered and reset separately from the plan windows, so having quota left
  // says nothing about this. Counted in searches, because "18% left of 200" is
  // arithmetic and "37 left" is the number someone acts on.
  const allowance = usage.webSearchAllowance ?? 0;
  if (allowance > 0) {
    const used = usage.webSearchUsedToday ?? 0;
    const spent = clamp((used / allowance) * 100);
    limits.push({
      name: "Web searches",
      fillPercent: spent,
      value: `${Math.max(0, allowance - used)} of ${allowance} left`,
      caption: "resets daily",
      tone: limitTone(spent),
    });
  }
  return {
    title: usage.planName ? `${usage.planName} plan` : "kenari plan",
    limits,
    balance: null,
    notice: null,
    flag: usage.nearLimit ? "near limit" : null,
  };
}

// ── Volcano Ark Coding Plan ──────────────────────────────────────────────────

/**
 * Three windows, all metered as a share.
 *
 * The one provider here where a percentage is not a simplification of
 * something better: Volcano publishes no request count in the API at all, so
 * `66% left` is the account's own unit rather than a ratio Aurora derived.
 *
 * `null` when not one window came back. An empty section reads as "no limits",
 * which is the opposite of the truth on a plan that stops serving when a window
 * runs out.
 */
export function arkPlanView(usage: ArkUsage | null): PlanView | null {
  if (!usage) return null;
  const limits: LimitLine[] = [];
  for (const { key, label } of ARK_WINDOWS) {
    const win = usage[key];
    if (!win) continue;
    // Already a PERCENT on the wire (1.55 for 1.55% spent), unlike kenari's
    // fraction. Multiplying by 100 here would draw a full bar over an
    // untouched window.
    limits.push(quotaLine(label, win.usedPercent, arkResetLabel(win)));
  }
  if (limits.length === 0) return null;
  const tier = arkTierLabel(usage.tier);
  return {
    title: tier ? `Coding Plan ${tier}` : "Coding Plan",
    limits,
    balance: null,
    // Volcano's own word for the subscription's state, carried verbatim and
    // only when it is not the ordinary one. "Running" on every card would be
    // a row nobody reads by the second time they see it.
    notice:
      usage.status && usage.status.toLowerCase() !== "running"
        ? `Subscription status: ${usage.status}`
        : null,
    // Bonus quota is the account's own flag, not a threshold invented here.
    flag: usage.hasReward ? "bonus quota" : null,
  };
}

// ── OpenCode Go ──────────────────────────────────────────────────────────────

export function openCodePlanView(usage: OpenCodeUsage): PlanView {
  const windows: Array<[keyof OpenCodeUsage, string]> = [
    ["rolling", "Right now"],
    ["weekly", "This week"],
    ["monthly", "This month"],
  ];
  const limits: LimitLine[] = [];
  for (const [key, label] of windows) {
    const win = usage[key];
    if (!win) continue;
    limits.push(quotaLine(label, win.percent, openCodeResetLabel(win)));
  }
  return { title: "OpenCode plan", limits, balance: null, notice: null, flag: null };
}

// ── Command Code ─────────────────────────────────────────────────────────────

function commandCodeLine(name: string, win: CommandCodeWindow): LimitLine {
  const spent = clamp(commandCodeWindowRatio(win) * 100);
  return {
    name,
    fillPercent: spent,
    // Dollars, not a share. A percentage here is a unit the provider never
    // used, and the cap is the thing the reader is actually near.
    value: `${commandCodeMoney(win.used)} of ${commandCodeMoney(win.cap)}`,
    caption: commandCodeResetLabel(win),
    tone: win.exceeded ? "bad" : limitTone(spent),
  };
}

export function commandCodePlanView(snap: CommandCodeUsageSnapshot): PlanView {
  const limits: LimitLine[] = [];
  // Some plans report no windows at all, and a meter would invent a ceiling.
  if (snap.limited) {
    if (snap.fiveHour) limits.push(commandCodeLine("Right now", snap.fiveHour));
    if (snap.weekly) limits.push(commandCodeLine("This week", snap.weekly));
  }
  const credits = snap.credits.monthly + snap.credits.purchased + snap.credits.free;
  return {
    title: snap.planLabel ? `Command Code ${snap.planLabel}` : "Command Code plan",
    limits,
    balance: { label: "Credits", value: `${commandCodeMoney(credits)} left` },
    notice: null,
    flag: snap.credits.belowThreshold ? "low credits" : null,
  };
}

// ── MiniMax ──────────────────────────────────────────────────────────────────

/**
 * The Token Plan's two windows: rolling five hours, and the week.
 *
 * Only the `general` bucket. MiniMax also meters `video`, which a coding agent
 * never touches, and drawing it would put a bar on the card for something this
 * conversation cannot spend.
 *
 * The counts are deliberately ignored. On a live Max plan the text bucket
 * reports `total_count: 0` and `usage_count: 0` beside `remaining_percent:
 * 100`, because text is metered as a share rather than counted; `video` is the
 * one that carries real counts. Rendering "0 of 0" would say the plan was
 * exhausted when it is untouched.
 *
 * `null` when the account reports no text bucket at all — an empty section
 * reads as "no limits", which is the opposite of the truth on a plan that stops
 * serving when it runs out.
 */
export function minimaxPlanView(snap: MinimaxUsageSnapshot | null): PlanView | null {
  const general = minimaxGeneralQuota(snap);
  if (!general) return null;
  // Reported as REMAINING; every limit line here is drawn from what is SPENT.
  const spentNow = clamp(100 - general.intervalRemainingPercent);
  const spentWeek = clamp(100 - general.weeklyRemainingPercent);
  return {
    title: "MiniMax Token Plan",
    limits: [
      {
        name: "Right now",
        fillPercent: spentNow,
        value: leftLabel(spentNow),
        caption: minimaxResetLabel(general.intervalResetsInMs),
        tone: limitTone(spentNow),
      },
      {
        name: "This week",
        fillPercent: spentWeek,
        value: leftLabel(spentWeek),
        caption: minimaxResetLabel(general.weeklyResetsInMs),
        tone: limitTone(spentWeek),
      },
    ],
    balance: null,
    notice: null,
    flag: null,
  };
}

// ── DeepSeek ─────────────────────────────────────────────────────────────────

/**
 * The only member of this family with no meter, on purpose.
 *
 * Every other provider here sells a window that refills and refuses requests
 * when it empties, so a bar is the reading. DeepSeek is pay-as-you-go: there
 * is no ceiling to fill, no reset to count down to, and running out is a 402
 * on the next request. Drawing a bar would need a maximum, and the only
 * honest one is the balance itself — a bar that is always full until the
 * moment it is empty says nothing at all.
 *
 * So this section is a balance and a sentence. The sentence is the rate
 * window, and it belongs here rather than on the provider card alone: the cost
 * figures directly above it on this card are the OFF-PEAK price, and during
 * peak hours the real charge is double them.
 */
export function deepseekPlanView(
  snap: DeepSeekBalanceSnapshot | null,
  now: Date = new Date(),
): PlanView | null {
  if (!snap) return null;
  return {
    title: "DeepSeek account",
    // No windows. See above — this account does not meter one.
    limits: [],
    balance: { label: "Balance", value: deepseekBalanceLabel(snap) },
    notice: deepseekRateLabel(deepseekRateWindow(now)),
    // DeepSeek's own judgement, not a threshold Aurora invented. It is the
    // difference between a low balance and an account that has already
    // stopped serving.
    flag: snap.isAvailable ? null : "out of balance",
  };
}

// ── Cursor ───────────────────────────────────────────────────────────────────

export function cursorPlanView(snap: CursorUsageSnapshot): PlanView {
  const limits: LimitLine[] = snap.windows.map((win) => {
    const spent = clamp(win.usedPercent);
    if (win.kind === "quota") {
      return quotaLine(win.label, spent, null);
    }
    // Spend. Deliberately not a share: this bucket bills PAST its cap, and
    // "-1% left" is not what an overage means. `$70.46 of $70` needs no
    // adjective. Past the cap it is coloured as the hard stop it is rather
    // than by a percentage that has stopped moving.
    const over = win.usedUsd != null && win.limitUsd != null && win.usedUsd > win.limitUsd;
    return {
      name: win.label,
      fillPercent: spent,
      value: cursorMeterValue(win),
      caption: over ? "billed on top of the subscription" : null,
      tone: over ? "bad" : limitTone(spent),
    };
  });
  const reset = cursorResetLabel(snap.resetsAtMs);
  // The cycle rollover belongs to the whole account here, not to one bucket,
  // so it rides on the last row rather than being repeated on every one.
  if (reset && limits.length > 0) {
    limits[limits.length - 1] = { ...limits[limits.length - 1], caption: reset };
  }
  return {
    title: "Cursor plan",
    limits,
    balance:
      snap.bonusUsd != null && snap.bonusUsd > 0
        ? { label: "Bonus", value: cursorUsd(snap.bonusUsd) }
        : null,
    // Cursor's own sentence about its own account, carried verbatim rather
    // than reworded from the percentages.
    notice: snap.notice,
    flag: null,
  };
}
