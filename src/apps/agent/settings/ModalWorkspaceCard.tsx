/**
 * Agent Window — Modal workspace card (view).
 *
 * Rendered as the identity block in the Providers detail pane for the Modal
 * row, replacing the generic name/type head the way Atlas, Codex, Cursor,
 * OpenCode and kenari do. Unlike those, it also owns the CONNECTION: workspace,
 * token, endpoint list, region and wire all live here, because on Modal they
 * are one decision — the workspace names the token, the token unlocks the
 * gateway, the gateway answers with the endpoints. The standard Models section
 * still renders below, holding the rows this card fills.
 *
 * ## One row, many workspaces
 *
 * There is exactly ONE Modal row in the providers list, whatever number of
 * Modal accounts you have. The Workspace control swaps which one that row is
 * showing: its token, its region and its endpoints, all at once.
 *
 * Each workspace's token and model rows are kept by `commands/modal.rs` in
 * `<root>/auth/modal-workspaces.json`, so switching away and back restores a
 * workspace exactly as it was left — the same token, the same prices and
 * effort levels on each endpoint. That store is the whole point. Modal shows a
 * proxy secret exactly once at creation, so a switch that forgot the token
 * would not be an inconvenience: it would mint a fresh credential every time
 * and leave the old one live on the account.
 *
 * A workspace the CLI is signed in to but Aurora has never held appears in the
 * same list. Choosing it mints its token once, and from then on it is restored
 * like any other. Signing in is how a new workspace joins the list.
 *
 * **The tradeoff, stated plainly:** a conversation pins `providerId:modelKey`,
 * and there is one provider id, so a chat pinned to workspace A's endpoint
 * cannot run while the row is showing workspace B. It fails with the gateway's
 * own "unknown inference model" rather than doing anything destructive, and
 * switching back makes it work again. One row was the explicit ask; this is
 * what it costs.
 *
 * ## Why the card is quiet on mount
 *
 * Every CLI answer is a Python process (`--version` 0.79s, `billing summary`
 * 2.9s, measured 2026-09-03), and this pane is a list people click through.
 * Nothing here runs the CLI or the gateway on mount: the CLI status and the
 * spend figure are read from Aurora's cache, and the endpoints are already
 * model rows. The refresh control in the header is the one thing that goes and
 * asks, and it asks for all three at once.
 *
 * Reuses the `.agw-atlas-*` frame so the subscription cards read as one
 * system; Modal-only pieces are `.agw-modal-*`.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";

import { useSettingsStore, type LLMModel, type LLMProvider } from "@/kernel/store/useSettingsStore";
import {
  fetchModalWorkspaceModels,
  fmtUsd,
  isModalProvider,
  mergeEndpointModels,
  modalBillingSummary,
  modalCliStatus,
  modalCreateProxyToken,
  modalGatewayUrl,
  modalSaveWorkspace,
  modalSignIn,
  modalUseWorkspace,
  modalWire,
  modalWorkspaceOptions,
  modalWorkspaces,
  profileForWorkspace,
  providerWorkspace,
  regionFromBaseUrl,
  toModelInit,
  workspaceNickname,
  MODAL_CLI_INSTALL,
  MODAL_DASHBOARD_URL,
  MODAL_DEFAULT_REGION,
  MODAL_PROVIDER_ID,
  MODAL_REGIONS,
  MODAL_WIRES,
  WORKSPACE_NICKNAME_PREFIX,
  type ModalBillingSummary,
  type ModalCliStatus,
  type ModalWire,
  type ModalWorkspaceList,
  type ModelInit,
} from "@/apps/agent/services/providers/modal";
import { fmtRelative } from "@/apps/agent/services/providers/atlascloud";
import { AgentIcon } from "../shared/AgentIcon";
import { ProviderAvatar } from "./ProviderAvatar";
import {
  AgwButton,
  AgwPill,
  AgwSegmented,
  AgwSelect,
  AgwSwitch,
  AgwTextInput,
  type SelectOption,
} from "./primitives";

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** A nickname this card wrote itself, as opposed to one the person typed. */
const isAutoNickname = (nickname: string | undefined): boolean =>
  !nickname || nickname.startsWith(WORKSPACE_NICKNAME_PREFIX);

