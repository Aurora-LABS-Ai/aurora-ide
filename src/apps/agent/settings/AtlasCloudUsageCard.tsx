/**
 * Agent Window — Atlas Cloud usage card (view).
 *
 * Rendered inside the Providers detail pane for the Atlas Cloud provider. Atlas
 * meters the Coding Plan in *credits*; this card fetches the plan + real
 * per-request history and converts credits into an honest **token** estimate,
 * using the account's own recent input/output/cache mix. Pure `--agw-*` tokens
 * so it matches the agent window's dedicated theme.
 *
 * A compact carousel keeps it dense: Plan · Tokens left · Usage · Recent · By model.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";

import type { LLMProvider } from "@/apps/agent/store/settings/useAgentSettingsStore";
import {
  creditsToTokens,
  deriveAtlasOrigin,
  effectiveRate,
  fetchAllCosts,
  fetchAtlasTextModels,
  fetchBalance,
  fetchCodePlan,
  fmtCompact,
  fmtInt,
  fmtRelative,
  multipliersFromPrice,
  shortModel,
  summarizeCosts,
  ATLAS_CONSOLE_URL,
  type AtlasBalance,
  type AtlasCodePlan,
  type AtlasCostItem,
  type AtlasModel,
} from "@/apps/agent/services/providers/atlascloud";
import { AgentIcon } from "../shared/AgentIcon";
import { AgwPill, AgwSegmented, AgwSwitch } from "./primitives";

// ── Data hook ────────────────────────────────────────────────────────────────

type Phase = "idle" | "loading" | "ready" | "payg" | "error";

interface AtlasData {
  phase: Phase;
  plan: AtlasCodePlan | null;
  balance: AtlasBalance | null;
  items: AtlasCostItem[];
  models: AtlasModel[];
  error: string | null;
  updatedAt: number | null;
  keyName: string | null;
}

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function useAtlasUsage(provider: LLMProvider): AtlasData & { refresh: () => void } {
  const key = provider.apiKey.trim();
  const origin = useMemo(() => deriveAtlasOrigin(provider.baseUrl), [provider.baseUrl]);
  const [data, setData] = useState<AtlasData>({
    phase: key ? "loading" : "idle",
    plan: null,
    balance: null,
    items: [],
    models: [],
    error: null,
    updatedAt: null,
    keyName: null,
  });
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!key) {
      setData((d) => ({ ...d, phase: "idle", error: null }));
      return;
    }
    const ctrl = new AbortController();
    let alive = true;
    setData((d) => ({ ...d, phase: "loading", error: null }));

    void (async () => {
      try {
        const plan = await fetchCodePlan(origin, key, ctrl.signal);
        if (!alive) return;

        if (!plan) {
          const balance = await fetchBalance(origin, key, ctrl.signal);
          if (!alive) return;
          setData({
            phase: "payg",
            plan: null,
            balance,
            items: [],
            models: [],
            error: null,
            updatedAt: Date.now(),
            keyName: null,
          });
          return;
        }

        const now = Date.now();
        const [items, models] = await Promise.all([
          fetchAllCosts(origin, key, { startTime: now - WINDOW_MS, endTime: now }, ctrl.signal).catch(
            () => [] as AtlasCostItem[],
          ),
          fetchAtlasTextModels(origin, key, ctrl.signal).catch(() => [] as AtlasModel[]),
        ]);
        if (!alive) return;
        setData({
          phase: "ready",
          plan,
          balance: null,
          items,
          models,
          error: null,
          updatedAt: Date.now(),
          keyName: items.find((i) => i.apiKeyName)?.apiKeyName ?? null,
        });
      } catch (err) {
        if (!alive) return;
        setData((d) => ({
          ...d,
          phase: "error",
          error: (err as Error)?.message || "Failed to load Atlas Cloud usage.",
        }));
      }
    })();

    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [key, origin, nonce]);

  return { ...data, refresh };
}

// ── Small presentational bits ────────────────────────────────────────────────

const Stat: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode }> = ({
  label,
  value,
  sub,
}) => (
  <div className="agw-atlas-stat">
    <div className="agw-atlas-stat-label">{label}</div>
    <div className="agw-atlas-stat-value">{value}</div>
    {sub != null && <div className="agw-atlas-stat-sub">{sub}</div>}
  </div>
);

const Meter: React.FC<{ ratio: number; tone?: "accent" | "warn" | "danger" }> = ({
  ratio,
  tone = "accent",
}) => (
  <div className="agw-atlas-meter">
    <span
      className="agw-atlas-meter-fill"
      data-tone={tone}
      style={{ width: `${Math.min(100, Math.max(0, ratio * 100)).toFixed(1)}%` }}
    />
  </div>
);

function fmtDate(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── Card ─────────────────────────────────────────────────────────────────────

export const AtlasCloudUsageCard: React.FC<{
  provider: LLMProvider;
  enabled: boolean;
  onToggleEnabled: (next: boolean) => void;
}> = ({ provider, enabled, onToggleEnabled }) => {
  const { phase, plan, balance, items, models, error, updatedAt, keyName, refresh } =
    useAtlasUsage(provider);

  return (
    <section className="agw-atlas" aria-label="Atlas Cloud usage">
      <div className="agw-atlas-head">
        <span className="agw-atlas-mark">
          <AgentIcon name="database" size={15} />
        </span>
        <div className="agw-atlas-head-titles">
          <div className="agw-atlas-title">
            Atlas Cloud
            {phase === "ready" && plan && (
              <AgwPill tone={plan.status === "active" ? "success" : "warning"}>
                {plan.planName}
              </AgwPill>
            )}
            {phase === "payg" && <AgwPill tone="info">Pay as you go</AgwPill>}
          </div>
          <div className="agw-atlas-sub">
            {phase === "ready" && (keyName ? `Key “${keyName}” · usage in tokens` : "Coding-plan usage, in tokens")}
            {phase === "payg" && "Account balance"}
            {phase === "loading" && "Loading usage…"}
            {phase === "idle" && "Add your API key to see plan usage"}
            {phase === "error" && "Couldn’t load usage"}
          </div>
        </div>
        <div className="agw-atlas-head-actions">
          {(phase === "ready" || phase === "payg" || phase === "error") && (
            <button
              type="button"
              className="agw-prov-icon-btn"
              title="Refresh"
              aria-label="Refresh usage"
              onClick={refresh}
            >
              <AgentIcon name="retry" size={14} />
            </button>
          )}
          <a
            className="agw-prov-icon-btn"
            href={ATLAS_CONSOLE_URL}
            target="_blank"
            rel="noreferrer"
            title="Open Atlas Cloud console"
            aria-label="Open Atlas Cloud console"
          >
            <AgentIcon name="external" size={14} />
          </a>
          <span className="agw-atlas-head-sep" aria-hidden="true" />
          <AgwSwitch checked={enabled} onChange={onToggleEnabled} ariaLabel="Enable Atlas Cloud" />
        </div>
      </div>

      {phase === "idle" && (
        <div className="agw-atlas-hint">
          Paste your Atlas Cloud API key below to unlock a live view of your coding-plan
          quota, remaining tokens per model, and recent activity.
        </div>
      )}

      {phase === "loading" && (
        <div className="agw-atlas-body">
          <div className="agw-atlas-skeleton" />
          <div className="agw-atlas-skeleton" style={{ width: "72%" }} />
          <div className="agw-atlas-skeleton" style={{ width: "54%" }} />
        </div>
      )}

      {phase === "error" && (
        <div className="agw-atlas-error">
          <span>{error}</span>
          <button type="button" className="agw-atlas-retry" onClick={refresh}>
            <AgentIcon name="retry" size={13} /> Retry
          </button>
        </div>
      )}

      {phase === "payg" && balance && <PaygView balance={balance} />}

      {phase === "ready" && plan && (
        <PlanCarousel plan={plan} items={items} models={models} updatedAt={updatedAt} />
      )}
    </section>
  );
};

// ── Pay-as-you-go (no coding plan) ───────────────────────────────────────────

const PaygView: React.FC<{ balance: AtlasBalance }> = ({ balance }) => (
  <div className="agw-atlas-body">
    <div className="agw-atlas-stat-grid">
      <Stat
        label="Available"
        value={`$${balance.availableUsd.toFixed(2)}`}
        sub={balance.accountType || "account"}
      />
      {balance.subscriptionBonusUsd > 0 && (
        <Stat label="Subscription bonus" value={`$${balance.subscriptionBonusUsd.toFixed(2)}`} />
      )}
    </div>
    <div className="agw-atlas-note">
      No active coding plan on this key — showing wallet balance. Buy a coding plan in the
      console to meter usage in tokens.
    </div>
  </div>
);

// ── Coding-plan carousel ─────────────────────────────────────────────────────

type Period = "24h" | "7d" | "30d";
const PERIOD_MS: Record<Period, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const PlanCarousel: React.FC<{
  plan: AtlasCodePlan;
  items: AtlasCostItem[];
  models: AtlasModel[];
  updatedAt: number | null;
}> = ({ plan, items, models, updatedAt }) => {
  const slides = ["Plan", "Tokens", "Usage", "Recent", "By model"] as const;
  const [idx, setIdx] = useState(0);
  const go = (n: number) => setIdx(((n % slides.length) + slides.length) % slides.length);

  return (
    <div className="agw-atlas-body">
      <div
        className="agw-atlas-carousel"
        role="group"
        aria-roledescription="carousel"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            go(idx + 1);
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            go(idx - 1);
          }
        }}
      >
        <button
          type="button"
          className="agw-atlas-nav agw-atlas-nav-prev"
          aria-label="Previous"
          onClick={() => go(idx - 1)}
        >
          <AgentIcon name="arrow-left" size={15} />
        </button>
        <div className="agw-atlas-viewport">
          <div className="agw-atlas-track" style={{ transform: `translateX(-${idx * 100}%)` }}>
            <Slide active={idx === 0}>
              <PlanSlide plan={plan} items={items} models={models} />
            </Slide>
            <Slide active={idx === 1}>
              <TokensSlide plan={plan} items={items} models={models} />
            </Slide>
            <Slide active={idx === 2}>
              <UsageSlide items={items} />
            </Slide>
            <Slide active={idx === 3}>
              <RecentSlide items={items} />
            </Slide>
            <Slide active={idx === 4}>
              <ByModelSlide items={items} />
            </Slide>
          </div>
        </div>
        <button
          type="button"
          className="agw-atlas-nav agw-atlas-nav-next"
          aria-label="Next"
          onClick={() => go(idx + 1)}
        >
          <AgentIcon name="arrow-left" size={15} />
        </button>
      </div>

      <div className="agw-atlas-foot">
        <div className="agw-atlas-dots" role="tablist" aria-label="Usage views">
          {slides.map((label, i) => (
            <button
              key={label}
              type="button"
              role="tab"
              aria-selected={i === idx}
              aria-label={label}
              className="agw-atlas-dot"
              data-on={i === idx || undefined}
              onClick={() => setIdx(i)}
            />
          ))}
        </div>
        <span className="agw-atlas-slide-name">{slides[idx]}</span>
        {updatedAt && <span className="agw-atlas-updated">Updated {fmtRelative(updatedAt)} ago</span>}
      </div>
    </div>
  );
};

const Slide: React.FC<{ active: boolean; children: React.ReactNode }> = ({ active, children }) => (
  <div className="agw-atlas-slide" aria-hidden={!active}>
    {children}
  </div>
);

// Slide 1 — Plan quota, remaining balance → tokens.
const PlanSlide: React.FC<{ plan: AtlasCodePlan; items: AtlasCostItem[]; models: AtlasModel[] }> = ({
  plan,
  items,
  models,
}) => {
  const rate = useMemo(() => rateFor(items, models, topModel(items)), [items, models]);
  // Atlas' `balance` is the CURRENT-CYCLE allowance (== weekly cap here), not the
  // live remainder. The authoritative "left right now" is balance − used_quota,
  // which matches the `remain` in the cost history exactly.
  const remaining = Math.max(0, plan.balance - plan.usedQuota);
  const usedRatio = plan.balance > 0 ? plan.usedQuota / plan.balance : 0;
  const remainingTokens = creditsToTokens(remaining, rate.value);

  return (
    <div className="agw-atlas-pane">
      <div className="agw-atlas-hero">
        <div className="agw-atlas-hero-main">
          <div className="agw-atlas-hero-num">{fmtCompact(remaining)}</div>
          <div className="agw-atlas-hero-unit">credits left · renews {fmtDate(plan.expiredAt)}</div>
        </div>
        {remainingTokens != null && (
          <div className="agw-atlas-hero-token">
            ≈ {fmtCompact(remainingTokens)} tokens
            <span className="agw-atlas-hero-token-hint">{rate.label}</span>
          </div>
        )}
      </div>
      <Meter ratio={usedRatio} tone={usedRatio > 0.9 ? "danger" : usedRatio > 0.7 ? "warn" : "accent"} />
      <div className="agw-atlas-meter-legend">
        <span>{fmtCompact(plan.usedQuota)} used</span>
        <span>{fmtCompact(plan.balance)} available</span>
      </div>
      <div className="agw-atlas-stat-grid">
        <Stat
          label="Daily limit"
          value={fmtCompact(plan.dailyQuota)}
          sub={tokenSub(plan.dailyQuota, rate.value)}
        />
        <Stat
          label="Weekly cap"
          value={fmtCompact(plan.weeklyCap)}
          sub={tokenSub(plan.weeklyCap, rate.value)}
        />
        <Stat
          label="Monthly total"
          value={fmtCompact(plan.totalQuota)}
          sub={tokenSub(plan.totalQuota, rate.value)}
        />
      </div>
    </div>
  );
};

// Slide 2 — Tokens left, per selected model.
const TokensSlide: React.FC<{ plan: AtlasCodePlan; items: AtlasCostItem[]; models: AtlasModel[] }> = ({
  plan,
  items,
  models,
}) => {
  const chips = useMemo(() => modelChoices(items, models), [items, models]);
  const [sel, setSel] = useState<string>(() => chips[0]?.id ?? "");
  const active = chips.find((c) => c.id === sel) ?? chips[0];

  const rate = useMemo(
    () => (active ? rateFor(items, models, active.id) : { value: null, label: "" }),
    [active, items, models],
  );
  const model = active ? models.find((m) => m.id === active.id) : undefined;
  const mult = model ? multipliersFromPrice(model) : null;

  const remaining = Math.max(0, plan.balance - plan.usedQuota);
  const balanceTokens = creditsToTokens(remaining, rate.value);
  const outOnly = mult && mult.output > 0 ? Math.round(remaining / mult.output) : null;
  const inOnly = mult && mult.input > 0 ? Math.round(remaining / mult.input) : null;

  return (
    <div className="agw-atlas-pane">
      <div className="agw-atlas-chips" role="tablist" aria-label="Model">
        {chips.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={c.id === active?.id}
            className="agw-atlas-chip"
            data-on={c.id === active?.id || undefined}
            title={c.id}
            onClick={() => setSel(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="agw-atlas-hero">
        <div className="agw-atlas-hero-main">
          <div className="agw-atlas-hero-num">
            {balanceTokens != null ? fmtCompact(balanceTokens) : "—"}
          </div>
          <div className="agw-atlas-hero-unit">tokens left {rate.label && `· ${rate.label}`}</div>
        </div>
      </div>

      <div className="agw-atlas-stat-grid">
        <Stat label="Daily" value={tokenValue(plan.dailyQuota, rate.value)} sub="tokens/day" />
        <Stat label="Weekly" value={tokenValue(plan.weeklyCap, rate.value)} sub="tokens/week" />
        <Stat
          label="If all output"
          value={outOnly != null ? fmtCompact(outOnly) : "—"}
          sub={inOnly != null ? `${fmtCompact(inOnly)} if all input` : undefined}
        />
      </div>
      {mult && (
        <div className="agw-atlas-note">
          {shortModel(active!.id)} · {mult.input.toFixed(2)} cr/in · {mult.output.toFixed(2)} cr/out ·{" "}
          {mult.cache.toFixed(2)} cr/cache
        </div>
      )}
    </div>
  );
};

// Slide 3 — Usage for a period.
const UsageSlide: React.FC<{ items: AtlasCostItem[] }> = ({ items }) => {
  const [period, setPeriod] = useState<Period>("7d");
  const scoped = useMemo(() => withinPeriod(items, period), [items, period]);
  const sum = useMemo(() => summarizeCosts(scoped), [scoped]);
  const totalTokens = sum.input + sum.output + sum.cache;

  return (
    <div className="agw-atlas-pane">
      <div className="agw-atlas-period">
        <AgwSegmented<Period>
          ariaLabel="Usage period"
          value={period}
          onChange={setPeriod}
          options={[
            { value: "24h", label: "24h" },
            { value: "7d", label: "7d" },
            { value: "30d", label: "30d" },
          ]}
        />
      </div>
      {sum.requests === 0 ? (
        <div className="agw-atlas-empty">No requests in this window.</div>
      ) : (
        <>
          <div className="agw-atlas-stat-grid">
            <Stat label="Requests" value={fmtInt(sum.requests)} />
            <Stat label="Tokens" value={fmtCompact(totalTokens)} sub="in + out + cache" />
            <Stat label="Credits" value={fmtCompact(sum.credits)} />
          </div>
          <div className="agw-atlas-stat-grid">
            <Stat label="Input" value={fmtCompact(sum.input)} />
            <Stat label="Output" value={fmtCompact(sum.output)} />
            <Stat label="Cache" value={fmtCompact(sum.cache)} />
          </div>
        </>
      )}
    </div>
  );
};

// Slide 4 — Recent requests.
const RecentSlide: React.FC<{ items: AtlasCostItem[] }> = ({ items }) => {
  const recent = useMemo(
    () => [...items].sort((a, b) => b.finishTime - a.finishTime).slice(0, 6),
    [items],
  );
  return (
    <div className="agw-atlas-pane">
      {recent.length === 0 ? (
        <div className="agw-atlas-empty">No recent activity.</div>
      ) : (
        <ul className="agw-atlas-list">
          {recent.map((it) => (
            <li key={it.chatId || it.finishTime} className="agw-atlas-row">
              <span className="agw-atlas-row-model" title={it.model}>
                {shortModel(it.model)}
              </span>
              <span className="agw-atlas-row-toks">
                {fmtCompact(it.input + it.cache)}→{fmtCompact(it.output)}
              </span>
              <span className="agw-atlas-row-credits">{fmtCompact(it.credits)} cr</span>
              <span className="agw-atlas-row-time">{fmtRelative(it.finishTime)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

// Slide 5 — Per-model breakdown (30d).
const ByModelSlide: React.FC<{ items: AtlasCostItem[] }> = ({ items }) => {
  const sum = useMemo(() => summarizeCosts(items), [items]);
  const max = sum.byModel[0]?.credits ?? 0;
  return (
    <div className="agw-atlas-pane">
      {sum.byModel.length === 0 ? (
        <div className="agw-atlas-empty">No usage yet.</div>
      ) : (
        <ul className="agw-atlas-bars">
          {sum.byModel.slice(0, 5).map((m) => (
            <li key={m.model} className="agw-atlas-bar-row">
              <div className="agw-atlas-bar-head">
                <span className="agw-atlas-bar-name" title={m.model}>
                  {shortModel(m.model)}
                </span>
                <span className="agw-atlas-bar-meta">
                  {fmtCompact(m.input + m.output + m.cache)} tok · {fmtInt(m.requests)} req
                </span>
              </div>
              <Meter ratio={max > 0 ? m.credits / max : 0} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

// ── Rate / model helpers ─────────────────────────────────────────────────────

interface RateInfo {
  value: number | null;
  label: string;
}

/**
 * Best credits/token rate for a model: its own history → account-wide history →
 * a price-based blend (labeled as an estimate).
 */
