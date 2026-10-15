/**
 * Agent Window — Antigravity (Google account) provider card (view).
 *
 * Rendered inside the Providers detail pane for the Antigravity provider. No
 * API key: the card owns sign-in, shows how much quota is left, and keeps the
 * model picker in step with what the account offers.
 *
 * Sign in opens Google's page in the browser; the card waits until it comes
 * back. Import copies the account Antigravity IDE is signed into, reading its
 * settings once and never writing them. Several accounts can be stored;
 * `AntigravityAccountSwitcher` picks the one chats use.
 *
 * Quota is drawn the way Antigravity draws it: one heading per model group,
 * one meter per window (weekly, and 5-hour on paid plans), from
 * `antigravityQuotaGet`. The backend's own notices on models (a model
 * leaving, a plan losing access on a date) are shown as written.
 *
 * Reuses the `.agw-atlas-*` and `.agw-codex-*` classes of the other
 * subscription cards; it adds no styles of its own.
 */

import React, { useCallback, useEffect, useState } from "react";

import {
  antigravityAccountImportIde,
  antigravityAuthCancelLogin,
  antigravityAuthLogin,
  antigravityAuthLogout,
  antigravityAuthStatus,
  antigravityModelsList,
  antigravityNotices,
  antigravityPlanLabel,
  antigravityBucketLabel,
  antigravityBucketMeta,
  antigravityQuotaGet,
  clearAntigravityModels,
  syncAntigravityModels,
  type AntigravityAuthStatus,
  type AntigravityCatalogue,
  type AntigravityQuota,
} from "@/apps/agent/services/providers/antigravity";
import { fmtRelative } from "@/apps/agent/services/providers/atlascloud";
import { AgentIcon } from "../shared/AgentIcon";
import { AntigravityAccountSwitcher } from "./AntigravityAccountSwitcher";
import { ProviderAvatar } from "./ProviderAvatar";
import { AgwButton, AgwSwitch } from "./primitives";

// ── Data hook ────────────────────────────────────────────────────────────────

type Phase =
  | "loading" // initial status probe
  | "signed-out"
  | "signing-in" // waiting for the browser to come back
  | "ready" // signed in; models may still be loading/failed independently
  | "error"; // the status probe itself failed

interface AntigravityState {
  phase: Phase;
  auth: AntigravityAuthStatus | null;
  catalogue: AntigravityCatalogue | null;
  catalogueError: string | null;
  catalogueLoading: boolean;
  quota: AntigravityQuota | null;
  quotaError: string | null;
  /** A problem with signing in or importing — shown under the buttons. */
  signInError: string | null;
  /** The status probe failed; nothing else can be trusted. */
  error: string | null;
}

const errorText = (err: unknown): string => (err as Error)?.message || String(err);

