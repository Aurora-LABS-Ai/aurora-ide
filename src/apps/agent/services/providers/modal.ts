/**
 * Modal — one workspace's LLM inference endpoints as one provider.
 *
 * Measured against live endpoints on 2026-09-02, not read off a docs page:
 *
 * - A Modal Endpoint is a deployed server with its own hostname
 *   (`maya--ep-kimi-k3-server.us-west.modal.direct`). The regional gateway
 *   `https://inference.<region>.modal.direct/v1` lists every live endpoint in
 *   a workspace through `/v1/models` and addresses each one by that hostname
 *   as the model id. So the provider row is the WORKSPACE, its models are the
 *   endpoints, and "add an endpoint" on Modal's side is "Refresh endpoints"
 *   here.
 * - One proxy token (`wk-….ws-…`) covers the workspace. The gateway takes it
 *   only as `Authorization: Bearer`, on all three wires; the `ak-`/`as-`
 *   account tokens the CLI signs in with are refused by endpoints.
 * - Region is routing, not identity: another region's gateway lists the same
 *   endpoint under that region's hostname, so a region change re-fetches the
 *   list and the model ids change with it.
 * - Every endpoint answers chat completions, Anthropic messages and the
 *   Responses wire. Chat renders replayed `reasoning_content` into the prompt
 *   (prompt tokens rose by the reasoning's size), so thinking travels back on
 *   the default wire without a setting.
 *
 * The Python CLI (`pip install modal`) is optional. Aurora uses it for two
 * chores when present — minting a proxy token and signing in to a workspace —
 * through `commands/modal.rs`, and never at request time.
 */

import { auroraInvoke as invoke } from "@/kernel/lib/ipc/runtime";
import type { LLMModel, LLMProvider } from "@/kernel/store/useSettingsStore";

export const MODAL_PROVIDER_ID = "modal";

/** Where the endpoints and proxy tokens are managed by hand. */
export const MODAL_DASHBOARD_URL = "https://modal.com/";

/** The line that installs the CLI, shown wherever it is missing. */
export const MODAL_CLI_INSTALL = "pip install modal";

export type ModalWire = "modal" | "modal-messages" | "modal-responses";

/**
 * The wire choices, in the order they are offered. Chat first: it is the
 * default, it replays thinking on its own, and it reports cache reads.
 */
export const MODAL_WIRES: ReadonlyArray<{
  value: ModalWire;
  label: string;
  /** Shown under the picker so the choice is made with its cost visible. */
  detail: string;
}> = [
  {
    value: "modal",
    label: "Chat",
    detail:
      "Recommended. Reasoning travels back on its own, cache reads are reported, and JSON schema output is enforced.",
  },
  {
    value: "modal-messages",
    label: "Messages",
    detail:
      "Anthropic's format. Thinking arrives as blocks and is replayed unsigned; no cache statistics and no schema output.",
  },
  {
    value: "modal-responses",
    label: "Responses",
    detail:
      "The Codex wire. Reports cache reads and reasoning tokens; stateless, and Aurora cannot replay its reasoning items.",
  },
];

/** Routing regions the gateway is served from, default first. */
export const MODAL_REGIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "us-west", label: "US West" },
  { value: "us-east", label: "US East" },
  { value: "ca-central", label: "Canada Central" },
  { value: "eu-west", label: "EU West" },
  { value: "ap-south", label: "Asia Pacific South" },
];

export const MODAL_DEFAULT_REGION = "us-west";

/** The gateway base URL for a region — what the provider row stores. */
export function modalGatewayUrl(region: string): string {
  return `https://inference.${region}.modal.direct/v1`;
}

/** The region a stored base URL routes through, or `null` for a custom URL. */
export function regionFromBaseUrl(baseUrl: string): string | null {
  const match = /inference\.([a-z0-9-]+)\.modal\.direct/i.exec(baseUrl.trim());
  return match ? match[1].toLowerCase() : null;
}

