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

import {
  CURSOR_PROVIDER_ID,
  cursorAuthConnect,
  cursorAuthSignOut,
  cursorAuthStatus,
  cursorModelsList,
  cursorModelsRefresh,
  cursorModelsSetEnabledBulk,
  cursorStateDbPath,
  enrichCatalogueRows,
  toCatalogueRows,
  type CursorAuthStatus,
  type CursorCatalogueRow,
} from "@/apps/agent/services/providers/cursor";
import {
  clearCursorModelsFromStore,
  syncCursorModelsIntoStore,
} from "@/apps/agent/services/providers/cursor-sync";
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

  const probe = useCallback(async () => {
    try {
      const next = await cursorAuthStatus();
      setStatus(next);
      setPhase(next.signedIn ? "ready" : "signed-out");
      if (!next.signedIn && !next.cursorAppDetected) {
        setDbPath(await cursorStateDbPath());
      }
      if (next.signedIn) void loadModels(false);
    } catch (err) {
      setError(String(err));
      setPhase("error");
    }
  }, [loadModels]);

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
              title="Reload your plan's models"
              aria-label="Reload your plan's models"
              disabled={busy}
              onClick={() => void loadModels(true)}
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
}> = ({ row, onToggle }) => {
  const { model, catalog } = row;
  const window = fmtWindow(catalog?.contextWindow);
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
        <span className="agw-modelcat-id">{model.representativeId}</span>
      </span>

      <span className="agw-modelcat-tags">
        {model.hasThinking && <span className="agw-modelcat-tag">Thinking</span>}
        {catalog?.supportsVision && <span className="agw-modelcat-tag">Vision</span>}
        {model.hasFast && <span className="agw-modelcat-tag">Fast</span>}
        {window && (
          <span className="agw-modelcat-tag agw-modelcat-tag-quiet">{window}</span>
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
