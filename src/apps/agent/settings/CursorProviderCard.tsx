/**
 * Agent Window — Cursor (subscription) provider card.
 *
 * Rendered in the Providers detail pane for the Cursor provider. There is no
 * API key and no browser hop: the Rust side reads the Cursor desktop app's own
 * session, so connecting is one button.
 *
 * ## Why the model list looks like this
 *
 * A Cursor account reaches ~200 model ids, but that is roughly 32 real models
 * repeated at different effort levels — `claude-fable-5` alone ships ten. So
 * the list shows **one row per model**, with effort, thinking and Fast as
 * facts about the row rather than rows of their own. Older generations fold
 * away behind a count.
 *
 * Capability badges (vision, context window) come from models.dev, because
 * Cursor's wire carries none of it. A model with no catalogue entry simply
 * shows fewer badges — the row still works.
 *
 * ## The switch is not decorative
 *
 * Switching a model on writes it into Aurora's shared model list, which is
 * what the model picker, the context ring and the cost readout all read. That
 * mirror is the whole point of the control: without it the toggle would write
 * a row nothing else in the app ever looks at.
 *
 * Shares `.agw-atlas-*` with the Codex card so the two subscription providers
 * read as one system; the catalogue below is `.agw-cursor-*`.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";

import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import {
  CURSOR_PROVIDER_ID,
  cursorAuthConnect,
  cursorAuthSignOut,
  cursorAuthStatus,
  cursorMeterValue,
  cursorModelsList,
  cursorModelsRefresh,
  cursorModelsSetEnabledBulk,
  cursorResetLabel,
  cursorStateDbPath,
  cursorUsageGet,
  cursorUsd,
  enrichCatalogueRows,
  toCatalogueRows,
  type CursorAuthStatus,
  type CursorCatalogueRow,
  type CursorUsageSnapshot,
  type CursorUsageWindow,
} from "@/apps/agent/services/providers/cursor";
import {
  clearCursorModelsFromStore,
  syncCursorModelsIntoStore,
} from "@/apps/agent/services/providers/cursor-sync";
import { cursorReasons } from "@/apps/agent/services/providers/cursor-variants";
import { fmtRelative } from "@/apps/agent/services/providers/atlascloud";
import { AgentIcon } from "../shared/AgentIcon";
import { ProviderAvatar } from "./ProviderAvatar";
import { AgwButton, AgwSwitch, AgwTextInput } from "./primitives";

type Phase = "loading" | "signed-out" | "ready" | "error";

/** `pro_plus` → `Pro Plus`. */
function planLabel(membership: string | null): string | null {
  if (!membership) return null;
  return membership
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

/** 200000 → `200K`. */
function fmtWindow(tokens: number | undefined): string | null {
  if (!tokens) return null;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return `${Math.round(tokens / 1000)}K`;
}

/**
 * One metered bucket, drawn the way the Cursor app draws it.
 *
 * Quota and spend are the same row with different right-hand sides, because
 * they are the same question asked of an allowance and of a bill. The bar
 * clamps; the number never does — going past an on-demand ceiling is the one
 * thing on this card that costs real money, and rounding it back to the cap
 * would hide exactly that.
 */
const UsageMeter: React.FC<{ win: CursorUsageWindow }> = ({ win }) => {
  const over = win.usedUsd != null && win.limitUsd != null && win.usedUsd > win.limitUsd;
  const tone = over || win.usedPercent >= 100 ? "danger" : win.usedPercent >= 75 ? "warn" : "accent";
  return (
    <div className="agw-cursor-usage-row">
      <div className="agw-cursor-usage-head">
        <span className="agw-cursor-usage-label">{win.label}</span>
        <span className="agw-cursor-usage-value" data-tone={tone}>
          {cursorMeterValue(win)}
        </span>
      </div>
      <div className="agw-atlas-meter">
        <span
          className="agw-atlas-meter-fill"
          data-tone={tone}
          style={{ width: `${Math.min(100, Math.max(0, win.usedPercent)).toFixed(1)}%` }}
        />
      </div>
    </div>
  );
};

export const CursorProviderCard: React.FC<{
  enabled: boolean;
  onToggleEnabled: (next: boolean) => void;
}> = ({ enabled, onToggleEnabled }) => {
  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState<CursorAuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dbPath, setDbPath] = useState<string | null>(null);

  const [rows, setRows] = useState<CursorCatalogueRow[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  // Usage is loaded and reported independently of the catalogue: an account
  // that cannot report its plan still has a perfectly good model list, and
  // failing one must not blank the other.
  const [usage, setUsage] = useState<CursorUsageSnapshot | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [showLegacy, setShowLegacy] = useState(false);

  const loadModels = useCallback(async (refresh = false) => {
    setBusy(true);
    setError(null);
    try {
      const catalogue = refresh ? await cursorModelsRefresh() : await cursorModelsList();
      setFetchedAt(catalogue.fetchedAt);
      // Render immediately, then fill in models.dev metadata — a slow or
      // unreachable catalogue must never hold the list hostage.
      const next = toCatalogueRows(catalogue.models);
      setRows(next);
      // Keep the picker in step with what the account now offers: a model that
      // vanished from the plan must stop being selectable, and one that
      // reappeared must come back.
      await syncCursorModelsIntoStore();
      setRows(await enrichCatalogueRows(next));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const loadUsage = useCallback(async () => {
    setUsageLoading(true);
    setUsageError(null);
    try {
      setUsage(await cursorUsageGet());
    } catch (err) {
      setUsage(null);
      setUsageError(String(err));
    } finally {
      setUsageLoading(false);
    }
  }, []);

  const probe = useCallback(async () => {
    try {
      const next = await cursorAuthStatus();
      setStatus(next);
      setPhase(next.signedIn ? "ready" : "signed-out");
      if (!next.signedIn && !next.cursorAppDetected) {
        setDbPath(await cursorStateDbPath());
      }
      if (next.signedIn) {
        void loadModels(false);
        void loadUsage();
      }
    } catch (err) {
      setError(String(err));
      setPhase("error");
    }
  }, [loadModels, loadUsage]);

  useEffect(() => {
    void probe();
  }, [probe]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await cursorAuthConnect();
      setStatus(next);
      setPhase("ready");
      await loadModels(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await cursorAuthSignOut();
      setRows([]);
      setFetchedAt(null);
      // The picker must not keep offering models the app can no longer reach.
      clearCursorModelsFromStore();
      await probe();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleRow = async (row: CursorCatalogueRow, next: boolean) => {
    // Optimistic: the switch must feel immediate on a 32-row list.
    setRows((prev) =>
      prev.map((r) =>
        r.model.stem === row.model.stem
          ? { ...r, model: { ...r.model, enabled: next } }
          : r,
      ),
    );
    try {
      await cursorModelsSetEnabledBulk(row.model.variantIds, next);
      await syncCursorModelsIntoStore();
    } catch (err) {
      setError(String(err));
      setRows((prev) =>
        prev.map((r) =>
          r.model.stem === row.model.stem
            ? { ...r, model: { ...r.model, enabled: !next } }
            : r,
        ),
      );
    }
  };

  const legacyCount = useMemo(
    () => rows.filter((r) => r.model.isLegacy).length,
    [rows],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(({ model }) => {
      if (model.isLegacy && !showLegacy) return false;
      if (!q) return true;
      return (
        model.label.toLowerCase().includes(q) ||
        model.representativeId.toLowerCase().includes(q)
      );
    });
  }, [rows, query, showLegacy]);

  const enabledCount = useMemo(
    () => rows.filter((r) => r.model.enabled).length,
    [rows],
  );

  // ── Editable context window ────────────────────────────────────────────────
  //
  // Cursor's wire carries no context window at all, so models.dev is the only
  // source — and it is a seed, not an authority. This makes the number the
  // user's to correct, the same as on every other provider.
  //
  // A model is one row here, keyed by its own id (`cursor-grok-4.6`); the
  // effort and Fast that decorate it on the wire are choices, not separate
  // models, so there is exactly one window to edit.
  const allModels = useAgentSettingsStore((s) => s.models);
  const updateModel = useAgentSettingsStore((s) => s.updateModel);
  const cursorModels = useMemo(
    () => allModels.filter((m) => m.providerId === CURSOR_PROVIDER_ID),
    [allModels],
  );

  const rowFor = useCallback(
    (row: CursorCatalogueRow) =>
      cursorModels.find((m) => m.modelKey === row.model.stem),
    [cursorModels],
  );

  const storedWindowFor = useCallback(
    (row: CursorCatalogueRow) => rowFor(row)?.contextWindow,
    [rowFor],
  );

  const setWindowFor = useCallback(
    (row: CursorCatalogueRow, next: number | undefined) => {
      const stored = rowFor(row);
      if (stored) updateModel(stored.id, { contextWindow: next });
    },
    [rowFor, updateModel],
  );

  const plan = planLabel(status?.membership ?? null);

  return (
    <section className="agw-atlas" aria-label="Cursor subscription">
      <div className="agw-atlas-head">
        {/* Cursor's real mark, from the same brand set the provider rail uses —
            not one of Aurora's own glyphs. A company's logo has to be
            reproduced, not redrawn to our grid. */}
        <ProviderAvatar provider={{ id: CURSOR_PROVIDER_ID, name: "Cursor" }} />
        <div className="agw-atlas-head-titles">
          <div className="agw-atlas-title">
            Cursor
            {/* The plan is a fact about the account, not a status that changes
                or that anyone acts on — so it is set in the success colour and
                nothing more. A bordered chip around it gave a static label the
                weight of a live badge. */}
            {phase === "ready" && plan && (
              <span className="agw-sub-plan">{plan}</span>
            )}
          </div>
          <div className="agw-atlas-sub">
            {phase === "ready" &&
              (status?.email ? `Signed in as ${status.email}` : "Signed in")}
            {phase === "signed-out" && "Uses your Cursor app's session — no API key"}
            {phase === "loading" && "Checking your Cursor app…"}
            {phase === "error" && "Couldn't read your Cursor session"}
          </div>
        </div>
        <div className="agw-atlas-head-actions">
          {phase === "ready" && (
            <button
              type="button"
              className="agw-prov-icon-btn"
              title="Reload plan usage and models"
              aria-label="Reload plan usage and models"
              disabled={busy || usageLoading}
              onClick={() => {
                void loadModels(true);
                void loadUsage();
              }}
            >
              <AgentIcon name="retry" size={14} />
            </button>
          )}
          <span className="agw-atlas-head-sep" aria-hidden="true" />
          <AgwSwitch checked={enabled} onChange={onToggleEnabled} ariaLabel="Enable Cursor" />
        </div>
      </div>

      {phase === "loading" && (
        <div className="agw-atlas-body">
          <div className="agw-atlas-skeleton" />
          <div className="agw-atlas-skeleton" style={{ width: "72%" }} />
        </div>
      )}

      {error && (
        <div className="agw-atlas-body agw-cursor-error" role="status">
          {error}
        </div>
      )}

      {(phase === "signed-out" || phase === "error") && (
        <div className="agw-atlas-body agw-cursor-connect">
          {status?.cursorAppDetected ? (
            <>
              <p>
                Cursor is installed on this machine. Connecting reads the
                session it already has — your Cursor app stays signed in and
                nothing is sent anywhere.
              </p>
              <AgwButton
                variant="primary"
                icon="plug"
                onClick={() => void connect()}
                disabled={busy}
              >
                {busy ? "Connecting…" : "Connect Cursor"}
              </AgwButton>
            </>
          ) : (
            <>
              <p>
                No Cursor session found. Sign in to the Cursor app, then
                connect.
              </p>
              {dbPath && (
                <p className="agw-cursor-hint">
                  Looked in <code>{dbPath}</code>. If Cursor is installed
                  somewhere else, point <code>CURSOR_STATE_DB</code> at its{" "}
                  <code>state.vscdb</code>.
                </p>
              )}
              <AgwButton icon="retry" onClick={() => void probe()} disabled={busy}>
                Check again
              </AgwButton>
            </>
          )}
        </div>
      )}

      {phase === "ready" && (
        <div className="agw-atlas-body agw-cursor-body">
          {/* Session facts. Reference, not actions — so a quiet row, not a card. */}
          <div className="agw-cursor-meta">
            {status?.expiresAt && (
              <span>
                Session valid until{" "}
                {new Date(status.expiresAt).toLocaleDateString()}
              </span>
            )}
            {status?.hasRefreshToken && <span>Renews automatically</span>}
            <button
              type="button"
              className="agw-cursor-signout"
              disabled={busy}
              onClick={() => void signOut()}
            >
              Disconnect from Aurora
            </button>
          </div>

          {/* Plan usage. Above the catalogue on purpose: how much is left
              decides whether picking a model is worth doing at all. */}
          <div className="agw-cursor-usage">
            <div className="agw-cursor-usage-title">
              <h3>Plan &amp; usage</h3>
              {/* Cursor's own words about its own account. Preferred over
                  anything Aurora would compose from the percentages — and it
                  is the same sentence shown in the Cursor app, so the two
                  never appear to disagree. */}
              {usage?.notice && (
                <span className="agw-cursor-usage-notice">{usage.notice}</span>
              )}
            </div>

            {usageLoading && !usage && (
              <>
                <div className="agw-atlas-skeleton" />
                <div className="agw-atlas-skeleton" style={{ width: "64%" }} />
              </>
            )}

            {usageError && !usageLoading && (
              <p className="agw-cursor-usage-empty" role="status">
                {usageError}
              </p>
            )}

            {usage && usage.windows.length === 0 && !usageLoading && (
              <p className="agw-cursor-usage-empty">
                Connected. This account has no metered plan usage to report.
              </p>
            )}

            {usage?.windows.map((win) => (
              <UsageMeter key={win.label} win={win} />
            ))}

            {usage && usage.windows.length > 0 && (
              <p className="agw-cursor-usage-foot">
                {cursorResetLabel(usage.resetsAtMs) ?? "No reset date reported"}
                {usage.totalPercentUsed != null && (
                  <> · {Math.round(usage.totalPercentUsed)}% of the included total used</>
                )}
                {/* Free usage Cursor granted on top of the plan. Their own
                    screen keeps this in a tooltip; it is money not spent. */}
                {usage.bonusUsd != null && (
                  <> · {cursorUsd(usage.bonusUsd)} of that covered by Cursor</>
                )}
              </p>
            )}
          </div>

          {/* Catalogue */}
          <div className="agw-modelcat">
            <div className="agw-modelcat-head">
              <h3 className="agw-modelcat-title">Models</h3>
              <p className="agw-modelcat-desc">
                Everything your plan can reach. Switch on the ones you want in
                the model picker.
              </p>
            </div>

            <div className="agw-modelcat-toolbar">
              <div className="agw-modelcat-search">
                <AgentIcon
                  name="search"
                  size={13}
                  style={{ color: "var(--agw-text-subtle)", flexShrink: 0 }}
                />
                <AgwTextInput
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search models"
                  aria-label="Search Cursor models"
                  className="agw-modelcat-search-input"
                />
              </div>
              {legacyCount > 0 && (
                <button
                  type="button"
                  className="agw-modelcat-fold"
                  aria-pressed={showLegacy}
                  onClick={() => setShowLegacy((v) => !v)}
                >
                  {showLegacy ? "Hide" : "Show"} {legacyCount} older
                </button>
              )}
            </div>

            {visible.length === 0 ? (
              <div className="agw-modelcat-empty">
                <AgentIcon name="search" size={20} />
                {query.trim() ? (
                  <>
                    <p>No models match “{query.trim()}”.</p>
                    <AgwButton onClick={() => setQuery("")}>Clear search</AgwButton>
                  </>
                ) : (
                  <>
                    <p>Your plan's models haven't loaded yet.</p>
                    <AgwButton
                      icon="retry"
                      onClick={() => void loadModels(true)}
                      disabled={busy}
                    >
                      {busy ? "Loading…" : "Load models"}
                    </AgwButton>
                  </>
                )}
              </div>
            ) : (
              <div className="agw-modelcat-list agw-scroll">
                {visible.map((row) => (
                  <CursorModelRow
                    key={row.model.stem}
                    row={row}
                    onToggle={toggleRow}
                    storedWindow={storedWindowFor(row)}
                    onWindow={(next) => setWindowFor(row, next)}
                  />
                ))}
              </div>
            )}

            <div className="agw-modelcat-foot">
              <span>
                {enabledCount === 0
                  ? "Nothing in your picker yet"
                  : `${enabledCount} of ${rows.length} in your picker`}
              </span>
              {fetchedAt && (
                <span>Updated {fmtRelative(new Date(fetchedAt).getTime())}</span>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

/**
 * One model. The whole row is the switch, so the hit target is the row rather
 * than a checkbox someone has to aim at.
 *
 * The id under the name is the exact id a turn sends — not a tidied-up stem.
 * There is no plain `cursor-grok-4.6` on the wire, so printing one would name
 * a model the account cannot reach.
 */
const CursorModelRow: React.FC<{
  row: CursorCatalogueRow;
  onToggle: (row: CursorCatalogueRow, next: boolean) => void;
  /** What the model's rows currently carry, when it is switched on. */
  storedWindow?: number;
  onWindow: (next: number | undefined) => void;
}> = ({ row, onToggle, storedWindow, onWindow }) => {
  const { model, catalog } = row;
  // What is actually in effect: the number on the row, else the one models.dev
  // seeded it with.
  const effective = storedWindow ?? catalog?.contextWindow;
  const window = fmtWindow(effective);

  // Editing is a mode, entered deliberately. A row of always-open inputs turns
  // a list you read into a form you fill in, and the window is a number people
  // look at far more often than they change.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const open = () => {
    setDraft(storedWindow ? String(storedWindow) : "");
    setEditing(true);
  };
  const commit = () => {
    const trimmed = draft.trim();
    const parsed = Number(trimmed);
    // An empty box means "go back to what models.dev says", which is a real
    // choice and the only way to undo an edit. Anything unparseable is left
    // alone rather than written as a number nobody typed.
    if (!trimmed) onWindow(undefined);
    else if (Number.isFinite(parsed) && parsed > 0) onWindow(Math.round(parsed));
    setEditing(false);
  };

  const label = model.enabled
    ? `Remove ${model.label} from the model picker`
    : `Add ${model.label} to the model picker`;

  return (
    <div className="agw-modelcat-row" data-on={model.enabled || undefined}>
      <button
        type="button"
        className="agw-modelcat-hit"
        aria-pressed={model.enabled}
        aria-label={label}
        title={label}
        onClick={() => onToggle(row, !model.enabled)}
      />
      <span className="agw-modelcat-check" aria-hidden="true">
        {model.enabled && <AgentIcon name="check" size={12} />}
      </span>

      <span className="agw-modelcat-main">
        <span className="agw-modelcat-name">{model.label}</span>
        {/* The model's own id, which is what the row stores. The tier and Fast
            that decorate it on the wire are choices made in the composer, not
            part of the model's name — printing `cursor-grok-4.6-high` here
            named the model after one way of running it. */}
        <span className="agw-modelcat-id">{model.stem}</span>
      </span>

      <span className="agw-modelcat-tags">
        {/* An effort tier is Cursor's reasoning control, so a model carrying
            tiers thinks just as much as one carrying `-thinking` ids. */}
        {cursorReasons(model) && <span className="agw-modelcat-tag">Thinking</span>}
        {catalog?.supportsVision && <span className="agw-modelcat-tag">Vision</span>}
        {model.hasFast && <span className="agw-modelcat-tag">Fast</span>}
        {/* The context window: a number you read, until you ask to change it.
            Cursor's wire carries no window, so models.dev seeds it and the
            user's own value overrides — the same as every other provider.
            Only editable once the model is switched on, because until then
            there is no row to write to.

            Everything interactive here sits above the row's own click target
            and stops propagation, or typing would toggle the model. */}
        {editing ? (
          <span
            className="agw-modelcat-window"
            onClick={(e) => e.stopPropagation()}
            role="presentation"
          >
            <AgwTextInput
              type="number"
              autoFocus
              value={draft}
              // "inherit", not the seeded number: a greyed-out `500000` in an
              // empty box is indistinguishable at a glance from a saved one.
              placeholder="inherit"
              aria-label={`Context window for ${model.label}, in tokens`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setEditing(false);
              }}
              // Clicking away is a commit, not a cancel — the discard is
              // Escape, and losing a typed number to a stray click is the
              // worse of the two mistakes.
              onBlur={commit}
            />
            <button
              type="button"
              className="agw-modelcat-window-save"
              aria-label="Save context window"
              title="Save"
              // `mousedown` beats the input's `blur`, so the click is not
              // swallowed by the field losing focus first.
              onMouseDown={(e) => {
                e.preventDefault();
                commit();
              }}
            >
              <AgentIcon name="check" size={12} />
            </button>
          </span>
        ) : (
          <>
            {window && (
              <span className="agw-modelcat-tag agw-modelcat-tag-quiet">{window}</span>
            )}
            {model.enabled && (
              <button
                type="button"
                className="agw-modelcat-window-edit"
                aria-label={`Edit context window for ${model.label}`}
                title="Edit context window"
                onClick={(e) => {
                  e.stopPropagation();
                  open();
                }}
              >
                <AgentIcon name="pencil" size={11} />
              </button>
            )}
          </>
        )}
        {model.efforts.length > 1 && (
          <span
            className="agw-modelcat-tag agw-modelcat-tag-quiet"
            title={`Effort levels: ${model.efforts.join(", ")}`}
          >
            {model.efforts.length} levels
          </span>
        )}
      </span>
    </div>
  );
};