/** Whether this row is Modal — the shipped workspace or one the user added. */
export function isModalProvider(
  provider: Pick<LLMProvider, "id" | "providerType">,
): boolean {
  return (
    provider.id === MODAL_PROVIDER_ID ||
    (provider.providerType ?? "").toLowerCase().startsWith("modal")
  );
}

/**
 * The wire this provider is set to. Falls back to chat, which is both the
 * default and the safe answer for a row stored before the picker existed.
 */
export function modalWire(provider: Pick<LLMProvider, "id" | "providerType">): ModalWire {
  const type = provider.providerType;
  if (type === "modal-messages" || type === "modal-responses") return type;
  return "modal";
}

/** `kimi-k3` from `maya--ep-kimi-k3-server.us-west.modal.direct`. */
export function endpointNameFromModelKey(modelKey: string): string {
  const rest = modelKey.split("--")[1];
  if (!rest) return modelKey;
  const label = rest.split(".")[0] ?? rest;
  const withoutPrefix = label.startsWith("ep-") ? label.slice(3) : label;
  return withoutPrefix.endsWith("-server")
    ? withoutPrefix.slice(0, -"-server".length)
    : withoutPrefix;
}

/** `maya` from `maya--ep-kimi-k3-server.us-west.modal.direct`. */
export function workspaceFromModelKey(modelKey: string): string | null {
  const [workspace, rest] = modelKey.split("--");
  return workspace && rest ? workspace : null;
}

/**
 * What an endpoint IS, independent of where it is served from.
 *
 * The model id is a hostname and the hostname carries the region, so the same
 * endpoint has a different id on every gateway. Keyed on the hostname, a
 * region change looks like "every endpoint was deleted and five new ones
 * appeared" — which is how the price, temperature and effort a person set on
 * each row used to be thrown away, and how every conversation pinned to one
 * ended up naming a model that no longer exists. Keyed on this, a region
 * change is a rename.
 */
export function endpointIdentity(modelKey: string): string {
  const workspace = workspaceFromModelKey(modelKey);
  return workspace ? `${workspace}/${endpointNameFromModelKey(modelKey)}` : modelKey;
}

/**
 * Whether a model key is a Modal endpoint hostname.
 *
 * Both halves are required. `--` alone appears in plenty of model ids that
 * have nothing to do with Modal, and a rewrite rule that fired on those would
 * repoint another provider's conversation.
 */
export function isEndpointModelKey(modelKey: string): boolean {
  return modelKey.includes("--") && modelKey.toLowerCase().includes(".modal.direct");
}

// ── Endpoints from the gateway ───────────────────────────────────────────────

/** One endpoint as `modal_workspace_models` reports it. */
export interface ModalEndpointModel {
  /** The model id to send: the endpoint's hostname. */
  id: string;
  endpointName: string;
  workspace: string;
  region: string;
  baseModelId: string;
  displayName: string;
  contextLength: number | null;
  maxOutputLength: number | null;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
  reasoningLevels: string[];
}

export type ModelInit = Omit<LLMModel, "id" | "providerId" | "sortOrder">;

/**
 * A stored model row as the shape that can be written back.
 *
 * `id`, `providerId` and `sortOrder` are the store's to assign — carrying them
 * across a workspace switch would pin a row to the provider it came from.
 */
export function toModelInit(model: LLMModel): ModelInit {
  const rest: Partial<LLMModel> = { ...model };
  delete rest.id;
  delete rest.providerId;
  delete rest.sortOrder;
  return rest as ModelInit;
}

/** The effort level a fresh row starts on: `high` when offered, else the top. */
function defaultEffort(levels: string[]): string | undefined {
  if (levels.length === 0) return undefined;
  return levels.includes("high") ? "high" : levels[levels.length - 1];
}

/** `GLM 5.3` from the gateway's `Z.AI: GLM 5.3` — the vendor is not the name. */
function modelNameOf(displayName: string, baseModelId: string): string {
  const afterVendor = displayName.split(": ").pop()?.trim();
  if (afterVendor) return afterVendor;
  return baseModelId.split("/").pop() ?? baseModelId;
}