const NO_CLI: ModalCliStatus = {
  installed: false,
  version: null,
  command: null,
  profiles: [],
  configPath: null,
  checkedAtMs: 0,
};

const NO_WORKSPACES: ModalWorkspaceList = { active: null, saved: [] };

/** A spend figure older than this says how old it is, rather than implying now. */
const SPEND_FRESH_MS = 5 * 60 * 1000;

/**
 * An earlier build gave each workspace its own provider row, which is how
 * someone with two Modal accounts ended up with three Modal entries in the
 * list. Fold any extra row back into the workspace store and delete it. Runs
 * once per session, whichever Modal row the card happens to be rendering.
 */
let foldedExtraRows = false;

export const ModalWorkspaceCard: React.FC<{
  provider: LLMProvider;
  models: LLMModel[];
  /** Show a different provider row — used only to leave a row being folded in. */
  onSelectProvider?: (id: string) => void;
}> = ({ provider, models, onSelectProvider }) => {
  const updateProvider = useSettingsStore((s) => s.updateProvider);
  const replaceModelsForProvider = useSettingsStore((s) => s.replaceModelsForProvider);
  const removeProvider = useSettingsStore((s) => s.removeProvider);

  const [cli, setCli] = useState<ModalCliStatus | null>(null);
  const [saved, setSaved] = useState<ModalWorkspaceList>(NO_WORKSPACES);
  const [showToken, setShowToken] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signInNote, setSignInNote] = useState<string | null>(null);
  const [billing, setBilling] = useState<ModalBillingSummary | null>(null);
  const [billingLoading, setBillingLoading] = useState(false);
  // The header's refresh spans three round trips. Its own flag, because
  // `refreshing` only covers the last of them.
  const [probing, setProbing] = useState(false);

  // What the card was last told this row is showing. The endpoints and the
  // nickname answer first and are authoritative, but a workspace that was just
  // switched to and whose endpoint load then failed has neither, and would
  // otherwise read as "not set up" while holding a working token.
  const [switchedTo, setSwitchedTo] = useState<string | null>(null);
  const workspace = useMemo(
    () => providerWorkspace(provider, models) ?? switchedTo,
    [provider, models, switchedTo],
  );
  const region = regionFromBaseUrl(provider.baseUrl) ?? MODAL_DEFAULT_REGION;
  const wire = modalWire(provider);
  const hasToken = provider.apiKey.trim().length > 0;
  const profiles = useMemo(() => cli?.profiles ?? [], [cli]);

  const options = useMemo(
    () => modalWorkspaceOptions(saved.saved, profiles),
    [saved, profiles],
  );

  /** Put the row on a workspace: its token, its gateway, its endpoints. */
  const applyWorkspace = useCallback(
    (name: string, token: string, nextRegion: string, rows: readonly ModelInit[]) => {
      setSwitchedTo(name || null);
      updateProvider(provider.id, {
        apiKey: token,
        baseUrl: modalGatewayUrl(nextRegion || MODAL_DEFAULT_REGION),
        ...(isAutoNickname(provider.nickname) && name
          ? { nickname: workspaceNickname(name) }
          : {}),
      });
      replaceModelsForProvider(provider.id, [...rows]);
    },
    [provider.id, provider.nickname, replaceModelsForProvider, updateProvider],
  );

  /** Store the row as it stands, so leaving this workspace loses nothing. */
  const rememberCurrent = useCallback(
    async (rows?: readonly ModelInit[]) => {
      if (!workspace || !hasToken) return;
      await modalSaveWorkspace(
        workspace,
        provider.apiKey,
        region,
        rows ?? models.map(toModelInit),
      ).catch((cause) => setSwitchError(errorText(cause)));
    },
    [workspace, hasToken, provider.apiKey, region, models],
  );

  // Cached answers only — no process starts, no network. `refresh` is false,
  // so this is a file read of whatever the last real probe found.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [status, list] = await Promise.all([
        modalCliStatus(false).catch(() => NO_CLI),
        modalWorkspaces().catch(() => NO_WORKSPACES),
      ]);
      if (!alive) return;
      setCli(status);
      setSaved(list);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Spend belongs to THIS workspace, read through the profile that
  // authenticates it. Reading the active profile's spend for a row showing
  // another workspace would put a real number under the wrong name.
  const billingProfile = profileForWorkspace(profiles, workspace)?.name ?? null;

  useEffect(() => {
    if (!billingProfile) {
      setBilling(null);
      return;
    }
    let alive = true;
    setBillingLoading(true);
    void (async () => {
      const summary = await modalBillingSummary(billingProfile, "this month", false).catch(
        () => null,
      );
      if (!alive) return;
      setBilling(summary);
      setBillingLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [billingProfile]);

  /**
   * Pull the endpoint list, fold it into the model rows, and store the result
   * under its workspace.
   *
   * `baseUrl` and `token` are passed rather than read, because the caller may
   * be committing a region or a token the row does not hold yet — a region is
   * only written after its gateway has answered.
   */
  const loadEndpoints = useCallback(
    async (baseUrl: string, token: string, commitBaseUrl = false): Promise<boolean> => {
      if (!token.trim()) {
        setRefreshError("Add this workspace's proxy token first.");
        return false;
      }
      setRefreshing(true);
      setRefreshError(null);
      try {
        const fresh = await fetchModalWorkspaceModels(baseUrl, token);
        const merged = mergeEndpointModels(models, fresh);
        const patch: Partial<LLMProvider> = {};
        if (commitBaseUrl) patch.baseUrl = baseUrl;
        const found = fresh[0]?.workspace;
        if (found && isAutoNickname(provider.nickname)) {
          patch.nickname = workspaceNickname(found);
        }
        if (Object.keys(patch).length > 0) updateProvider(provider.id, patch);
        replaceModelsForProvider(provider.id, merged.models, merged.renames);
        // The gateway just told us which workspace this token belongs to, which
        // is the only reliable answer — so this is also where a pasted token
        // gets filed under its real name.
        if (found) {
          setSwitchedTo(found);
          await modalSaveWorkspace(
            found,
            token,
            regionFromBaseUrl(baseUrl) ?? region,
            merged.models,
          ).catch(() => undefined);
          setSaved(await modalWorkspaces().catch(() => NO_WORKSPACES));
        }
        setRefreshedAt(Date.now());
        return true;
      } catch (cause) {
        // Say what was NOT done, so a failed region change does not read as a
        // row that is now half-switched.
        setRefreshError(
          commitBaseUrl ? `${errorText(cause)} The region is unchanged.` : errorText(cause),
        );
        return false;
      } finally {
        setRefreshing(false);
      }
    },
    [models, provider.id, provider.nickname, region, replaceModelsForProvider, updateProvider],
  );

  // Fold the extra rows an earlier build created back into this one.
  useEffect(() => {
    if (foldedExtraRows) return;
    foldedExtraRows = true;
    void (async () => {
      const state = useSettingsStore.getState();
      const rows = state.providers.filter((p) => isModalProvider(p));
      const keeper = rows.find((r) => r.id === MODAL_PROVIDER_ID) ?? rows[0];
      const strays = rows.filter((r) => r.id !== keeper?.id);
      if (!keeper || strays.length === 0) return;
      for (const stray of strays) {
        const own = state.models.filter((m) => m.providerId === stray.id);
        const name = providerWorkspace(stray, own);
        if (name && stray.apiKey.trim()) {
          await modalSaveWorkspace(
            name,
            stray.apiKey,
            regionFromBaseUrl(stray.baseUrl) ?? MODAL_DEFAULT_REGION,
            own.map(toModelInit),
          ).catch(() => undefined);
        }
        removeProvider(stray.id);
      }
      setSaved(await modalWorkspaces().catch(() => NO_WORKSPACES));
      if (provider.id !== keeper.id) onSelectProvider?.(keeper.id);
    })();
  }, [provider.id, removeProvider, onSelectProvider]);

  /** The header's refresh: ask the CLI and the gateway again, all of it. */
  const refreshAll = useCallback(async () => {
    setSignInNote(null);
    setProbing(true);
    try {
      const status = await modalCliStatus(true).catch(() => NO_CLI);
      setCli(status);
      const profile = profileForWorkspace(status.profiles, workspace)?.name ?? null;
      if (profile) {
        setBillingLoading(true);
        setBilling(await modalBillingSummary(profile, "this month", true).catch(() => null));
        setBillingLoading(false);
      }
      if (hasToken) await loadEndpoints(provider.baseUrl, provider.apiKey);
    } finally {
      setProbing(false);
    }
  }, [workspace, hasToken, loadEndpoints, provider.baseUrl, provider.apiKey]);

  /**
   * Show a different workspace on this row.
   *
   * A workspace Aurora already holds is restored from the store: no network,
   * no CLI, and above all no minting. One the CLI is signed in to but Aurora
   * has never held is minted once, here, and then it is the first kind
   * forever.
   */
  const switchTo = async (name: string) => {
    const option = options.find((o) => o.workspace === name);
    if (!option || name === workspace) return;
    setSwitching(true);
    setSwitchError(null);
    setRefreshError(null);
    setTokenError(null);
    setConfirmReplace(false);
    try {
      await rememberCurrent();
      if (option.profileName) {
        const token = await modalCreateProxyToken(option.profileName);
        applyWorkspace(name, token.bearer, region, []);
        await modalSaveWorkspace(name, token.bearer, region, []);
        await loadEndpoints(modalGatewayUrl(region), token.bearer);
      } else {
        const record = await modalUseWorkspace(name);
        applyWorkspace(record.workspace, record.token, record.region, record.models);
        setRefreshedAt(null);
      }
      setSaved(await modalWorkspaces().catch(() => NO_WORKSPACES));
    } catch (cause) {
      setSwitchError(errorText(cause));
    } finally {
      setSwitching(false);
    }
  };

  /**
   * Mint this workspace's token — only ever this workspace's.
   *
   * A row that does not know its workspace yet gets no mint button at all.
   * Minting from whichever profile happened to be active would hand it a token
   * for a workspace that probably already has one, quietly making a second
   * credential. Choosing a workspace above is the way in.
   */
  const mintProfile = profileForWorkspace(profiles, workspace)?.name ?? null;
  const canMint = !!cli?.installed && mintProfile !== null;

  const createToken = async () => {
    if (!mintProfile) return;
    if (hasToken && !confirmReplace) {
      setConfirmReplace(true);
      return;
    }
    setConfirmReplace(false);
    setTokenBusy(true);
    setTokenError(null);
    try {
      const token = await modalCreateProxyToken(mintProfile);
      updateProvider(provider.id, { apiKey: token.bearer });
      await loadEndpoints(provider.baseUrl, token.bearer);
    } catch (cause) {
      setTokenError(errorText(cause));
    } finally {
      setTokenBusy(false);
    }
  };

  /**
   * Change which gateway serves this workspace.
   *
   * The list is fetched BEFORE the region is stored. A region written first and
   * fetched second leaves the row pointing at one gateway while its model ids
   * name another the moment the fetch fails, and every turn after that is
   * `unknown inference model` with nothing on screen saying so.
   */
  const changeRegion = (value: string) => {
    if (value === "custom" || value === region) return;
    const baseUrl = modalGatewayUrl(value);
    if (!hasToken) {
      updateProvider(provider.id, { baseUrl });
      return;
    }
    void loadEndpoints(baseUrl, provider.apiKey, true);
  };

  const signIn = async () => {
    setSigningIn(true);
    setSignInNote(null);
    try {
      const result = await modalSignIn();
      setSignInNote(`Signed in to ${result.workspace}. Pick it under Workspace to set it up.`);
      setCli(await modalCliStatus(true).catch(() => NO_CLI));
    } catch (cause) {
      setSignInNote(errorText(cause));
    } finally {
      setSigningIn(false);
    }
  };

  const workspaceSelectOptions = useMemo<SelectOption[]>(() => {
    const rows: SelectOption[] = options.map((o) => ({
      value: o.workspace,
      label: o.workspace,
      meta:
        o.endpointCount === null
          ? "set up"
          : o.endpointCount === 1
            ? "1 endpoint"
            : `${o.endpointCount} endpoints`,
    }));
    // The row holds a token whose workspace is not known yet — a pasted one
    // that has never reached the gateway. Shown as itself so the control has a
    // value, and replaced by the real name on the first successful load.
    if (!workspace) rows.unshift({ value: "", label: "Not set up" });
    return rows;
  }, [options, workspace]);

  const regionOptions = useMemo(() => {
    const list = MODAL_REGIONS.map((r) => ({ value: r.value, label: r.label }));
    // A hand-edited base URL that is not a gateway is shown as itself, rather
    // than snapping the picker to a region it does not route through.
    if (regionFromBaseUrl(provider.baseUrl) === null && provider.baseUrl.trim()) {
      list.push({ value: "custom", label: "Custom URL" });
    }
    return list;
  }, [provider.baseUrl]);

  const regionLabel = MODAL_REGIONS.find((r) => r.value === region)?.label ?? region;
  const subline = !workspace && !hasToken
    ? "Not set up yet — choose a workspace below"
    : !workspace
      ? "Token saved — load the endpoints to see which workspace it belongs to"
      : !hasToken
        ? `${workspace} has no token yet`
        : models.length === 0
          ? "Token saved — load this workspace's endpoints"
          : `${models.length} ${models.length === 1 ? "endpoint" : "endpoints"} routed through ${regionLabel}`;

  const spendStale = !!billing && Date.now() - billing.checkedAtMs > SPEND_FRESH_MS;
  const spendDetail = billing
    ? [
        `${fmtUsd(billing.llmTokensCost)} tokens`,
        `${fmtUsd(billing.endpointCost)} endpoint compute`,
        billing.otherCost > 0 ? `${fmtUsd(billing.otherCost)} volumes and other` : null,
        billing.creditsApplied > 0 ? `${fmtUsd(billing.creditsApplied)} credits applied` : null,
        "Modal reports spend, not a balance.",
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;

  return (
    <section className="agw-atlas" aria-label="Modal workspace">
      <div className="agw-atlas-head">
        <ProviderAvatar provider={{ id: "modal", name: "Modal" }} />
        <div className="agw-atlas-head-titles">
          <div className="agw-atlas-title">
            Modal
            {workspace && <AgwPill tone="neutral">{workspace}</AgwPill>}
          </div>
          <div className="agw-atlas-sub">{subline}</div>
        </div>
        {billingLoading && !billing ? (
          <div className="agw-modal-spend" aria-label="Loading spend" aria-busy="true">
            <span className="agw-atlas-skeleton agw-modal-skeleton" style={{ width: 56, height: 14 }} />
            <span className="agw-atlas-skeleton agw-modal-skeleton" style={{ width: 132, height: 9 }} />
          </div>
        ) : billing ? (
          /* Spend beside the name, the way kenari shows its plan: the one
             number that hits the card on file, with the token line under it
             because that line is Aurora's doing. A reading that is no longer
             fresh says its age instead of passing for the current total. */
          <div className="agw-modal-spend" title={spendDetail} data-busy={billingLoading || undefined}>
            <span className="agw-modal-spend-amount">{fmtUsd(billing.billedCost)}</span>
            <span className="agw-modal-spend-caption">
              this month · {fmtUsd(billing.llmTokensCost)} tokens
              {spendStale && billing.checkedAtMs > 0 && ` · ${fmtRelative(billing.checkedAtMs)} ago`}
            </span>
          </div>
        ) : null}
        <div className="agw-atlas-head-actions">
          <button
            type="button"
            className="agw-prov-icon-btn"
            title="Refresh endpoints, spend and CLI status"
            aria-label="Refresh endpoints, spend and CLI status"
            aria-busy={probing || undefined}
            disabled={probing || refreshing || switching}
            onClick={() => void refreshAll()}
          >
            <AgentIcon name="retry" size={14} />
          </button>
          <a
            className="agw-prov-icon-btn"
            href={MODAL_DASHBOARD_URL}
            target="_blank"
            rel="noreferrer"
            title="Open the Modal dashboard"
            aria-label="Open the Modal dashboard"
          >
            <AgentIcon name="external" size={14} />
          </a>
          <span className="agw-atlas-head-sep" aria-hidden="true" />
          <AgwSwitch
            checked={provider.enabled}
            onChange={(v) => updateProvider(provider.id, { enabled: v })}
            ariaLabel="Enable Modal"
          />
        </div>
      </div>

      <div className="agw-atlas-body agw-modal-body">
        {/* Which workspace this row is showing. First, because everything
            under it belongs to whichever one is chosen. */}
        <div className="agw-modal-row">
          <span className="agw-modal-row-label">Workspace</span>
          <div className="agw-modal-row-control">
            <AgwSelect
              value={workspace ?? ""}
              options={workspaceSelectOptions}
              onChange={(next) => void switchTo(next)}
              ariaLabel="Modal workspace"
              disabled={switching || refreshing}
              width={260}
            />
            {switching && <span className="agw-atlas-updated">Switching…</span>}
          </div>
          <span className="agw-modal-hint">
            One Modal row, whichever workspace it is showing. Aurora keeps each one's token and
            endpoints, so switching back restores it as you left it and never asks for a new
            token. A chat that ran on another workspace needs that workspace selected to run
            again.
          </span>
          {switchError && (
            <span className="agw-modal-note" data-tone="error" role="alert">
              {switchError}
            </span>
          )}
        </div>

        <div className="agw-modal-row">
          <span className="agw-modal-row-label">Proxy token</span>
          <div className="agw-modal-row-control">
            <div className="agw-prov-key-row agw-modal-token">
              <AgwTextInput
                type={showToken ? "text" : "password"}
                value={provider.apiKey}
                placeholder="wk-….ws-…"
                onChange={(e) => {
                  setConfirmReplace(false);
                  updateProvider(provider.id, { apiKey: e.target.value });
                }}
              />
              <button
                type="button"
                className="agw-prov-icon-btn"
                onClick={() => setShowToken((v) => !v)}
                aria-label={showToken ? "Hide proxy token" : "Show proxy token"}
                aria-pressed={showToken}
                title={showToken ? "Hide proxy token" : "Show proxy token"}
              >
                <AgentIcon name={showToken ? "eye-off" : "eye"} size={14} />
              </button>
            </div>
            {canMint && (
              /* Replacing a working token is a real loss — Modal shows a
                 secret once and the old one keeps billing until it is
                 deleted — so it takes a second click. Creating the first one
                 costs nothing and takes one. */
              <AgwButton
                icon="plug"
                variant={confirmReplace ? "danger" : "secondary"}
                onClick={() => void createToken()}
                disabled={tokenBusy || switching}
              >
                {tokenBusy
                  ? "Creating…"
                  : confirmReplace
                    ? "Replace it — the current one keeps billing"
                    : hasToken
                      ? "Replace token"
                      : "Create token"}
              </AgwButton>
            )}
          </div>
          <span className="agw-modal-hint">
            {!workspace ? (
              <>
                Paste a proxy token and loading the endpoints files it under whichever workspace
                it belongs to. Or choose a workspace above and Aurora creates the token for you.
              </>
            ) : canMint ? (
              <>
                One token covers every endpoint in {workspace}. Paste one from the dashboard, or
                create it here. Modal shows a new token's secret once; Aurora keeps it with this
                workspace.
              </>
            ) : (
              <>
                One token covers every endpoint in {workspace}. Paste one from the Modal
                dashboard — Aurora can only create tokens for a workspace the CLI is signed in
                to.
              </>
            )}
          </span>
          {tokenError && (
            <span className="agw-modal-note" data-tone="error" role="alert">
              {tokenError}
            </span>
          )}
        </div>

        <div className="agw-modal-row">
          <span className="agw-modal-row-label">Endpoints</span>
          <div className="agw-modal-row-control">
            {models.length === 0 ? (
              /* The empty state's next action. Once endpoints exist, the
                 header's refresh is the only one — two buttons doing the same
                 thing on one card is how they end up disagreeing. */
              <AgwButton
                variant="primary"
                icon="retry"
                onClick={() => void loadEndpoints(provider.baseUrl, provider.apiKey)}
                disabled={refreshing || switching || !hasToken}
              >
                {refreshing ? "Loading…" : "Load endpoints"}
              </AgwButton>
            ) : (
              <div
                className="agw-modal-endpoints"
                aria-label="Endpoints in this workspace"
                data-busy={refreshing || switching || undefined}
              >
                {models.map((m) => (
                  <span key={m.id} className="agw-modal-endpoint" title={m.modelKey}>
                    {m.label ?? m.modelKey}
                  </span>
                ))}
              </div>
            )}
            {refreshedAt && !refreshError && models.length > 0 && (
              <span className="agw-atlas-updated">Updated {fmtRelative(refreshedAt)} ago</span>
            )}
          </div>
          {models.length === 0 && (refreshing || switching) && (
            <div className="agw-modal-endpoints" aria-busy="true" aria-label="Loading endpoints">
              <span className="agw-atlas-skeleton agw-modal-skeleton" style={{ width: 84, height: 20 }} />
              <span className="agw-atlas-skeleton agw-modal-skeleton" style={{ width: 64, height: 20 }} />
            </div>
          )}
          <span className="agw-modal-hint">
            The models below are this workspace's live endpoints. Deploy a new one with{" "}
            <code>modal endpoint create</code> and refresh; one that was stopped disappears on
            the next refresh.
          </span>
          {refreshError && (
            <span className="agw-modal-note" data-tone="error" role="alert">
              {refreshError}
            </span>
          )}
        </div>

        {/* Directly under Endpoints: region decides which gateway lists and
            serves them, so it is part of the same fact, not a preference. */}
        <div className="agw-modal-row">
          <span className="agw-modal-row-label">Region</span>
          <div className="agw-modal-row-control">
            <AgwSelect
              value={regionFromBaseUrl(provider.baseUrl) ?? "custom"}
              options={regionOptions}
              onChange={changeRegion}
              ariaLabel="Gateway region"
              disabled={refreshing || switching}
              width={200}
            />
          </div>
          <span className="agw-modal-hint">
            Where requests are routed. Any region reaches every endpoint; pick the one closest to
            you. The list reloads first and the region only changes if it answers, so a region
            that cannot be reached leaves this row working.
          </span>
        </div>

        {/* <div>, not <label>: a click on the detail line would land on the
            segmented group's first button and flip the picker. */}
        <div className="agw-modal-row">
          <span className="agw-modal-row-label">API format</span>
          <div className="agw-modal-row-control">
            <AgwSegmented<ModalWire>
              ariaLabel="Modal API format"
              value={wire}
              options={MODAL_WIRES.map((w) => ({ value: w.value, label: w.label }))}
              onChange={(next) => updateProvider(provider.id, { providerType: next })}
            />
          </div>
          <span className="agw-modal-hint">{MODAL_WIRES.find((w) => w.value === wire)?.detail}</span>
        </div>

        {/* The CLI strip: what Aurora found, and the one thing it unlocks that
            nothing else can — another workspace to sign in to. */}
        <div className="agw-modal-cli">
          <span className="agw-modal-cli-text" aria-busy={cli === null || undefined}>
            {cli === null && (
              <span className="agw-atlas-skeleton agw-modal-skeleton" style={{ width: "58%", height: 12 }} />
            )}
            {cli && !cli.installed && (
              <>
                Modal CLI not installed. <code>{MODAL_CLI_INSTALL}</code> adds one-click tokens,
                sign-in and spend.
              </>
            )}
            {cli?.installed && (
              <>
                Modal CLI{cli.version ? ` ${cli.version}` : ""}
                {profiles.length > 0
                  ? ` · signed in to ${profiles.map((p) => p.workspace || p.name).join(", ")}`
                  : " · not signed in to any workspace"}
              </>
            )}
            {signInNote && <span className="agw-modal-cli-note"> {signInNote}</span>}
          </span>
          {cli?.installed && (
            <AgwButton icon="plug" onClick={() => void signIn()} disabled={signingIn}>
              {signingIn ? "Finish signing in in the browser…" : "Sign in to a workspace"}
            </AgwButton>
          )}
        </div>
      </div>
    </section>
  );
};

export default ModalWorkspaceCard;