function useAntigravity() {
  const [state, setState] = useState<AntigravityState>({
    phase: "loading",
    auth: null,
    catalogue: null,
    catalogueError: null,
    catalogueLoading: false,
    quota: null,
    quotaError: null,
    signInError: null,
    error: null,
  });
  /** Bumped whenever the stored account list may have changed. */
  const [accountsVersion, setAccountsVersion] = useState(0);
  const [importing, setImporting] = useState(false);

  /**
   * Read the main account's models (mirrored into the picker) and its quota.
   * Two endpoints, asked together; either can fail without hiding the other.
   */
  const loadCatalogue = useCallback(() => {
    setState((s) => ({ ...s, catalogueLoading: true, catalogueError: null, quotaError: null }));
    void Promise.allSettled([antigravityModelsList(), antigravityQuotaGet()]).then(
      ([models, quota]) => {
        if (models.status === "fulfilled") syncAntigravityModels(models.value);
        setState((s) => ({
          ...s,
          catalogueLoading: false,
          catalogue: models.status === "fulfilled" ? models.value : s.catalogue,
          catalogueError: models.status === "rejected" ? errorText(models.reason) : null,
          quota: quota.status === "fulfilled" ? quota.value : s.quota,
          quotaError: quota.status === "rejected" ? errorText(quota.reason) : null,
        }));
      },
    );
  }, []);

  const refreshStatus = useCallback(() => {
    antigravityAuthStatus()
      .then((auth) => {
        setState((s) => ({
          ...s,
          // Don't stomp a sign-in in progress with a stale probe.
          phase: s.phase === "signing-in" ? s.phase : auth.signedIn ? "ready" : "signed-out",
          auth,
          error: null,
        }));
        if (auth.signedIn) loadCatalogue();
        // The last account is gone: the picker must not keep offering models
        // nothing can serve.
        else clearAntigravityModels();
      })
      .catch((err) => setState((s) => ({ ...s, phase: "error", error: errorText(err) })));
  }, [loadCatalogue]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  /** Re-read everything after the account list changed underneath the card. */
  const reload = useCallback(() => {
    setAccountsVersion((n) => n + 1);
    refreshStatus();
  }, [refreshStatus]);

  const signIn = useCallback(() => {
    setState((s) => ({ ...s, phase: "signing-in", signInError: null }));
    antigravityAuthLogin()
      .then(() => {
        // The new account joins the list and becomes main only if it is the
        // first; re-read main rather than assuming it is the one just added.
        setState((s) => ({ ...s, phase: "loading" }));
        reload();
      })
      .catch((err) =>
        setState((s) => ({
          ...s,
          phase: s.auth?.signedIn ? "ready" : "signed-out",
          signInError: errorText(err),
        })),
      );
  }, [reload]);

  const cancelSignIn = useCallback(() => {
    void antigravityAuthCancelLogin();
    // Adding a second account starts from "ready"; cancelling goes back there.
    setState((s) => ({ ...s, phase: s.auth?.signedIn ? "ready" : "signed-out" }));
  }, []);

  const signOut = useCallback(() => {
    antigravityAuthLogout()
      .then(() => {
        setState((s) => ({ ...s, auth: null, catalogue: null, quota: null, signInError: null }));
        // Another stored account may have just become main.
        reload();
      })
      .catch((err) => setState((s) => ({ ...s, signInError: errorText(err) })));
  }, [reload]);

  const importFromIde = useCallback(() => {
    setImporting(true);
    setState((s) => ({ ...s, signInError: null }));
    antigravityAccountImportIde()
      .then(() => reload())
      .catch((err) => setState((s) => ({ ...s, signInError: errorText(err) })))
      .finally(() => setImporting(false));
  }, [reload]);

  return {
    ...state,
    importing,
    accountsVersion,
    loadCatalogue,
    refreshStatus,
    signIn,
    cancelSignIn,
    signOut,
    importFromIde,
  };
}

// ── Small presentational bits (Atlas family) ─────────────────────────────────

/** Fill is quota USED, so a fuller bar means closer to stopping, as on the other cards. */
const Meter: React.FC<{ used: number }> = ({ used }) => (
  <div className="agw-atlas-meter">
    <span
      className="agw-atlas-meter-fill"
      data-tone={used > 0.9 ? "danger" : used > 0.7 ? "warn" : "accent"}
      style={{ width: `${Math.min(100, Math.max(0, used * 100)).toFixed(1)}%` }}
    />
  </div>
);

/** Said once, where the choice to connect is made. */
const RISK_NOTE =
  "Google can suspend an account it sees used outside its own apps. Use an account you can afford to lose access to.";

// ── Card ─────────────────────────────────────────────────────────────────────

export const AntigravityProviderCard: React.FC<{
  enabled: boolean;
  onToggleEnabled: (next: boolean) => void;
}> = ({ enabled, onToggleEnabled }) => {
  const {
    phase,
    auth,
    catalogue,
    catalogueError,
    catalogueLoading,
    quota,
    quotaError,
    signInError,
    error,
    importing,
    accountsVersion,
    loadCatalogue,
    refreshStatus,
    signIn,
    cancelSignIn,
    signOut,
    importFromIde,
  } = useAntigravity();
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  const plan = antigravityPlanLabel(auth);
  const who = auth?.email || auth?.name || null;
  const notices = catalogue ? antigravityNotices(catalogue.models) : [];

  return (
    <section className="agw-atlas" aria-label="Antigravity sign-in and quota">
      <div className="agw-atlas-head">
        <ProviderAvatar provider={{ id: "antigravity", name: "Antigravity" }} />
        <div className="agw-atlas-head-titles">
          <div className="agw-atlas-title">
            Antigravity
            {phase === "ready" && plan && <span className="agw-sub-plan">{plan}</span>}
          </div>
          <div className="agw-atlas-sub">
            {phase === "ready" && (who ? `Signed in as ${who}` : "Signed in with Google")}
            {phase === "signed-out" && "Uses your Google account's Antigravity plan — no API key"}
            {phase === "signing-in" && "Waiting for the browser…"}
            {phase === "loading" && "Checking sign-in…"}
            {phase === "error" && "Couldn't check sign-in"}
          </div>
        </div>
        <div className="agw-atlas-head-actions">
          {phase === "ready" && (
            <button
              type="button"
              className="agw-prov-icon-btn"
              title="Refresh models and quota"
              aria-label="Refresh models and quota"
              onClick={loadCatalogue}
              disabled={catalogueLoading}
            >
              <AgentIcon name="retry" size={14} />
            </button>
          )}
          <span className="agw-atlas-head-sep" aria-hidden="true" />
          <AgwSwitch checked={enabled} onChange={onToggleEnabled} ariaLabel="Enable Antigravity" />
        </div>
      </div>

      {phase === "loading" && (
        <div className="agw-atlas-body">
          <div className="agw-atlas-skeleton" />
          <div className="agw-atlas-skeleton" style={{ width: "72%" }} />
        </div>
      )}

      {phase === "error" && (
        <div className="agw-atlas-error">
          <span>{error}</span>
        </div>
      )}

      {phase === "signed-out" && (
        <div className="agw-atlas-body agw-codex-signin">
          <div className="agw-atlas-hint">
            Chat with Gemini, Claude and GPT-OSS on your Google account's
            Antigravity plan. Sign in with Google, or import the account
            Antigravity IDE already uses on this machine. Aurora keeps its own
            copy either way.
          </div>
          <div className="agw-codex-note">{RISK_NOTE}</div>
          {signInError && (
            <div className="agw-codex-note" data-tone="error">
              {signInError}
            </div>
          )}
          <div className="agw-codex-actions">
            <AgwButton variant="primary" onClick={signIn} disabled={importing}>
              Sign in with Google
            </AgwButton>
            <AgwButton onClick={importFromIde} disabled={importing}>
              {importing ? "Importing…" : "Import from Antigravity IDE"}
            </AgwButton>
          </div>
        </div>
      )}

      {phase === "signing-in" && (
        <div className="agw-atlas-body agw-codex-signin">
          <div className="agw-atlas-hint">
            Finish signing in to Google in your browser. This card updates by
            itself once you're done.
          </div>
          <div className="agw-codex-actions">
            <AgwButton onClick={cancelSignIn}>Cancel</AgwButton>
          </div>
        </div>
      )}

      {phase === "ready" && (
        <div className="agw-atlas-body">
          {signInError && (
            <div className="agw-codex-note" data-tone="error">
              {signInError}
            </div>
          )}

          {catalogueLoading && !catalogue && (
            <>
              <div className="agw-atlas-skeleton" />
              <div className="agw-atlas-skeleton" style={{ width: "72%" }} />
            </>
          )}

          {catalogueError && !catalogue && (
            <div className="agw-atlas-error">
              <span>{catalogueError}</span>
              <button type="button" className="agw-atlas-retry" onClick={loadCatalogue}>
                <AgentIcon name="retry" size={13} /> Retry
              </button>
            </div>
          )}

          {quota && (
            <div className="agw-cc-windows">
              {quota.groups.map((group) => (
                <section key={group.name} aria-label={`${group.name} limits`}>
                  <div className="agw-atlas-stat-label" title={group.description ?? undefined}>
                    {group.name}
                  </div>
                  {group.buckets.map((bucket) => (
                    <div className="agw-codex-window" key={bucket.id || bucket.window}>
                      <div className="agw-codex-window-head">
                        <span className="agw-codex-window-label">{antigravityBucketLabel(bucket)}</span>
                        <span className="agw-codex-window-meta">{antigravityBucketMeta(bucket)}</span>
                      </div>
                      <Meter used={(100 - bucket.remainingPercent) / 100} />
                    </div>
                  ))}
                </section>
              ))}
              {quota.groups.length === 0 && (
                <div className="agw-atlas-note">This account reported no quota figures.</div>
              )}
            </div>
          )}
          {quotaError && !quota && (
            <div className="agw-atlas-error">
              <span>Couldn't read the quota: {quotaError}</span>
            </div>
          )}

          {catalogue && (
            <div className="agw-cc-windows">
              <div className="agw-atlas-note">
                {catalogue.models.length === 1
                  ? "1 model from this account is in the model picker."
                  : `${catalogue.models.length} models from this account are in the model picker.`}
              </div>
              {notices.map((n) => (
                <div className="agw-codex-note" key={n.text}>
                  <strong>{n.title}:</strong> {n.text}{" "}
                  <span title={n.models.join(", ")}>
                    ({n.models.length === 1 ? n.models[0] : `${n.models.length} models`})
                  </span>
                </div>
              ))}
            </div>
          )}

          <AntigravityAccountSwitcher
            refreshToken={accountsVersion}
            onAddAccount={signIn}
            onChanged={refreshStatus}
          />

          <div className="agw-codex-foot">
            {catalogue && (
              <span className="agw-atlas-updated">Updated {fmtRelative(catalogue.fetchedAtMs)} ago</span>
            )}
            <span className="agw-codex-foot-spacer" />
            {confirmingSignOut ? (
              <span className="agw-codex-confirm">
                Removes this account from Aurora. Antigravity IDE stays signed in.
                <button
                  type="button"
                  className="agw-codex-link"
                  data-tone="danger"
                  onClick={() => {
                    setConfirmingSignOut(false);
                    signOut();
                  }}
                >
                  Sign out
                </button>
                <button
                  type="button"
                  className="agw-codex-link"
                  onClick={() => setConfirmingSignOut(false)}
                >
                  Keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="agw-codex-link"
                onClick={() => setConfirmingSignOut(true)}
              >
                Sign out
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
};

export default AntigravityProviderCard;