/** The endpoint name Modal derives from a model name: `GLM 5.3` → `glm-5-3`. */
function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * What the row is called in the picker.
 *
 * The model's name alone when the endpoint carries Modal's auto-derived name
 * for it (`glm-5-3` for GLM 5.3), which is the common case and needs no
 * qualifier. A custom endpoint name is a fact the person chose, so it stays:
 * `Qwen3.6 27B · my-finetune`.
 */
export function endpointLabel(endpoint: Pick<ModalEndpointModel, "displayName" | "baseModelId" | "endpointName">): string {
  const name = modelNameOf(endpoint.displayName, endpoint.baseModelId);
  return slug(name) === endpoint.endpointName ? name : `${name} · ${endpoint.endpointName}`;
}

/** A model row for an endpoint, with everything the gateway knows filled in. */
export function endpointToModelInit(endpoint: ModalEndpointModel): ModelInit {
  return {
    modelKey: endpoint.id,
    label: endpointLabel(endpoint),
    contextWindow: endpoint.contextLength ?? undefined,
    // The gateway reports the whole window as the output cap; a model row
    // whose output equals its context reads as a contradiction, so leave the
    // provider default in charge of the cap.
    maxOutputTokens: undefined,
    supportsVision: endpoint.supportsVision,
    supportsThinking: endpoint.supportsReasoning,
    supportsToolStream: endpoint.supportsTools,
    enabled: true,
    reasoning:
      endpoint.reasoningLevels.length > 0
        ? {
            type: "effort",
            levels: endpoint.reasoningLevels,
            default: defaultEffort(endpoint.reasoningLevels),
            supported: ["effort"],
            // Every Modal endpoint probed so far thinks by default and has no
            // off switch; only the effort is the person's to choose.
            toggleable: false,
          }
        : undefined,
  };
}

/** The outcome of folding a fresh endpoint list into the rows already stored. */
export interface EndpointMerge {
  models: ModelInit[];
  /**
   * Old model key → new one, for endpoints whose hostname moved. Only a region
   * change produces these, and the store uses them to carry the selected model
   * and the conversations pinned to it across rather than orphaning them.
   */
  renames: Record<string, string>;
}

/**
 * Fold a fresh endpoint list into the existing rows.
 *
 * Facts the gateway owns (label, context, capabilities, effort levels) are
 * refreshed; what the person set on a row (price, temperature, chosen effort,
 * on/off, extra body, format) survives. Endpoints the gateway no longer lists
 * are dropped — their hostname answers `unknown inference model` now.
 *
 * Matching is by hostname first, then by {@link endpointIdentity}, so an
 * endpoint that only changed gateway keeps everything and reports its rename.
 */
export function mergeEndpointModels(
  existing: readonly LLMModel[],
  fresh: readonly ModalEndpointModel[],
): EndpointMerge {
  const byKey = new Map(existing.map((m) => [m.modelKey, m] as const));
  const byIdentity = new Map(existing.map((m) => [endpointIdentity(m.modelKey), m] as const));
  const renames: Record<string, string> = {};
  const models = fresh.map((endpoint) => {
    const init = endpointToModelInit(endpoint);
    const kept =
      byKey.get(endpoint.id) ?? byIdentity.get(`${endpoint.workspace}/${endpoint.endpointName}`);
    if (!kept) return init;
    if (kept.modelKey !== endpoint.id) renames[kept.modelKey] = endpoint.id;
    return {
      ...init,
      enabled: kept.enabled,
      priceCacheHitPerMtok: kept.priceCacheHitPerMtok,
      priceCacheMissPerMtok: kept.priceCacheMissPerMtok,
      priceOutputPerMtok: kept.priceOutputPerMtok,
      priceCacheWritePerMtok: kept.priceCacheWritePerMtok,
      priceCurrency: kept.priceCurrency,
      temperature: kept.temperature,
      extraBody: kept.extraBody,
      providerType: kept.providerType,
      maxOutputTokens: kept.maxOutputTokens,
      reasoning:
        init.reasoning && kept.reasoning
          ? {
              ...init.reasoning,
              default: kept.reasoning.default ?? init.reasoning.default,
              enabled: kept.reasoning.enabled,
              requestMode: kept.reasoning.requestMode,
              replay: kept.reasoning.replay,
            }
          : init.reasoning,
    };
  });
  return { models, renames };
}