function rateFor(items: AtlasCostItem[], models: AtlasModel[], model: string | null): RateInfo {
  if (model) {
    const own = effectiveRate(items, model);
    if (own != null) return { value: own, label: "at your usage on this model" };
  }
  const acct = effectiveRate(items);
  if (acct != null) return { value: acct, label: "at your recent usage mix" };
  const m = model ? models.find((x) => x.id === model) : undefined;
  if (m) {
    const mult = multipliersFromPrice(m);
    const blend = (mult.input + mult.output) / 2;
    if (blend > 0) return { value: blend, label: "est. from pricing" };
  }
  return { value: null, label: "" };
}

function topModel(items: AtlasCostItem[]): string | null {
  const sum = summarizeCosts(items);
  return sum.byModel[0]?.model ?? null;
}

interface Choice {
  id: string;
  label: string;
}

const POPULAR_FALLBACK = [
  "zai-org/glm-5.2",
  "moonshotai/kimi-k2.7-code",
  "anthropic/claude-sonnet-4.6",
  "deepseek-ai/DeepSeek-V3.1-Terminus",
  "Qwen/Qwen3-Coder",
];

/** Model chips: history models first (exact rates), then popular catalog models. */
function modelChoices(items: AtlasCostItem[], models: AtlasModel[]): Choice[] {
  const label = (id: string) => models.find((m) => m.id === id)?.displayName ?? shortModel(id);
  const seen = new Set<string>();
  const out: Choice[] = [];
  for (const m of summarizeCosts(items).byModel) {
    if (seen.has(m.model)) continue;
    seen.add(m.model);
    out.push({ id: m.model, label: label(m.model) });
  }
  for (const id of POPULAR_FALLBACK) {
    if (out.length >= 8) break;
    if (seen.has(id)) continue;
    if (models.length > 0 && !models.some((m) => m.id === id)) continue;
    seen.add(id);
    out.push({ id, label: label(id) });
  }
  return out;
}

function withinPeriod(items: AtlasCostItem[], period: Period): AtlasCostItem[] {
  const cutoff = Date.now() - PERIOD_MS[period];
  return items.filter((i) => i.finishTime >= cutoff);
}

function tokenValue(credits: number, rate: number | null): string {
  const t = creditsToTokens(credits, rate);
  return t != null ? fmtCompact(t) : "—";
}

function tokenSub(credits: number, rate: number | null): string | undefined {
  const t = creditsToTokens(credits, rate);
  return t != null ? `≈ ${fmtCompact(t)} tokens` : undefined;
}

export default AtlasCloudUsageCard;