/** The endpoints a workspace token reaches through this gateway. */
export const fetchModalWorkspaceModels = (
  baseUrl: string,
  token: string,
): Promise<ModalEndpointModel[]> =>
  invoke<ModalEndpointModel[]>("modal_workspace_models", { baseUrl, token });

// ── The CLI, when it is there ────────────────────────────────────────────────

export interface ModalProfile {
  /** The profile's key in `~/.modal.toml` — what the CLI is invoked with. */
  name: string;
  /** The Modal workspace it authenticates — what a provider row is matched on. */
  workspace: string;
  active: boolean;
}

export interface ModalCliStatus {
  installed: boolean;
  version: string | null;
  /** `modal` or `python -m modal`. */
  command: string | null;
  profiles: ModalProfile[];
  configPath: string | null;
  /** When the CLI was last run for this, epoch ms. `0` = never measured. */
  checkedAtMs: number;
}

export interface ModalProxyToken {
  tokenId: string;
  /** `wk-….ws-…` — what the provider row stores. */
  bearer: string;
}

/**
 * What the CLI last said. Read from Aurora's cache unless `refresh` is true,
 * because asking costs two Python process starts (0.8s and up, measured) and
 * the settings pane is a list people click through.
 */
export const modalCliStatus = (refresh = false): Promise<ModalCliStatus> =>
  invoke<ModalCliStatus>("modal_cli_status", { refresh });

/** Mint a proxy token for a workspace. Modal shows the secret exactly once. */
export const modalCreateProxyToken = (profile: string): Promise<ModalProxyToken> =>
  invoke<ModalProxyToken>("modal_cli_create_proxy_token", { profile });

/** Open the browser sign-in and resolve with the workspace it connected. */
export const modalSignIn = (): Promise<{ workspace: string }> =>
  invoke<{ workspace: string }>("modal_cli_sign_in");

/**
 * A workspace's spend for one billing month, in dollars.
 *
 * Spend, not headroom: nothing in the CLI or the docs reports a balance or
 * remaining credits (checked 2026-09-02 — `billing summary|report|rates`,
 * `workspace settings`, the budgets guide). What can be read is what this
 * month has cost so far, with the endpoints' token line separated out.
 */
export interface ModalBillingSummary {
  /** `this month`, `last month`, or `YYYY-MM`. */
  cycle: string;
  /** When the CLI reported these numbers, epoch ms. Spend keeps moving. */
  checkedAtMs: number;
  meteredCost: number;
  /** After plan, credits and free allowances. */
  billedCost: number;
  /** The endpoints' token spend — the line that is Aurora's doing. */
  llmTokensCost: number;
  /** Endpoint compute beyond tokens. */
  endpointCost: number;
  /** Volumes, functions, everything else metered. */
  otherCost: number;
  creditsApplied: number;
}

export const modalBillingSummary = (
  profile: string,
  cycle: "this month" | "last month" = "this month",
  refresh = false,
): Promise<ModalBillingSummary> =>
  invoke<ModalBillingSummary>("modal_cli_billing_summary", { profile, cycle, refresh });

/** `$0.16`, `$12.40`, `$0.00` — two decimals, the way Modal's own summary prints. */
export function fmtUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * The signed-in profile that can act on a workspace, or `null`.
 *
 * Matched on `workspace`, never on `name`: `modal token new --profile work`
 * makes a profile called `work` that authenticates `maya`, and matching names
 * would then read a different workspace's spend under this one's heading.
 * The CLI still has to be INVOKED with `name`, which is why the profile is
 * returned whole.
 */
export function profileForWorkspace(
  profiles: readonly ModalProfile[],
  workspace: string | null,
): ModalProfile | null {
  if (!workspace) return null;
  return profiles.find((p) => p.workspace === workspace) ?? null;
}

// ── The workspace switcher ───────────────────────────────────────────────────

/**
 * Which workspace a provider row belongs to.
 *
 * Its endpoints say so first, because their hostnames are the gateway's own
 * answer. A row whose token is set but whose endpoints have not been pulled
 * yet falls back to the name this card wrote when it created the row. A row
 * with neither has not been set up, and says so rather than guessing.
 */
export function providerWorkspace(
  provider: Pick<LLMProvider, "nickname">,
  models: readonly LLMModel[],
): string | null {
  for (const model of models) {
    const workspace = workspaceFromModelKey(model.modelKey);
    if (workspace) return workspace;
  }
  const named = provider.nickname?.trim();
  return named?.startsWith(WORKSPACE_NICKNAME_PREFIX)
    ? named.slice(WORKSPACE_NICKNAME_PREFIX.length).trim() || null
    : null;
}

/** How this card names a row it owns, so the workspace survives an empty list. */
export const WORKSPACE_NICKNAME_PREFIX = "Modal · ";

export const workspaceNickname = (workspace: string): string =>
  `${WORKSPACE_NICKNAME_PREFIX}${workspace}`;

/** A workspace Aurora holds a token for, as the switcher lists it. */
export interface ModalSavedWorkspace {
  workspace: string;
  region: string;
  endpointCount: number;
}

export interface ModalWorkspaceList {
  /** The workspace the Modal row is currently showing. */
  active: string | null;
  saved: ModalSavedWorkspace[];
}

/** Everything needed to put the Modal row on one workspace. */
export interface ModalWorkspaceRecord {
  workspace: string;
  token: string;
  region: string;
  models: ModelInit[];
}

export const modalWorkspaces = (): Promise<ModalWorkspaceList> =>
  invoke<ModalWorkspaceList>("modal_workspaces");

/** Switch the row to a workspace Aurora already has. Never mints anything. */
export const modalUseWorkspace = (workspace: string): Promise<ModalWorkspaceRecord> =>
  invoke<ModalWorkspaceRecord>("modal_use_workspace", { workspace });

/** Store the row as it stands, under this workspace, and make it the active one. */
export const modalSaveWorkspace = (
  workspace: string,
  token: string,
  region: string,
  models: readonly ModelInit[],
): Promise<void> =>
  invoke<void>("modal_save_workspace", { workspace, token, region, models });

export const modalForgetWorkspace = (workspace: string): Promise<void> =>
  invoke<void>("modal_forget_workspace", { workspace });

export interface ModalWorkspaceOption {
  workspace: string;
  /** Endpoints Aurora already holds for it, or `null` when it is not set up. */
  endpointCount: number | null;
  /** The CLI profile that can set it up, for a workspace with no token yet. */
  profileName: string | null;
}

/**
 * Every Modal workspace this machine can reach, in one list.
 *
 * Two sources, because there are two ways to have one: Aurora already holds
 * its token, or the CLI is signed in to it and Aurora never has been.
 * Selecting the first kind restores it — no network, no minting. Selecting the
 * second mints its token once and then it becomes the first kind forever.
 *
 * Saved workspaces win on collision, so a workspace Aurora already has is
 * never offered a second time as something to set up.
 */
export function modalWorkspaceOptions(
  saved: readonly ModalSavedWorkspace[],
  profiles: readonly ModalProfile[],
): ModalWorkspaceOption[] {
  const options: ModalWorkspaceOption[] = saved.map((entry) => ({
    workspace: entry.workspace,
    endpointCount: entry.endpointCount,
    profileName: null,
  }));
  const held = new Set(saved.map((entry) => entry.workspace));
  for (const profile of profiles) {
    if (!profile.workspace || held.has(profile.workspace)) continue;
    held.add(profile.workspace);
    options.push({
      workspace: profile.workspace,
      endpointCount: null,
      profileName: profile.name,
    });
  }
  return options.sort((a, b) => a.workspace.localeCompare(b.workspace));
}
