import { v4 as uuidv4 } from "uuid";
import { create } from "zustand";

import {
  formatModelDisplayName,
  formatProviderNickname,
} from "@/kernel/lib/llm/provider-display";
import {
  DEFAULT_EXPLORER_ICON_PACK_ID,
  isExplorerIconPackAvailable,
  setActiveExplorerIconPackId,
} from "@/kernel/lib/icons/icon-packs";
import type { ExplorerIconPackId } from "@/kernel/lib/icons/icon-types";
import { cacheUiPreferences } from "@/kernel/lib/fonts/boot";
import { resolveThinkingModelPair } from "@/kernel/lib/llm/thinking-models";
import { databaseService } from "@/kernel/services/database";
import {
  normalizeAgentExecutionMode,
  normalizeAuroraSurface,
  type AgentExecutionMode,
  type AuroraSurface,
} from "@/apps/agent/services/runtime/agent-execution-mode";
import { providerCatalogService, type ProviderCatalogPreset } from "@/apps/agent/services/providers/provider-catalog";
import { ATLAS_CLOUD_PRESET } from "@/apps/agent/services/providers/atlascloud";
import {
  normalizeImageProviders,
  withBuiltInImageProviders,
  withSeededImageProviders,
  type ImageModel,
  type ImageProvider,
} from "@/apps/agent/services/providers/image-providers";
import { CODEX_PRESET } from "@/apps/agent/services/providers/codex";
import { CURSOR_PRESET } from "@/apps/agent/services/providers/cursor";
import { OPENCODE_PRESET } from "@/apps/agent/services/providers/opencode";
import { COMMANDCODE_PRESET } from "@/apps/agent/services/providers/commandcode";
import { AGENT_ROUTER_PRESET, isAgentRouterWireChoice } from "@/apps/agent/services/providers/agentrouter";
import type { ProviderConfig } from "@/kernel/services/providers/types";
import { MAX_ENABLED_SKILLS } from "@/apps/agent/services/skills/skills";
import type {
  AppSettings as DbAppSettings,
  DbLLMProvider,
  DbProviderModel,
  GlobalInstructionProfile,
  ModelReasoning,
} from "@/kernel/types/database";
import { useIconPackStore } from "./useIconPackStore";

const countEnabledSkillToggles = (toggles: Record<string, boolean>): number => {
  let count = 0;
  for (const value of Object.values(toggles)) {
    if (value === true) count += 1;
  }
  return count;
};

// ---------------------------------------------------------------------------
// Settings persistence debounce
// ---------------------------------------------------------------------------
// Every setter calls `saveToDatabase()`, which serializes the whole settings
// state (~37 `set_setting` rows). Without coalescing, a burst of mutations
// (dragging a slider, toggling several options) fires N concurrent full-table
// writes that race each other. A single shared timer collapses a burst into
// one write. `flushSettingsSave()` forces an immediate write (used on window
// unload so the last change isn't lost inside the debounce window).
const SETTINGS_SAVE_DEBOUNCE_MS = 300;
let settingsSaveTimer: ReturnType<typeof setTimeout> | null = null;
let settingsSaveResolvers: Array<() => void> = [];

const scheduleSettingsSave = (run: () => Promise<void>): Promise<void> =>
  new Promise<void>((resolve) => {
    settingsSaveResolvers.push(resolve);
    if (settingsSaveTimer) {
      clearTimeout(settingsSaveTimer);
    }
    settingsSaveTimer = setTimeout(() => {
      settingsSaveTimer = null;
      const resolvers = settingsSaveResolvers;
      settingsSaveResolvers = [];
      void run().finally(() => {
        for (const r of resolvers) r();
      });
    }, SETTINGS_SAVE_DEBOUNCE_MS);
  });

const UI_FONT_FAMILIES: Record<string, string> = {
  system: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif",
  inter: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  segoe: "'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif",
  roboto: "'Roboto', -apple-system, BlinkMacSystemFont, sans-serif",
  manrope: "'Manrope', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  poppins: "'Poppins', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  sourceSans: "'Source Sans 3', 'Source Sans Pro', 'Segoe UI', sans-serif",
  openSans: "'Open Sans', 'Segoe UI', Roboto, sans-serif",
  nunito: "'Nunito Sans', 'Nunito', 'Segoe UI', sans-serif",
  lato: "'Lato', 'Segoe UI', Roboto, sans-serif",
  ubuntu: "'Ubuntu', 'Segoe UI', Roboto, sans-serif",
};

const clampTextScale = (value: number): number => Math.min(1.4, Math.max(0.85, value));

// Agent Team — the user-configured ceiling on how many agents the Lead may
// convene per task. Hard ceiling is 16, recommended value is 5 (see
// DOCS/aurora-agent-team-ground-truth.md §11). The Lead never exceeds this.
export const TEAM_SIZE_HARD_CEILING = 16;
export const TEAM_SIZE_RECOMMENDED = 5;
const clampTeamSize = (value: number): number =>
  Math.min(TEAM_SIZE_HARD_CEILING, Math.max(1, Math.round(value) || TEAM_SIZE_RECOMMENDED));

// Context compaction (see DOCS/compaction-design.md). Threshold is a % of the
// context window; budget is the summary call's max_output_tokens.
export const DEFAULT_COMPACTION_THRESHOLD_PCT = 80;
export const COMPACTION_THRESHOLD_MIN = 50;
export const COMPACTION_THRESHOLD_MAX = 95;
/**
 * Output budget for one summarization call.
 *
 * Covers BOTH passes the summarizer makes: the `<analysis>` scratchpad (a
 * chronological read-through that is stripped before the note enters context)
 * and the note itself. At the old 8k default the drafting pass could eat the
 * allowance and leave the note truncated mid-section — losing exactly the
 * late-numbered content that matters most, "current work" and "next step".
 * 16k gives both room; the ceiling leaves headroom for very long sessions.
 */
export const DEFAULT_COMPACTION_SUMMARY_BUDGET = 16000;
export const COMPACTION_SUMMARY_BUDGET_MIN = 4000;
export const COMPACTION_SUMMARY_BUDGET_MAX = 24000;

// Global instructions (Settings → Agent). The user keeps up to three named
// sets ("personas") and activates at most one; only the active set's text is
// injected into the agent's system prompt.
export const GLOBAL_INSTRUCTION_PROFILE_LIMIT = 3;
export const GLOBAL_INSTRUCTION_NAME_MAX = 30;
/** Id the pre-profile single string migrates onto, kept stable for tests. */
export const LEGACY_GLOBAL_INSTRUCTION_PROFILE_ID = "default";
export type { GlobalInstructionProfile };

/** Longest provider description — one line under the title, not a paragraph. */
export const PROVIDER_DESCRIPTION_MAX = 150;

/** One line, whitespace collapsed, capped — or `undefined` when there is nothing to say. */
export const normalizeProviderDescription = (value: string | null | undefined): string | undefined => {
  const line = (value ?? "").replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return Array.from(line).slice(0, PROVIDER_DESCRIPTION_MAX).join("");
};

const clampProfileName = (name: string): string =>
  name.trim().slice(0, GLOBAL_INSTRUCTION_NAME_MAX);

/**
 * The text the system prompt should carry: the active set's, or '' when no
 * set is active. The one read path — `agent-prompt.ts` and the DB's legacy
 * `globalInstructions` mirror both go through here.
 */
export const selectActiveGlobalInstructions = (state: {
  globalInstructionProfiles: GlobalInstructionProfile[];
  activeGlobalInstructionProfileId: string;
}): string =>
  state.globalInstructionProfiles.find(
    (p) => p.id === state.activeGlobalInstructionProfileId,
  )?.text ?? "";

/**
 * Turn whatever the DB holds into well-formed profile state: 1–3 entries with
 * string fields and unique ids, plus an active id that names one of them.
 * A row saved before profiles existed migrates its single string onto one
 * "Default" set — active when it had text, because that text WAS in effect.
 *
 * Exported for tests; the store's `initialize` is the only production caller.
 */
export const resolveGlobalInstructionState = (
  savedProfiles: unknown,
  savedActiveId: string,
  legacyText: string,
): { profiles: GlobalInstructionProfile[]; activeId: string } => {
  const seen = new Set<string>();
  const profiles: GlobalInstructionProfile[] = [];
  if (Array.isArray(savedProfiles)) {
    for (const entry of savedProfiles) {
      if (!entry || typeof entry !== "object") continue;
      const { id, name, text } = entry as Partial<GlobalInstructionProfile>;
      if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      profiles.push({
        id,
        name:
          typeof name === "string" && name.trim()
            ? clampProfileName(name)
            : `Persona ${profiles.length + 1}`,
        text: typeof text === "string" ? text : "",
      });
      if (profiles.length === GLOBAL_INSTRUCTION_PROFILE_LIMIT) break;
    }
  }
  if (profiles.length > 0) {
    return {
      profiles,
      activeId: profiles.some((p) => p.id === savedActiveId) ? savedActiveId : "",
    };
  }
  return {
    profiles: [
      { id: LEGACY_GLOBAL_INSTRUCTION_PROFILE_ID, name: "Default", text: legacyText },
    ],
    activeId: legacyText.trim() ? LEGACY_GLOBAL_INSTRUCTION_PROFILE_ID : "",
  };
};

/** Chat-title source: derived first message, local llama.cpp, or a cloud endpoint. */
export type TitleMakerMode = 'off' | 'local' | 'cloud';

/** How far outside the open project the agent's file tools may reach.
 *  Mirrors the Rust `WorkspaceAccess`; the strings are the wire format. */
export type WorkspaceAccess = 'workspace' | 'read' | 'full';

/** Read a stored access mode, falling back to the boolean it replaced.
 *
 *  An unrecognised string is treated as unset rather than trusted, so a
 *  corrupt or future value narrows access instead of widening it. */
export const normalizeWorkspaceAccess = (
  mode: string | undefined,
  legacyAllow: boolean | undefined,
): WorkspaceAccess => {
  if (mode === 'workspace' || mode === 'read' || mode === 'full') return mode;
  return legacyAllow ? 'read' : 'workspace';
};
const clampCompactionThreshold = (value: number): number =>
  Math.min(
    COMPACTION_THRESHOLD_MAX,
    Math.max(COMPACTION_THRESHOLD_MIN, Math.round(value) || DEFAULT_COMPACTION_THRESHOLD_PCT),
  );
const clampCompactionBudget = (value: number): number =>
  Math.min(
    COMPACTION_SUMMARY_BUDGET_MAX,
    Math.max(COMPACTION_SUMMARY_BUDGET_MIN, Math.round(value) || DEFAULT_COMPACTION_SUMMARY_BUDGET),
  );

const applyUiPreferences = (fontFamily: string, textScale: number) => {
  if (typeof document === 'undefined') return;
  const resolvedFamily = UI_FONT_FAMILIES[fontFamily] ?? UI_FONT_FAMILIES.system;
  const scale = clampTextScale(textScale);
  // UI scaling is intentionally disabled. Keep this hardcoded at 1.
  document.documentElement.style.setProperty('--aurora-ui-scale', '1');
  document.documentElement.style.setProperty('--aurora-ui-text-scale', String(scale));
  document.documentElement.style.setProperty('--aurora-ui-font-family', resolvedFamily);
  // Mirror the RESOLVED values so the next boot can apply them synchronously
  // before first paint (kernel/lib/fonts/boot.ts) — these settings arrive over
  // async SQLite, and applying them only here made the window visibly
  // re-typeset itself moments after opening.
  cacheUiPreferences(resolvedFamily, scale);
};

const normalizeSpeechRuntimePath = (value?: string | null): string => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "__bundled__" ? "" : trimmed;
};

/**
 * How many models Aurora Chat's picker may offer.
 *
 * Ten is the number Alvan set. The point of a cap is that choosing is
 * deliberate — a list you scroll is the thing this replaces — so it is enforced
 * on the way in rather than trimmed on the way out, and the control that would
 * exceed it goes disabled and says why.
 */
export const CHAT_SHORTLIST_MAX = 10;

/**
 * The stored shortlist, made safe to render.
 *
 * It comes back from SQLite, so it may be anything: a shape from an older
 * build, a hand-edited row, or a list that grew past the cap when the cap was
 * different. Duplicates are dropped and the cap is applied, because the two
 * things that go wrong downstream are a picker with the same model twice and a
 * picker with fifteen entries.
 */
const normalizeChatShortlist = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const key = entry.trim();
    // A selection is `providerId:modelKey`; anything without the separator
    // cannot resolve and would render as a row that does nothing.
    if (!key.includes(":")) continue;
    seen.add(key);
    if (seen.size >= CHAT_SHORTLIST_MAX) break;
  }
  return [...seen];
};

// ============================================
// SETTINGS STATE TYPES
// ============================================
interface SettingsState {
  addCustomProvider: (provider: Omit<LLMProvider, "id" | "isCustom">) => string;

  // File Changes Approval
  autoAcceptChanges: boolean;

  // Tool Approval
  autoApproveTools: boolean;
  agentExecutionMode: AgentExecutionMode;

  /**
   * Which of Aurora's two products the window is showing.
   *
   * Held SEPARATELY from `agentExecutionMode`, which keeps meaning
   * agent/plan/team — the mode you were working in on the Build side. Two
   * reasons, both learned by trying the single-field version first:
   *
   * 1. Switching to Chat and back must return you to the mode you left. One
   *    field would forget it, and every trip through Chat would drop a Plan-mode
   *    conversation back to Agent.
   * 2. The composer's Agent↔Plan cycle writes `agentExecutionMode`. With one
   *    field, pressing that shortcut while in Chat would silently move the
   *    window to another product with another tool roster and another store.
   *
   * The mode the RUNTIME is told is the combination — see
   * `effectiveExecutionMode`.
   */
  auroraSurface: AuroraSurface;

  /**
   * Start the NEXT Aurora Chat conversation in deep research.
   *
   * A seed, not the state — exactly like `selectedModel`. Deep research is
   * fixed on the conversation at creation and can never be changed after, so
   * this only decides what a new chat is born with. An open conversation reads
   * its own flag, and the composer shows that rather than this.
   */
  deepResearchNext: boolean;

  /**
   * The models offered in Aurora Chat's picker, as `"providerId:modelKey"`.
   *
   * Its OWN list rather than a reuse of `provider_models.enabled`, which was
   * the first proposal and is wrong: curating a short pool to chat with would
   * then remove those models from Build, where the roster is long on purpose.
   *
   * Ticking a model makes it AVAILABLE, not selected — you still choose one per
   * conversation. Capped at {@link CHAT_SHORTLIST_MAX}: a picker you scroll is
   * the thing this exists to avoid, and a cap you can feel is what makes the
   * choice deliberate.
   *
   * Empty means "no shortlist yet", and the picker then offers everything —
   * a fresh install must not open onto a chat with no models in it.
   */
  chatModelShortlist: string[];

  /**
   * Image providers, configured by the user. Aurora Chat only.
   *
   * Separate from `providers` because they are a different kind of thing: an
   * image provider has a generation path, an edit path, a response shape and
   * a wire format of its own, and no context window, temperature or reasoning
   * profile. Mixing them into one list would give every LLM row a set of
   * fields that mean nothing to it.
   *
   * See `services/providers/image-providers.ts` for the shape and for why the
   * wire format has to be per provider.
   */
  imageProviders: ImageProvider[];
  /**
   * Ids of the image providers Aurora has already offered as a starting point.
   *
   * Offered once, then remembered — so deleting a seeded row keeps it deleted.
   * A preset that re-seeds on every launch cannot be thrown away, which is the
   * behaviour the built-in a6api row wants and these rows do not.
   */
  seededImageProviderIds: string[];

  // Agent Team (see DOCS/aurora-agent-team-ground-truth.md)
  teamEnabled: boolean;
  maxTeamSize: number;
  /**
   * Provider/model the Lead runs on, as a `"providerId:modelKey"` selection
   * from the user's configured providers. Empty string means "use my active
   * chat model".
   */
  teamLeadModel: string;
  /**
   * Provider/model the IC team members run on, same `"providerId:modelKey"`
   * shape. Empty string falls back to the active chat model. Lets the user
   * pin the Lead to one provider and the team to another.
   */
  teamMemberModel: string;
  /**
   * Named global-instruction sets (Settings → Agent), up to
   * {@link GLOBAL_INSTRUCTION_PROFILE_LIMIT}. At most one is active; only the
   * active one's text reaches the agent's system prompt
   * (`selectActiveGlobalInstructions`). Always holds at least one entry so
   * the editor has a tab to show.
   */
  globalInstructionProfiles: GlobalInstructionProfile[];
  /** Id of the active set. Empty string = none is sent. */
  activeGlobalInstructionProfileId: string;
  /** Create a new set. Returns its id, or null when the cap is reached. */
  addGlobalInstructionProfile: () => string | null;
  renameGlobalInstructionProfile: (id: string, name: string) => void;
  setGlobalInstructionProfileText: (id: string, text: string) => void;
  /** Activate one set (exclusive), or pass null to deactivate all. */
  setActiveGlobalInstructionProfile: (id: string | null) => void;
  /** Delete a set. The last remaining set cannot be deleted. */
  removeGlobalInstructionProfile: (id: string) => void;

  // Context Compaction (see DOCS/compaction-design.md)
  /** Trigger as a % of the context window (50–95). The runtime summarizes
   *  older history into a persistent marker once the projected request
   *  crosses this. */
  compactionThresholdPct: number;
  setCompactionThresholdPct: (value: number) => void;
  /** `max_output_tokens` budget for the summarization call (2,000–16,000). */
  compactionSummaryBudget: number;
  setCompactionSummaryBudget: (value: number) => void;
  /**
   * Provider/model the summarization call runs on, as a `"providerId:modelKey"`
   * selection. Empty string summarizes on the conversation's own model.
   *
   * Worth its own setting because summarizing is not the work — it is a
   * mechanical read of history that a cheap, long-window model does as well as
   * an expensive reasoning one, and it is routinely the single largest request
   * a long chat makes. Isolating it also means compaction no longer inherits
   * the chat model's context window, so a chat that outgrew a small model can
   * still be compacted.
   */
  compactionModel: string;
  setCompactionModel: (selection: string) => void;
  /**
   * Provider config for the summarization call: the pinned
   * {@link compactionModel} when set and still resolvable, otherwise `null`
   * meaning "summarize on the conversation's own model".
   */
  getCompactionConfig: () => ProviderConfig | null;

  // AI Title Maker — generate a short chat title from the first message.
  // `titleMakerMode` picks the source: "off" keeps the derived title, "local"
  // uses the prompt-refine llama.cpp model, "cloud" calls the endpoint below.
  // `titleMakerEnabled` is the legacy flag kept in lockstep for old readers.
  titleMakerEnabled: boolean;
  titleMakerMode: TitleMakerMode;
  titleMakerBaseUrl: string;
  titleMakerApiKey: string;
  titleMakerModel: string;
  setTitleMaker: (
    value: Partial<{
      enabled: boolean;
      mode: TitleMakerMode;
      baseUrl: string;
      apiKey: string;
      model: string;
    }>,
  ) => void;

  /** How far outside the open project the agent's file tools may reach.
   *
   *  - `workspace` — the project and nothing else (default).
   *  - `read` — reads may leave; searches and writes stay inside.
   *  - `full` — no path boundary; reads, searches and writes go anywhere.
   *
   *  Governs the file tools only. `shell_execute` accepts an absolute `cwd` in
   *  every mode; its guard is command validation plus the approval prompt. */
  workspaceAccess: WorkspaceAccess;
  setWorkspaceAccess: (value: WorkspaceAccess) => void;
  /** The boolean this setting used to be, kept only so an install that
   *  upgrades without opening Settings keeps the access it already had. Derived
   *  from `workspaceAccess` on every write; nothing should read it. */
  allowOutsideWorkspace: boolean;
  /** Surface a header flash + rail "done" dot when a chat's turn finishes
   *  streaming (agent window). Off silences both cues. On by default. */
  notifyOnTurnComplete: boolean;
  setNotifyOnTurnComplete: (value: boolean) => void;
  /** While a turn streams, replace the agent-window header title with a live,
   *  plain-language activity line (e.g. "Editing LeftRail.tsx"). The real chat
   *  title returns the moment streaming ends. On by default. */
  showActivityInTitle: boolean;
  setShowActivityInTitle: (value: boolean) => void;
  /**
   * Let the agent split a long turn into named chapters, rendered as headings in
   * the transcript. This is NOT a display setting: it adds a short instruction
   * to the system prompt and hands the agent a `chapter` tool, so it only
   * affects turns started after it is switched on. Off by default.
   */
  transcriptChapters: boolean;
  setTranscriptChapters: (value: boolean) => void;
  /**
   * Whether the browser toolset is advertised to the model.
   *
   * Sixteen schemas, roughly 2,800 tokens, sent on EVERY request — and Aurora
   * attaches `cache_control` for Anthropic only, so on any other provider that
   * is paid in full on turns that never open a page. Switching it off
   * unregisters the whole bucket: the model is not told the browser exists.
   *
   * Defaults ON. Removing a capability someone is mid-task with, to save
   * tokens they did not ask to save, is the wrong default.
   */
  browserTools: boolean;
  setBrowserTools: (value: boolean) => void;
  /**
   * Load the optional tool buckets on demand instead of advertising them.
   *
   * When on, `mcp_*`, `browser_*` and `team_*` are held out of the roster and
   * the model reaches them through `tool_search`, which lists their NAMES. The
   * saving is per request, not per turn: those schemas ride in every single
   * request of every turn, and only Anthropic receives a `cache_control` marker
   * from Aurora.
   *
   * Defaults OFF. It changes how the model must REACH a tool, so it is the
   * user's call rather than something switched on underneath them.
   */
  deferTools: boolean;
  setDeferTools: (value: boolean) => void;
  /**
   * Whether other agents may send work to this Aurora over MCP.
   *
   * `aurora mcp` is a Model Context Protocol server another agent connects to.
   * Its tools are always listed, but every one that DOES anything checks this
   * switch and the Agent Window being open before it acts — see
   * `cli_delegate::bridge` on the Rust side.
   *
   * Defaults OFF and is never turned on by anything but the user. It lets
   * software outside Aurora start turns that edit files on this machine, which
   * is not a default anybody should arrive at by accident.
   */
  mcpBridgeEnabled: boolean;
  setMcpBridgeEnabled: (value: boolean) => void;
  /**
   * Resolve the {@link ProviderConfig} the Lead should run on — the
   * `teamLeadModel` override when set and valid, otherwise the active chat
   * config (`getLLMConfig`).
   */
  getTeamLeadConfig: () => ProviderConfig | null;
  /** Resolve the {@link ProviderConfig} the IC team members run on. */
  getTeamMemberConfig: () => ProviderConfig | null;

  // Autosave Settings
  autoSave: 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange';
  autoSaveDelay: number; // in milliseconds
  deleteProvider: (id: string) => void;
  /**
   * Remove a provider from the Providers page PERMANENTLY. Custom providers
   * are deleted outright (delegates to {@link deleteProvider}); built-in
   * presets can't be deleted (they re-seed each launch), so their id is
   * recorded in {@link removedProviderIds} and filtered out of the seeded
   * list — that record is the only reason "gone" survives a restart. There is
   * no restore: removal is final.
   */
  removeProvider: (id: string) => void;
  /**
   * Forget a skill's toggle in EVERY workspace.
   *
   * Called when a skill is deleted from disk. Toggles are bucketed per project,
   * and a global skill can be equipped in several of them, so clearing only the
   * open project would leave `true` entries pointing at a skill that no longer
   * exists — each one still counting against that project's loadout cap with no
   * card left to unequip.
   */
  removeSkillToggle: (storageKey: string) => void;
  /**
   * Preset provider ids the user removed. Internal bookkeeping only (no UI) —
   * it stops a removed built-in from silently re-seeding on the next launch.
   */
  removedProviderIds: string[];
  /**
   * Model ids (`providerId::modelKey`) the user deleted from a built-in
   * provider. Same job as {@link removedProviderIds}, one level down: preset
   * rosters re-add any missing model key on launch, and this record is what
   * makes the delete survive the restart. Re-adding the model by hand clears
   * its entry.
   */
  removedPresetModelIds: string[];

  // Editor Settings
  explorerIconPack: ExplorerIconPackId;
  fontSize: number;
  fireworksAccountId: string;
  fireworksTabEnabled: boolean;
  getAvailableModels: () => Array<{
    providerId: string;
    providerName: string;
    model: string;
    label: string;
  }>;
  getLLMConfig: () => ProviderConfig | null;
  /**
   * `getLLMConfig` for an EXPLICIT `"providerId:modelKey"` selection rather
   * than the globally-selected one — how a conversation rides the model it is
   * pinned to instead of whichever model was picked last, anywhere.
   *
   * Falls back to {@link getLLMConfig} for a null/empty selection, or one whose
   * provider no longer exists (deleted provider, edited config): a conversation
   * pinned to a model that is gone must still be sendable.
   */
  getLLMConfigFor: (selection: string | null | undefined) => ProviderConfig | null;
  getSelectedProvider: () => LLMProvider | undefined;
  getToolApproval: (toolName: string) => 'auto' | 'always_ask' | 'deny';

  // Onboarding
  hasSeenOnboarding: boolean;

  // Database operations
  initializeFromDatabase: () => Promise<void>;

  // Initialization state
  isInitialized: boolean;
  isLoading: boolean;

  // Max Tokens
  maxTokens: number;

  // Tool Settings
  maxToolCallsPerRequest: number;
  projectLayoutEnabled: boolean; // Include file tree in first message
  /**
   * Per-workspace skill enablement: `scopeKey -> (storageKey -> boolean)`.
   * `scopeKey` is the normalized workspace root (or `__global__`), so each
   * project's selection — and the {@link MAX_ENABLED_SKILLS} cap — is scoped
   * to that project. See `getSkillToggleScopeKey` in services/skills.
   */
  skillToggles: Record<string, Record<string, boolean>>;
  skillsEnabled: boolean;
  speechBackend: string;
  speechDevicePreference: 'auto' | 'cpu' | 'gpu';
  speechEnabled: boolean;
  speechEngine: string;
  speechLanguage: string;
  speechModelPath: string;
  speechRuntimePath: string;
  speechThreads: number;

  // Providers
  providers: LLMProvider[];
  /** Debounced persist — coalesces bursts of setter calls into one write. */
  saveToDatabase: () => Promise<void>;
  /** Persist immediately, bypassing the debounce (used by the unload flush). */
  saveToDatabaseImmediate: () => Promise<void>;
  selectedModel: string; // Format: "providerId:model"
  setAutoAcceptChanges: (value: boolean) => void;
  setAutoApproveTools: (value: boolean) => void;
  setAgentExecutionMode: (mode: AgentExecutionMode) => void;
  setAuroraSurface: (surface: AuroraSurface) => void;
  setDeepResearchNext: (enabled: boolean) => void;
  /** Add or remove a model from Aurora Chat's picker. Ignored at the cap. */
  toggleChatShortlistModel: (selection: string) => void;

  /** Add an image provider. Returns its new id. */
  addImageProvider: (provider: Omit<ImageProvider, "id" | "models">) => string;
  /** Change one image provider's fields. */
  updateImageProvider: (id: string, patch: Partial<Omit<ImageProvider, "id">>) => void;
  /** Remove an image provider and every model under it. */
  deleteImageProvider: (id: string) => void;
  /** Add a model to an image provider. Returns its new id. */
  addImageModel: (providerId: string, model: Omit<ImageModel, "id" | "providerId">) => string;
  /** Change one image model's fields. */
  updateImageModel: (id: string, patch: Partial<Omit<ImageModel, "id" | "providerId">>) => void;
  deleteImageModel: (id: string) => void;
  setAutoSave: (mode: 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange') => void;
  setAutoSaveDelay: (delay: number) => void;
  setExplorerIconPack: (packId: ExplorerIconPackId) => void;
  setFontSize: (size: number) => void;
  setFireworksAccountId: (accountId: string) => void;
  setFireworksTabEnabled: (enabled: boolean) => void;
  setHasSeenOnboarding: (seen: boolean) => void;
  setMaxTokens: (tokens: number) => void;
  setMaxToolCallsPerRequest: (max: number) => void;
  setTeamEnabled: (enabled: boolean) => void;
  setMaxTeamSize: (size: number) => void;
  setTeamLeadModel: (selection: string) => void;
  setTeamMemberModel: (selection: string) => void;
  setProjectLayoutEnabled: (value: boolean) => void;
  setSelectedModel: (model: string) => void;
  /**
   * Toggle a skill on or off **within a workspace scope**. Enabling is
   * rejected (no-op + console warning) when {@link MAX_ENABLED_SKILLS} skills
   * are already enabled *in that scope* — callers must disable a skill before
   * enabling another. Disabling is always permitted. Returns true if the
   * toggle was applied, false if it was rejected. `scopeKey` comes from
   * `getSkillToggleScopeKey(workspaceRoot)`.
   */
  setSkillEnabled: (scopeKey: string, storageKey: string, enabled: boolean) => boolean;
  setSkillsEnabled: (enabled: boolean) => void;
  setSpeechBackend: (backend: string) => void;
  setSpeechDevicePreference: (preference: 'auto' | 'cpu' | 'gpu') => void;
  setSpeechEnabled: (enabled: boolean) => void;
  setSpeechEngine: (engine: string) => void;
  setSpeechLanguage: (language: string) => void;
  setSpeechModelPath: (path: string) => void;
  setSpeechRuntimePath: (path: string) => void;
  setSpeechThreads: (threads: number) => void;
  setSyntaxValidationEnabled: (value: boolean) => void;
  setTemperature: (temp: number) => void;
  setTheme: (theme: "dark" | "light") => void;
  setThinkingEnabled: (enabled: boolean) => void;
  setToolApproval: (toolName: string, setting: 'auto' | 'always_ask' | 'deny') => void;
  setUiFontFamily: (family: string) => void;
  setUiTextScale: (scale: number) => void;
  setWrapMode: (enabled: boolean) => void;

  // Agent Guardrails
  syntaxValidationEnabled: boolean; // Pre-save syntax validation

  // Temperature
  temperature: number;

  // Theme
  theme: "dark" | "light";

  // Thinking Settings
  thinkingEnabled: boolean;
  toolApprovalSettings: Record<string, 'auto' | 'always_ask' | 'deny'>;

  // UI Settings
  uiFontFamily: string;
  uiTextScale: number;

  // Provider actions
  updateProvider: (id: string, updates: Partial<LLMProvider>) => void;

  // ── Models slice (v15+) ─────────────────────────────────────────
  models: LLMModel[];
  modelsForProvider: (providerId: string) => LLMModel[];
  /** Look up the active model from `selectedModel` (`providerId:modelKey`). */
  getActiveModel: () => LLMModel | undefined;
  /**
   * {@link getActiveModel} for an explicit selection. The model row carries the
   * reasoning config, so a conversation pinned to a model must read ITS row —
   * reading the active one would apply another chat's reasoning tier.
   */
  getModelFor: (selection: string | null | undefined) => LLMModel | undefined;
  /** Active model with overrides resolved against the provider's defaults. */
  getResolvedActiveModel: () => ResolvedLLMModel | undefined;
  addModel: (
    providerId: string,
    init: Omit<LLMModel, "id" | "providerId" | "sortOrder"> & { sortOrder?: number },
  ) => string;
  updateModel: (id: string, updates: Partial<Omit<LLMModel, "id" | "providerId">>) => void;
  deleteModel: (id: string) => void;
  /** Bulk replace the model list for a provider in one transaction. */
  /**
   * Swap a provider's whole model list for a freshly fetched one.
   *
   * `renamedKeys` maps an old model key to the key that replaced it, for
   * providers whose ids can move without the model changing (a Modal endpoint
   * carries its gateway region in its hostname). The active selection follows
   * the rename instead of being orphaned. Whatever is left dangling afterwards
   * is reconciled, so this call can never leave `selectedModel` naming a model
   * that no longer exists.
   */
  replaceModelsForProvider: (
    providerId: string,
    models: Array<Omit<LLMModel, "id" | "providerId" | "sortOrder">>,
    renamedKeys?: Record<string, string>,
  ) => void;

  wrapMode: boolean;
}


// ============================================
// PROVIDER TYPES
// ============================================
//
// As of schema v15 a provider holds **transport, auth, defaults
// only**. Per-model capabilities and per-model context/output
// overrides live on `LLMModel` rows in the `models` slice.
//
// The `customModels`, `modelAliases`, `supportsThinking`, and
// `supportsVision` fields below are **synthesized in-memory** from
// the models slice on every read so legacy UI (Fireworks tab,
// LocalProviderPanel, the old ProviderCard) keeps reading the
// shape it expects without changes. Writes through `updateProvider`
// translate them back into models-slice operations. The fields are
// never round-tripped to the `llm_providers` table.
export interface LLMProvider {
  apiKey: string;
  /**
   * API-key POOL (v20+). When more than one non-blank key is present the
   * Rust runtime rotates them round-robin per turn and fails over to the
   * next key on an auth / rate-limit / server error — same request, next
   * key. Empty/undefined → only `apiKey` is used. Generic across providers
   * (AgentRouter, with its 5+ accounts, is the first consumer).
   */
  apiKeys?: string[];
  baseUrl: string;
  contextWindow: number;

  // Advanced configuration
  customHeaders?: Record<string, string>; // Extra headers to send
  /** @deprecated v15 — synthesized from `models` slice. Reads work; writes via `updateProvider` are translated into model upserts. */
  customModels?: string[];
  customParams?: Record<string, unknown>; // Extra params in request body
  defaultMaxTokens?: number; // Provider-specific default max token request
  defaultTemperature?: number; // Provider-specific default temperature
  enabled: boolean;
  id: string;
  isCustom?: boolean; // User-added provider
  maxOutputTokens: number;
  model: string;
  /** @deprecated v15 — synthesized from `models` slice (model.label). */
  modelAliases?: Record<string, string>;
  name: string;
  nickname?: string;
  /**
   * A line the user wrote about this provider — the account, what it is for,
   * whatever the name does not say. Shown under the title on its card.
   * At most `PROVIDER_DESCRIPTION_MAX` characters; empty is "none".
   */
  description?: string;
  // `kenari` / `kenari-messages` / `kenari-responses` are ONE provider whose
  // wire format is switchable — kenari serves the same account over OpenAI
  // chat completions, the Anthropic Messages shape, and the Codex Responses
  // shape. The choice rides here rather than in a separate field so everything
  // downstream (URL builder, streaming client, reasoning replay) follows from
  // one value that cannot disagree with itself.
  // `modal` / `modal-messages` / `modal-responses` follow the same rule: one
  // workspace token, three wires on one gateway, the wire stored as the type.
  providerType?: "openai" | "openai-responses" | "codex" | "cursor" | "fireworks" | "deepseek" | "glm" | "anthropic" | "minimax" | "lmstudio" | "ollama" | "kenari" | "kenari-messages" | "kenari-responses" | "modal" | "modal-messages" | "modal-responses" | "opencode-go" | "opencode-go-chat" | "opencode-go-messages" | "custom"; // Explicit provider type
  requiresApiKey?: boolean; // Whether API key is required (false for local)
  /** @deprecated v15 — read the active `LLMModel.supportsThinking` instead. */
  supportsThinking: boolean;
  supportsToolStream?: boolean;
  /**
   * @deprecated v15 — read the active `LLMModel.supportsVision` instead.
   * Synthesized from the `models` slice.
   */
  supportsVision?: boolean;
}

// ============================================
// MODEL TYPES (v15+)
// ============================================
//
// One row per model exposed by a provider. Capabilities are always
// per-model (the same OpenAI key can address GPT-4o-mini and GPT-4o,
// which have different vision support). `contextWindow` and
// `maxOutputTokens` are nullable — `null` means "inherit from the
// provider's default". Use `getResolvedModel()` to merge.
export interface LLMModel {
  /** `${providerId}::${modelKey}` — primary key. */
  id: string;
  providerId: string;
  modelKey: string;
  label?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision: boolean;
  supportsThinking: boolean;
  supportsToolStream: boolean;
  enabled: boolean;
  sortOrder: number;
  /**
   * Pricing (USD per 1M tokens). All four fields are optional; the
   * usage badge only displays cost when both `cacheMiss` and `output`
   * are set. `cacheHit` falls back to `cacheMiss` if unset (no discount
   * assumed). `currency` defaults to `"USD"` when missing.
   */
  priceCacheHitPerMtok?: number;
  priceCacheMissPerMtok?: number;
  priceOutputPerMtok?: number;
  /**
   * USD per 1M cache-CREATION tokens. Unset means "bill cache writes at
   * `priceCacheMissPerMtok`", which is what OpenAI-compatible gateways
   * charge. Set it for providers that price cache creation differently
   * (Anthropic native charges 1.25x base). Never treated as zero — cache
   * writes are real spend and used to be dropped from the total entirely.
   */
  priceCacheWritePerMtok?: number;
  priceCurrency?: string;
  /** Reasoning capability + chosen default (models.dev, v17+). */
  reasoning?: ModelReasoning;
  /**
   * Extra request-body fields the user added manually for this model (e.g.
   * `{ thinking: { type: "enabled" } }`). Merged verbatim into the outgoing
   * request body at send time — the manual escape hatch for provider-specific
   * fields we don't model structurally. (v18+)
   */
  extraBody?: Record<string, unknown>;
  /**
   * Sampling temperature for this model. `undefined` inherits — the provider's
   * `defaultTemperature`, then {@link DEFAULT_TEMPERATURE}.
   *
   * Per-model because that is what it is: one key can address a model that
   * wants 0.2 and another that rejects the parameter outright. Models that
   * reject sampling (Claude 5+) have it stripped in the Rust adapter whatever
   * is set here, so a stale value is inert rather than a 400. (v22+)
   */
  temperature?: number;
  /**
   * Wire format for this one model. `undefined` inherits the provider's own
   * type, which is right for every provider whose format is a property of the
   * account rather than of the model. (v24+)
   *
   * OpenCode Go is why this exists. One base URL and one key answer
   * `/chat/completions`, `/messages` and `/responses`, and each model accepts
   * only its own — GLM-5.2 returns 500 on anything but chat completions,
   * GPT 5.6 Luna returns 500 on anything but responses, and the Qwen and
   * MiniMax ids want messages. It is also editable rather than fixed, because
   * the plan gains models faster than any table can be updated and the wire a
   * new one wants is not published anywhere.
   */
  providerType?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** A model with its per-row overrides resolved against provider defaults. */
export interface ResolvedLLMModel extends LLMModel {
  /** Always non-null after resolution (falls back to provider.contextWindow). */
  resolvedContextWindow: number;
  /** Always non-null after resolution (falls back to provider.maxOutputTokens). */
  resolvedMaxOutputTokens: number;
  /** Always non-null after resolution (falls back to model.modelKey). */
  displayLabel: string;
}

// ============================================
// DEFAULT VALUES
// ============================================
const DEFAULT_SELECTED_MODEL = "fireworks:accounts/fireworks/routers/kimi-k2p6-turbo";

const presetToProvider = (preset: ProviderCatalogPreset): LLMProvider => ({
  id: preset.id,
  name: preset.name,
  nickname: preset.nickname,
  baseUrl: preset.baseUrl,
  model: preset.model,
  contextWindow: preset.contextWindow,
  maxOutputTokens: preset.maxOutputTokens,
  supportsThinking: preset.supportsThinking,
  supportsToolStream: preset.supportsToolStream,
  customModels: preset.customModels,
  modelAliases: preset.modelAliases,
  providerType: preset.providerType as LLMProvider["providerType"],
  defaultTemperature: preset.defaultTemperature,
  defaultMaxTokens: preset.defaultMaxTokens,
  requiresApiKey: preset.requiresApiKey,
  // Frontend presets (AgentRouter, …) can ship required transport headers
  // pre-filled — e.g. AgentRouter's client fingerprint (`User-Agent` +
  // `X-Title`), without which it returns 401. Rust catalog presets omit it.
  customHeaders: preset.customHeaders,
  apiKey: "",
  enabled: true,
  isCustom: false,
});

/**
 * Which provider type survives a merge with the catalogue.
 *
 * The catalogue normally wins, and should: a stored type can be stale or was
 * never written at all, and repairing it on load is what keeps an upgraded
 * install pointed at the right wire.
 *
 * The exception is a provider whose wire FORMAT is the user's choice. kenari
 * answers the same account over three of them (`kenari`, `kenari-messages`,
 * `kenari-responses`), and blindly restoring the catalogue's value would undo
 * that setting on every launch — the setting would appear to save, work for the
 * session, and be gone the next morning, which is the worst way for a control
 * to fail. A stored type that is a variant of the preset's own is therefore
 * kept.
 *
 * AgentRouter is the second such provider: its two wires are the plain
 * `openai` / `anthropic` types (no variant prefix to detect), so its stored
 * choice is preserved by name at the call site — see
 * {@link isAgentRouterWireChoice}.
 */
export function resolveProviderType(
  presetType: LLMProvider["providerType"],
  storedType: LLMProvider["providerType"],
): LLMProvider["providerType"] {
  if (!storedType || !presetType) return presetType;
  return storedType.startsWith(`${presetType}-`) ? storedType : presetType;
}

const createDefaultProviders = (presets: ProviderCatalogPreset[]): LLMProvider[] => {
  return presets.map((preset) => presetToProvider(preset));
};

const getProviderModelList = (provider: LLMProvider): string[] => {
  const models = provider.customModels?.length ? provider.customModels : [provider.model];
  return Array.from(new Set(models.filter(Boolean)));
};

const getProviderNickname = (provider: Pick<LLMProvider, "name" | "nickname">): string =>
  formatProviderNickname(provider.name, provider.nickname);

const isProviderReady = (provider: LLMProvider): boolean => {
  if (!provider.enabled) return false;

  const normalizedBaseUrl = provider.baseUrl.toLowerCase();
  const isLocal =
    normalizedBaseUrl.includes("localhost") ||
    normalizedBaseUrl.includes("127.0.0.1");

  return isLocal || provider.requiresApiKey === false || provider.apiKey.trim().length > 0;
};

const buildAvailableModelOptions = (providers: LLMProvider[]) => {
  const models: Array<{
    providerId: string;
    providerName: string;
    model: string;
    label: string;
  }> = [];

  for (const provider of providers) {
    if (!isProviderReady(provider)) continue;

    const providerName = getProviderNickname(provider);
    const modelAliases = provider.modelAliases || {};

    for (const model of getProviderModelList(provider)) {
      models.push({
        providerId: provider.id,
        providerName,
        model,
        label: formatModelDisplayName(model, modelAliases[model]),
      });
    }
  }

  return models;
};

const resolveSelectedModel = (
  preferredModel: string,
  providers: LLMProvider[],
): string => {
  const availableModels = buildAvailableModelOptions(providers);

  if (
    availableModels.some(
      ({ providerId, model }) => `${providerId}:${model}` === preferredModel,
    )
  ) {
    return preferredModel;
  }

  const firstAvailable = availableModels[0];
  if (!firstAvailable) return preferredModel;

  return `${firstAvailable.providerId}:${firstAvailable.model}`;
};

/**
 * Reconcile `thinkingEnabled` with whatever model the user just
 * selected. Two distinct behaviors:
 *
 *  1. Capability gate — if the active model can't think at all, force
 *     the toggle OFF so the UI reflects what the runtime will do.
 *     Previously the function returned the *unchanged* value here,
 *     leaving the toggle stuck "on" after the user switched from a
 *     thinking-capable model (e.g. claude-sonnet-thinking) to a plain
 *     model (e.g. gpt-4o).
 *
 *  2. Pair swap — for providers that ship paired thinking/non-thinking
 *     variants of the same model family, set the flag to match the
 *     selected variant so the toggle UI looks right (the click that
 *     selected the variant is what flips the flag — not the user
 *     toggling thinking).
 *
 * `models` is the LLMModel slice — when non-empty it's the authoritative
 * capability source. We fall back to the synthesized provider flag when
 * the slice hasn't loaded yet (initial-load path).
 */
const syncThinkingForSelectedModel = (
  selectedModel: string,
  providers: LLMProvider[],
  models: LLMModel[],
  currentThinkingEnabled: boolean
): boolean => {
  const [providerId, modelKey] = selectedModel.split(":");
  if (!providerId || !modelKey) return currentThinkingEnabled;

  const provider = providers.find((p) => p.id === providerId);
  if (!provider) return currentThinkingEnabled;

  // Capability gate. Prefer the LLMModel row when available — it's
  // the per-model truth; the provider-level flag is just a synthesized
  // OR/active mirror that may lag the slice for non-active models.
  const activeModel = models.find(
    (m) => m.providerId === providerId && m.modelKey === modelKey,
  );
  const modelSupportsThinking = activeModel
    ? activeModel.supportsThinking
    : provider.supportsThinking ?? false;

  if (!modelSupportsThinking) {
    return false;
  }

  // Pair swap.
  const pair = resolveThinkingModelPair(modelKey, getProviderModelList(provider));
  if (!pair) return currentThinkingEnabled;

  return pair.currentModelIsThinking;
};

function dbToProvider(db: DbLLMProvider): LLMProvider {
  // Note: legacy fields (customModels, modelAliases, supportsThinking,
  // supportsVision) are populated post-hoc by `synthesizeLegacyProviderFields`
  // after the models slice is loaded. We intentionally leave them
  // unset here so a provider that loses all its models reflects an
  // empty list rather than ghost data.
  return {
    id: db.id,
    name: db.name,
    baseUrl: db.baseUrl,
    apiKey: db.apiKey,
    apiKeys: db.apiKeys && db.apiKeys.length > 0 ? db.apiKeys : undefined,
    model: db.model,
    contextWindow: db.contextWindow,
    maxOutputTokens: db.maxOutputTokens,
    supportsThinking: false,
    supportsToolStream: db.supportsToolStream,
    supportsVision: false,
    enabled: db.enabled,
    isCustom: db.isCustom,
    customHeaders: db.customHeaders || undefined,
    customParams: db.customParams || undefined,
    nickname: db.nickname || undefined,
    description: normalizeProviderDescription(db.description),
    providerType: db.providerType as LLMProvider['providerType'],
    defaultTemperature: db.defaultTemperature || undefined,
    defaultMaxTokens: db.defaultMaxTokens || undefined,
    requiresApiKey: db.requiresApiKey,
  };
}

// ============================================
// HELPER: Convert between store and DB formats
// ============================================
function providerToDb(provider: LLMProvider, sortOrder: number): DbLLMProvider {
  const now = new Date().toISOString();
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    apiKeys:
      provider.apiKeys && provider.apiKeys.some((k) => k.trim().length > 0)
        ? provider.apiKeys.filter((k) => k.trim().length > 0)
        : null,
    model: provider.model,
    contextWindow: provider.contextWindow,
    maxOutputTokens: provider.maxOutputTokens,
    supportsToolStream: provider.supportsToolStream || false,
    enabled: provider.enabled,
    isCustom: provider.isCustom || false,
    customHeaders: provider.customHeaders || null,
    customParams: provider.customParams || null,
    nickname: provider.nickname?.trim() || null,
    description: normalizeProviderDescription(provider.description) ?? null,
    providerType: provider.providerType || null,
    defaultTemperature: provider.defaultTemperature || null,
    defaultMaxTokens: provider.defaultMaxTokens || null,
    requiresApiKey: provider.requiresApiKey ?? true,
    sortOrder,
    createdAt: now,
    updatedAt: now,
  };
}

// ============================================
// MODEL <-> DB CONVERTERS (v15+)
// ============================================
/**
 * Master on/off state for a model's reasoning. `enabled` is the source of truth
 * once set from the composer; when undefined we fall back to: ON for
 * effort/budget models, and the legacy `default` boolean for toggle models.
 */
export function reasoningIsOn(r: ModelReasoning): boolean {
  // Natively-reasoning models can't be turned off — always on.
  if (r.toggleable === false) return true;
  if (typeof r.enabled === "boolean") return r.enabled;
  if (r.type === "toggle") return r.default !== false;
  return true;
}

function dbToModel(row: DbProviderModel): LLMModel {
  return {
    id: row.id,
    providerId: row.providerId,
    modelKey: row.modelKey,
    label: row.label || undefined,
    contextWindow: row.contextWindow ?? undefined,
    maxOutputTokens: row.maxOutputTokens ?? undefined,
    supportsVision: !!row.supportsVision,
    supportsThinking: !!row.supportsThinking,
    supportsToolStream: !!row.supportsToolStream,
    enabled: !!row.enabled,
    sortOrder: row.sortOrder ?? 0,
    priceCacheHitPerMtok: row.priceCacheHitPerMtok ?? undefined,
    priceCacheMissPerMtok: row.priceCacheMissPerMtok ?? undefined,
    priceOutputPerMtok: row.priceOutputPerMtok ?? undefined,
    priceCacheWritePerMtok: row.priceCacheWritePerMtok ?? undefined,
    priceCurrency: row.priceCurrency ?? undefined,
    reasoning: row.reasoning ?? undefined,
    extraBody: row.extraBody ?? undefined,
    temperature: row.temperature ?? undefined,
    providerType: row.providerType ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function modelToDb(model: LLMModel): DbProviderModel {
  const now = new Date().toISOString();
  return {
    id: model.id || `${model.providerId}::${model.modelKey}`,
    providerId: model.providerId,
    modelKey: model.modelKey,
    label: model.label?.trim() || null,
    contextWindow: model.contextWindow ?? null,
    maxOutputTokens: model.maxOutputTokens ?? null,
    supportsVision: model.supportsVision,
    supportsThinking: model.supportsThinking,
    supportsToolStream: model.supportsToolStream,
    enabled: model.enabled,
    sortOrder: model.sortOrder,
    priceCacheHitPerMtok: model.priceCacheHitPerMtok ?? null,
    priceCacheMissPerMtok: model.priceCacheMissPerMtok ?? null,
    priceOutputPerMtok: model.priceOutputPerMtok ?? null,
    priceCacheWritePerMtok: model.priceCacheWritePerMtok ?? null,
    priceCurrency: model.priceCurrency ?? null,
    reasoning: model.reasoning ?? null,
    extraBody: model.extraBody ?? null,
    temperature: model.temperature ?? null,
    providerType: model.providerType ?? null,
    createdAt: model.createdAt || now,
    updatedAt: now,
  };
}

/**
 * Build LLMModel rows from a preset's `customModels[]` + provider-level
 * capability flags. Used on first-run when no rows exist in the
 * `provider_models` table yet — the v15 DB migration handles the same
 * thing for upgrades, this is the fresh-install path.
 */
function modelsFromPreset(preset: ProviderCatalogPreset): LLMModel[] {
  const keys = preset.customModels?.length ? preset.customModels : [preset.model];
  const aliases = preset.modelAliases || {};
  const pricing = preset.modelPricing || {};
  return Array.from(new Set(keys.filter(Boolean))).map((modelKey, idx) => {
    const p = pricing[modelKey];
    return {
      id: `${preset.id}::${modelKey}`,
      providerId: preset.id,
      modelKey,
      label: aliases[modelKey] || undefined,
      contextWindow: undefined,
      maxOutputTokens: undefined,
      // From the preset, not hardcoded `false`. Every seeded model used to
      // arrive claiming no vision regardless of what it actually does, so a
      // user who added OpenAI (Responses) and pasted a screenshot got nothing
      // until they hunted down the per-model toggle. A capability the
      // catalogue knows about must not need re-entering by hand.
      supportsVision: !!preset.supportsVision,
      supportsThinking: !!preset.supportsThinking,
      supportsToolStream: !!preset.supportsToolStream,
      enabled: true,
      sortOrder: idx,
      priceCacheHitPerMtok: p?.cacheHitPerMtok,
      priceCacheMissPerMtok: p?.cacheMissPerMtok,
      priceOutputPerMtok: p?.outputPerMtok,
      priceCurrency: p ? 'USD' : undefined,
    } satisfies LLMModel;
  });
}

/**
 * Re-populate the `customModels`, `modelAliases`, `supportsThinking`,
 * and `supportsVision` fields on `LLMProvider` from the `models`
 * slice. Called after the models slice changes so legacy code that
 * still reads these fields sees a consistent view. The synthesized
 * `supportsThinking`/`supportsVision` reflect the **active** model
 * (selected by the global `selectedModel`), not OR-aggregated across
 * the whole provider — that's the correct behavior for capability
 * gating downstream.
 */
function synthesizeLegacyProviderFields(
  providers: LLMProvider[],
  models: LLMModel[],
  selectedModel: string,
): LLMProvider[] {
  const [activeProviderId, activeModelKey] = selectedModel.split(":");
  return providers.map((provider) => {
    const ownModels = models
      .filter((m) => m.providerId === provider.id)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const customModels = ownModels.map((m) => m.modelKey);
    const modelAliases = ownModels.reduce<Record<string, string>>((acc, m) => {
      if (m.label && m.label.trim()) acc[m.modelKey] = m.label.trim();
      return acc;
    }, {});

    let activeFlags: { supportsVision: boolean; supportsThinking: boolean } = {
      supportsVision: false,
      supportsThinking: false,
    };
    if (provider.id === activeProviderId) {
      const active = ownModels.find((m) => m.modelKey === activeModelKey) ?? ownModels[0];
      if (active) {
        activeFlags = {
          supportsVision: active.supportsVision,
          supportsThinking: active.supportsThinking,
        };
      }
    } else {
      // For non-active providers, surface the OR over their models so
      // the Settings UI can show capability badges. Capability gating
      // for the runtime always uses the resolved active model below.
      activeFlags = {
        supportsVision: ownModels.some((m) => m.supportsVision),
        supportsThinking: ownModels.some((m) => m.supportsThinking),
      };
    }

    return {
      ...provider,
      customModels: customModels.length ? customModels : undefined,
      modelAliases: Object.keys(modelAliases).length ? modelAliases : undefined,
      supportsThinking: activeFlags.supportsThinking,
      supportsVision: activeFlags.supportsVision,
    };
  });
}

/** Resolve a model's nullable overrides against its provider's defaults. */
function resolveModel(model: LLMModel, provider: LLMProvider): ResolvedLLMModel {
  return {
    ...model,
    resolvedContextWindow: model.contextWindow ?? provider.contextWindow,
    resolvedMaxOutputTokens: model.maxOutputTokens ?? provider.maxOutputTokens,
    displayLabel:
      model.label?.trim() || formatModelDisplayName(model.modelKey),
  };
}

/**
 * Build a {@link ProviderConfig} for an explicit `"providerId:modelKey"`
 * selection (the same string shape as `selectedModel`). Returns `null` when
 * the provider isn't found, so callers can fall back to the active config.
 *
 * This is the generalized core of `getLLMConfig` — used by the Agent Team
 * model overrides (`getTeamLeadConfig` / `getTeamMemberConfig`) so the Lead
 * and the IC team can each ride a different configured provider.
 */
function buildProviderConfigForSelection(
  selection: string,
  providers: LLMProvider[],
  models: LLMModel[],
): ProviderConfig | null {
  const [providerId, modelKey] = selection.split(":");
  if (!providerId) return null;
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) return null;

  const activeModel = models.find(
    (m) => m.providerId === providerId && m.modelKey === modelKey,
  );
  const resolved = activeModel ? resolveModel(activeModel, provider) : undefined;

  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: resolved?.modelKey || modelKey || provider.model,
    maxOutputTokens: resolved?.resolvedMaxOutputTokens ?? provider.maxOutputTokens,
    contextWindow: resolved?.resolvedContextWindow ?? provider.contextWindow,
    supportsThinking: resolved?.supportsThinking ?? false,
    supportsToolStream:
      resolved?.supportsToolStream ?? provider.supportsToolStream ?? false,
    supportsVision: resolved?.supportsVision ?? false,
    // The wire can belong to the model. Schema v24 already persists this, but
    // the generic resolver used to ignore it and only OpenCode's one-off
    // post-processor read the field. That made the settings test and a live
    // turn disagree for every other mixed-format gateway.
    providerType:
      (resolved?.providerType as LLMProvider["providerType"] | undefined) ??
      provider.providerType ??
      "custom",
    customHeaders: provider.customHeaders,
    customParams: provider.customParams,
    defaultTemperature: provider.defaultTemperature,
    // ONLY the user's explicit provider-wide override. It must NOT fall back to
    // `provider.maxOutputTokens`: consumers read `defaultMaxTokens ?? maxOutputTokens`,
    // so a legacy provider-row value (often a stale 8192) would outrank the
    // per-model cap resolved just above and silently cap a 128k model at 8k.
    defaultMaxTokens: provider.defaultMaxTokens ?? undefined,
  };
}

const DEFAULT_TOOL_APPROVAL_SETTINGS: Record<string, 'auto' | 'always_ask' | 'deny'> = {
  // Shell commands require approval
  shell_execute: 'always_ask',
  shell_spawn: 'always_ask',
  // File write operations require approval (current tools)
  file_write: 'always_ask',
  file_edit: 'always_ask',
  move_path: 'always_ask',
  delete_path: 'always_ask',
  folder_create: 'always_ask',
  // Legacy write tool names (historic threads)
  file_create: 'always_ask',
  file_delete: 'always_ask',
  file_patch: 'always_ask',
  search_replace: 'always_ask',
  multi_search_replace: 'always_ask',
  folder_move: 'always_ask',
  folder_delete: 'always_ask',
  // Read operations are generally safe
  file_read: 'auto',
  file_read_lines: 'auto',
  file_exists: 'auto',
  file_search: 'auto',
  workspace_info: 'auto',
  workspace_list_files: 'auto',
  workspace_tree: 'auto',
  workspace_find_files: 'auto',
  workspace_grep: 'auto',
  // Editor operations
  editor_open_file: 'auto',
  editor_get_active_file: 'auto',
  editor_get_selection: 'auto',
  editor_get_open_tabs: 'auto',
  editor_insert_text: 'always_ask',
  editor_close_tab: 'always_ask',
};

// ============================================
// SETTINGS STORE
// ============================================
export const useSettingsStore = create<SettingsState>()((set, get) => ({
  // Initialization state
  isInitialized: false,
  isLoading: false,

  // Providers
  providers: [],
  // Models slice (v15+) — per-model capability profiles. Hydrated in
  // initializeFromDatabase from `provider_models`; legacy fields on
  // LLMProvider are synthesized from this on every change.
  models: [],
  selectedModel: DEFAULT_SELECTED_MODEL,
  explorerIconPack: DEFAULT_EXPLORER_ICON_PACK_ID,

  // Tool Approval
  autoApproveTools: false,
  agentExecutionMode: "agent",
  // Aurora opens on the side that writes software. Chat is the deliberate trip.
  auroraSurface: "build",
  deepResearchNext: false,
  chatModelShortlist: [],
  // Seeded, not empty: the shipped a6api row exists before the database has
  // answered, so the rail never flashes an empty Image group on a cold start.
  imageProviders: withBuiltInImageProviders([]),
  seededImageProviderIds: [],

  // Agent Team (disabled by default; user opts in from the Agent Window's Settings → Team)
  teamEnabled: false,
  maxTeamSize: TEAM_SIZE_RECOMMENDED,
  // Empty = ride the active chat model. The user can pin the Lead and the
  // IC team to specific configured providers from the Agent Window's Settings → Team.
  teamLeadModel: '',
  teamMemberModel: '',
  // Global instructions: one empty "Default" set, none active. Replaced by
  // what the DB holds (or the legacy single string) in initialize.
  globalInstructionProfiles: [
    { id: LEGACY_GLOBAL_INSTRUCTION_PROFILE_ID, name: 'Default', text: '' },
  ],
  activeGlobalInstructionProfileId: '',

  // Context Compaction: auto-summarize older history at 80% of the window,
  // with a generous 8k-token summary. Both user-configurable (Settings → Agent).
  compactionThresholdPct: DEFAULT_COMPACTION_THRESHOLD_PCT,
  compactionSummaryBudget: DEFAULT_COMPACTION_SUMMARY_BUDGET,
  // Empty = summarize on the conversation's own model (the prior behaviour).
  compactionModel: '',

  // AI Title Maker — off by default; the derived title is used until enabled.
  titleMakerEnabled: false,
  titleMakerMode: 'off' as TitleMakerMode,
  titleMakerBaseUrl: '',
  titleMakerApiKey: '',
  titleMakerModel: '',

  // The project and nothing else, until the user says otherwise.
  workspaceAccess: 'workspace',
  allowOutsideWorkspace: false,

  // Turn-complete cues (header flash + rail dot) are on by default.
  notifyOnTurnComplete: true,

  // Live activity in the streaming header title is on by default.
  showActivityInTitle: true,

  // Chapters change what the agent is told to do, so they stay off until asked for.
  transcriptChapters: false,
  browserTools: true,
  deferTools: false,
  mcpBridgeEnabled: false,

  // File Changes Approval
  autoAcceptChanges: false,

  // Agent Guardrails (default: enabled)
  syntaxValidationEnabled: true,
  projectLayoutEnabled: true,

  // Editor Settings
  fontSize: 14,
  wrapMode: true,

  // UI Settings
  uiFontFamily: "system",
  uiTextScale: 1,

  fireworksTabEnabled: false,
  fireworksAccountId: "",

  // Providers the user removed from the Providers page (presets re-seed
  // each launch, so removal is tracked here and filtered out on merge).
  removedProviderIds: [],
  // Preset models the user deleted — same mechanism, per model row.
  removedPresetModelIds: [],

  // Theme
  theme: "dark",

  // Thinking Settings
  thinkingEnabled: true,

  // Max Tokens
  maxTokens: 8192,

  // Temperature
  temperature: 1.0,

  // Autosave Settings
  autoSave: 'off',
  autoSaveDelay: 1000,

  // Tool Settings
  maxToolCallsPerRequest: 25,
  toolApprovalSettings: { ...DEFAULT_TOOL_APPROVAL_SETTINGS },
  skillsEnabled: true,
  skillToggles: {},
  speechEnabled: false,
  speechEngine: "qwen3-rust",
  speechRuntimePath: "",
  speechModelPath: "",
  speechBackend: "auto",
  speechDevicePreference: "auto",
  speechThreads: 4,
  speechLanguage: "auto",

  // ============================================
  // DATABASE OPERATIONS
  // ============================================

  initializeFromDatabase: async () => {
    const state = get();
    if (state.isLoading || state.isInitialized) return;

    set({ isLoading: true });

    try {
      await useIconPackStore.getState().initializeFromDatabase();
      const loadedPresets = await providerCatalogService.getPresets();
      const presetProviders = Array.isArray(loadedPresets) ? loadedPresets : [];

      // Atlas Cloud ships as a frontend preset (not the Rust catalog) so its
      // coding-plan usage card + seeded models land without a backend rebuild.
      // Injected here so BOTH the fresh-install and merge paths pick it up.
      if (!presetProviders.some((p) => p.id === ATLAS_CLOUD_PRESET.id)) {
        presetProviders.push(ATLAS_CLOUD_PRESET);
      }

      // Codex (ChatGPT subscription) ships the same way: a frontend preset
      // with an OAuth-backed card instead of an API key. The Rust side owns
      // auth + routing (`api::codex`); this just seeds the provider row.
      if (!presetProviders.some((p) => p.id === CODEX_PRESET.id)) {
        presetProviders.push(CODEX_PRESET);
      }

      // Cursor (subscription) — same shape again: no API key, the Rust side
      // reads the Cursor app's own session (`api::cursor`) and owns the wire.
      // Its model list is NOT seeded here: the account decides what exists and
      // the catalogue is pulled on connect, so a guess would put models in the
      // picker that the first refresh contradicts.
      if (!presetProviders.some((p) => p.id === CURSOR_PRESET.id)) {
        presetProviders.push(CURSOR_PRESET);
      }

      // OpenCode Go (subscription). An ordinary OpenAI-compatible endpoint
      // with an ordinary key, so it needs no adapter of its own — only the
      // right base URL. `/zen/v1`, the credit-billed API, is deliberately NOT
      // offered: it gives a subscriber nothing a custom provider row would
      // not, and bills separately from the plan they already pay for.
      // Its models are pulled from the account, not seeded, for the same
      // reason as Cursor's.
      if (!presetProviders.some((p) => p.id === OPENCODE_PRESET.id)) {
        presetProviders.push(OPENCODE_PRESET);
      }

      // Command Code (subscription). Frontend preset, but unlike OpenCode Go
      // it is backed by a real Rust adapter: the body nests its model
      // parameters under `params` beside a mandatory `config` block, and the
      // response is newline-delimited JSON rather than SSE, so no existing
      // wire could carry it. Models are pulled from the account rather than
      // seeded, for the same reason as Cursor's.
      if (!presetProviders.some((p) => p.id === COMMANDCODE_PRESET.id)) {
        presetProviders.push(COMMANDCODE_PRESET);
      }

      // AgentRouter (OpenAI-compatible proxy). Frontend preset — seeds the
      // provider row + its required client-fingerprint headers so it works
      // the moment the user pastes a key (or a key pool).
      if (!presetProviders.some((p) => p.id === AGENT_ROUTER_PRESET.id)) {
        presetProviders.push(AGENT_ROUTER_PRESET);
      }

      // Drop any preset the user REMOVED from the Providers page. Presets are
      // re-injected every launch, so a plain delete can't stick — removal is
      // recorded in `removedProviderIds` (app_settings) and filtered here,
      // BEFORE the merge/seed below, so a removed built-in never re-seeds.
      // Fetched up-front (the full app-settings load happens later); failure
      // defaults to "nothing removed".
      let removedProviderIds: string[] = [];
      let removedPresetModelIds: string[] = [];
      try {
        const earlySettings = await databaseService.getAppSettings();
        if (Array.isArray(earlySettings?.removedProviderIds)) {
          removedProviderIds = earlySettings.removedProviderIds;
        }
        if (Array.isArray(earlySettings?.removedPresetModelIds)) {
          removedPresetModelIds = earlySettings.removedPresetModelIds;
        }
      } catch {
        // ignore — treat as nothing removed
      }
      if (removedProviderIds.length > 0) {
        const removedSet = new Set(removedProviderIds);
        for (let i = presetProviders.length - 1; i >= 0; i--) {
          if (removedSet.has(presetProviders[i].id)) presetProviders.splice(i, 1);
        }
      }

      // Check if we have providers in the database
      const hasProviders = await databaseService.hasProviders();

      if (hasProviders) {
        // Load providers from database
        const dbProviders = await databaseService.getAllProviders();
        const providers = dbProviders.map(dbToProvider);

        // Merge with preset providers (in case new presets were added)
        const mergedProviders = presetProviders.map((preset) => {
          const presetProvider = presetToProvider(preset);
          const dbProvider = providers.find(p => p.id === preset.id);
          if (dbProvider) {
            // Keep the stored API key and settings, but update with any new preset fields
            return {
              ...presetProvider,
              ...dbProvider,
              isCustom: false,
              // AgentRouter's wire (Chat vs Messages) is the user's choice —
              // restoring the preset's `openai` here would silently undo it
              // on every launch.
              providerType: isAgentRouterWireChoice(dbProvider)
                ? dbProvider.providerType
                : resolveProviderType(
                    presetProvider.providerType,
                    dbProvider.providerType,
                  ),
              // The catalogue owns a built-in's display name — it cannot be
              // edited in the UI, so a stored one is only ever a stale copy,
              // and letting it win would freeze a name we later corrected.
              name: presetProvider.name,
              supportsToolStream: presetProvider.supportsToolStream ?? dbProvider.supportsToolStream,
              nickname: dbProvider.nickname || presetProvider.nickname,
              // The description is the user's alone — a preset never carries one.
              description: dbProvider.description,
            };
          }
          return presetProvider;
        });

        // Add any custom providers (ensure isCustom is set)
        const customProviders = providers
          .filter(p => p.isCustom)
          .map(p => ({ ...p, isCustom: true as const }));
        mergedProviders.push(...customProviders);

        // Persist preset providers that are NEW to this database before
        // seeding their model rows below — `provider_models` has a
        // FOREIGN KEY to `llm_providers`, so the parent row must land
        // first (otherwise the model upsert fails with "FOREIGN KEY
        // constraint failed" and only persists on a later save).
        for (let i = 0; i < mergedProviders.length; i++) {
          const p = mergedProviders[i];
          if (p.isCustom) continue;
          if (providers.some((db) => db.id === p.id)) continue;
          try {
            await databaseService.saveProvider(providerToDb(p, i));
          } catch (error) {
            console.error("Failed to persist new preset provider:", error);
          }
        }

        // ── Models slice (v15+) ────────────────────────────────────
        // Load model rows for each provider, then merge with preset
        // models (so newly-added presets get their model roster
        // populated even if the user already has a v14-migrated DB).
        const dbModels = await databaseService.listProviderModels();
        const modelsFromDb = dbModels.map(dbToModel);
        const mergedModels: LLMModel[] = [];
        const seenIds = new Set<string>();
        for (const m of modelsFromDb) {
          if (!seenIds.has(m.id)) {
            mergedModels.push(m);
            seenIds.add(m.id);
          }
        }
        // For each preset, ensure every model_key appears at least once.
        // Preset-supplied capabilities only seed; user edits stick — and so
        // do DELETES: a missing row the user removed on purpose is recorded
        // in `removedPresetModelIds` and must not resurrect here. Without
        // that record, "delete gpt-5.5" worked for a session and the model
        // was back every morning.
        const removedModelSet = new Set(removedPresetModelIds);
        for (const preset of presetProviders) {
          const presetModels = modelsFromPreset(preset);
          for (const pm of presetModels) {
            if (!seenIds.has(pm.id) && !removedModelSet.has(pm.id)) {
              mergedModels.push(pm);
              seenIds.add(pm.id);
              // Persist the seeded preset model row.
              databaseService.upsertProviderModel(modelToDb(pm)).catch(console.error);
            }
          }
        }
        // Custom providers may not have any model rows yet (e.g. a
        // user upgraded from v14 with `model = 'foo'` and nothing in
        // customModels[]). Seed one default row per custom provider
        // that currently has zero models.
        for (const provider of mergedProviders) {
          if (!provider.isCustom) continue;
          const hasAny = mergedModels.some((m) => m.providerId === provider.id);
          if (!hasAny && provider.model.trim()) {
            const seeded: LLMModel = {
              id: `${provider.id}::${provider.model}`,
              providerId: provider.id,
              modelKey: provider.model,
              supportsVision: false,
              supportsThinking: provider.supportsThinking ?? false,
              supportsToolStream: provider.supportsToolStream ?? false,
              enabled: true,
              sortOrder: 0,
            };
            mergedModels.push(seeded);
            databaseService.upsertProviderModel(modelToDb(seeded)).catch(console.error);
          }
        }

        // selectedModel hasn't been loaded from app_settings yet —
        // synthesize against DEFAULT_SELECTED_MODEL for now; we'll
        // re-synthesize once selectedModel resolves below.
        const providersWithLegacy = synthesizeLegacyProviderFields(
          mergedProviders,
          mergedModels,
          DEFAULT_SELECTED_MODEL,
        );
        set({ providers: providersWithLegacy, models: mergedModels });
      } else {
        // First time: save default providers AND seed the models
        // slice from preset.customModels[].
        const defaultProviders = createDefaultProviders(presetProviders);
        const dbProviders = defaultProviders.map((p, i) => providerToDb(p, i));
        await databaseService.saveAllProviders(dbProviders);

        const seededModels: LLMModel[] = presetProviders.flatMap(modelsFromPreset);
        for (const m of seededModels) {
          await databaseService.upsertProviderModel(modelToDb(m));
        }
        const providersWithLegacy = synthesizeLegacyProviderFields(
          defaultProviders,
          seededModels,
          DEFAULT_SELECTED_MODEL,
        );
        set({ providers: providersWithLegacy, models: seededModels });
      }

      // Load app settings
      const appSettings = await databaseService.getAppSettings();
      if (appSettings) {
        const uiFontFamily = appSettings.uiFontFamily ?? "system";
        const uiTextScale = appSettings.uiTextScale ?? 1;
        const explorerIconPack = isExplorerIconPackAvailable(
          appSettings.explorerIconPack || DEFAULT_EXPLORER_ICON_PACK_ID,
        )
          ? (appSettings.explorerIconPack || DEFAULT_EXPLORER_ICON_PACK_ID)
          : DEFAULT_EXPLORER_ICON_PACK_ID;
        const selectedModel = resolveSelectedModel(
          appSettings.selectedModel || DEFAULT_SELECTED_MODEL,
          get().providers,
        );
        // A row written before the surface existed can hold `"chat"` here.
        // Read it as the surface it now is, and leave the Build mode at its
        // default rather than persisting a value this field can no longer mean.
        const storedMode = normalizeAgentExecutionMode(appSettings.agentExecutionMode);
        const persistedExecutionMode: AgentExecutionMode =
          storedMode === "chat" ? "agent" : storedMode;
        const persistedSurface: AuroraSurface =
          storedMode === "chat"
            ? "chat"
            : normalizeAuroraSurface(appSettings.auroraSurface);
        const persistedThinkingEnabled = appSettings.thinkingEnabled ?? true;
        const syncedThinkingEnabled = syncThinkingForSelectedModel(
          selectedModel,
          get().providers,
          get().models,
          persistedThinkingEnabled
        );
        const globalInstructionState = resolveGlobalInstructionState(
          appSettings.globalInstructionProfiles,
          appSettings.activeGlobalInstructionProfileId ?? '',
          appSettings.globalInstructions ?? '',
        );

        set({
          selectedModel,
          autoApproveTools: appSettings.autoApproveTools ?? false,
          agentExecutionMode: persistedExecutionMode,
          auroraSurface: persistedSurface,
          deepResearchNext: appSettings.deepResearchNext ?? false,
          chatModelShortlist: normalizeChatShortlist(appSettings.chatModelShortlist),
          ...(() => {
            // Seeded rows are offered once and then remembered, so a deleted
            // one stays deleted. Applied here, on the load, because it is the
            // only place that both knows what was stored and can write back.
            const seeding = withSeededImageProviders(
              normalizeImageProviders(appSettings.imageProviders),
              Array.isArray(appSettings.seededImageProviderIds)
                ? appSettings.seededImageProviderIds
                : [],
            );
            return {
              imageProviders: seeding.providers,
              seededImageProviderIds: seeding.seededIds,
            };
          })(),
          teamEnabled: appSettings.teamEnabled ?? false,
          maxTeamSize: clampTeamSize(appSettings.maxTeamSize ?? TEAM_SIZE_RECOMMENDED),
          teamLeadModel: appSettings.teamLeadModel ?? '',
          teamMemberModel: appSettings.teamMemberModel ?? '',
          globalInstructionProfiles: globalInstructionState.profiles,
          activeGlobalInstructionProfileId: globalInstructionState.activeId,
          compactionThresholdPct: clampCompactionThreshold(
            appSettings.compactionThresholdPct ?? DEFAULT_COMPACTION_THRESHOLD_PCT,
          ),
          compactionSummaryBudget: clampCompactionBudget(
            appSettings.compactionSummaryBudget ?? DEFAULT_COMPACTION_SUMMARY_BUDGET,
          ),
          compactionModel: appSettings.compactionModel ?? '',
          titleMakerEnabled: appSettings.titleMakerEnabled ?? false,
          // Legacy rows have no mode — a previously enabled title maker was
          // always the cloud endpoint.
          titleMakerMode: (['off', 'local', 'cloud'].includes(appSettings.titleMakerMode ?? '')
            ? appSettings.titleMakerMode
            : appSettings.titleMakerEnabled
              ? 'cloud'
              : 'off') as TitleMakerMode,
          titleMakerBaseUrl: appSettings.titleMakerBaseUrl ?? '',
          titleMakerApiKey: appSettings.titleMakerApiKey ?? '',
          titleMakerModel: appSettings.titleMakerModel ?? '',
          // An install that upgrades without opening Settings has only the old
          // boolean on disk. `true` becomes `read` — never `full`, which
          // nobody has consented to.
          workspaceAccess: normalizeWorkspaceAccess(
            appSettings.workspaceAccess,
            appSettings.allowOutsideWorkspace,
          ),
          allowOutsideWorkspace: appSettings.allowOutsideWorkspace ?? false,
          notifyOnTurnComplete: appSettings.notifyOnTurnComplete ?? true,
          showActivityInTitle: appSettings.showActivityInTitle ?? true,
          transcriptChapters: appSettings.transcriptChapters ?? false,
          browserTools: appSettings.browserTools ?? true,
          deferTools: appSettings.deferTools ?? false,
          mcpBridgeEnabled: appSettings.mcpBridgeEnabled ?? false,
          autoAcceptChanges: appSettings.autoAcceptChanges ?? false,
          explorerIconPack,
          syntaxValidationEnabled: appSettings.syntaxValidationEnabled ?? true,
          projectLayoutEnabled: appSettings.projectLayoutEnabled ?? true,
          skillsEnabled: appSettings.skillsEnabled ?? true,
          skillToggles: appSettings.skillToggles ?? {},
          speechEnabled: appSettings.speechEnabled ?? false,
          speechEngine: appSettings.speechEngine ?? "qwen3-rust",
          speechRuntimePath: normalizeSpeechRuntimePath(appSettings.speechRuntimePath),
          speechModelPath: appSettings.speechModelPath ?? "",
          speechBackend: appSettings.speechBackend ?? "auto",
          speechDevicePreference: appSettings.speechDevicePreference ?? "auto",
          speechThreads: appSettings.speechThreads ?? 4,
          speechLanguage: appSettings.speechLanguage ?? "auto",
          fireworksTabEnabled: appSettings.fireworksTabEnabled ?? false,
          fireworksAccountId: appSettings.fireworksAccountId ?? "",
          removedProviderIds: appSettings.removedProviderIds ?? [],
          removedPresetModelIds: appSettings.removedPresetModelIds ?? [],
          fontSize: appSettings.fontSize ?? 14,
          wrapMode: appSettings.wrapMode ?? true,
          theme: (appSettings.theme as 'dark' | 'light') || "dark",
          thinkingEnabled: syncedThinkingEnabled,
          maxTokens: appSettings.maxTokens ?? 8192,
          temperature: appSettings.temperature ?? 1.0,
          autoSave: (appSettings.autoSave as SettingsState['autoSave']) || 'off',
          autoSaveDelay: appSettings.autoSaveDelay ?? 1000,
          maxToolCallsPerRequest: appSettings.maxToolCallsPerRequest ?? 25,
          uiFontFamily,
          uiTextScale,
        });

        setActiveExplorerIconPackId(explorerIconPack);
        applyUiPreferences(uiFontFamily, uiTextScale);

        // Re-sync the legacy capability fields against the now-known
        // selected model so legacy reads see the active model's
        // vision/thinking flags rather than the OR-aggregate seeded
        // above.
        const reSynced = synthesizeLegacyProviderFields(
          get().providers,
          get().models,
          selectedModel,
        );
        set({ providers: reSynced });
      }


      // Load tool settings
      const loadedToolSettings = await databaseService.getAllToolSettings();
      const toolSettings = Array.isArray(loadedToolSettings) ? loadedToolSettings : [];
      if (toolSettings.length > 0) {
        const settings = { ...DEFAULT_TOOL_APPROVAL_SETTINGS };
        for (const ts of toolSettings) {
          settings[ts.toolName] = ts.approvalMode;
        }
        set({ toolApprovalSettings: settings });
      }

      const { uiTextScale, uiFontFamily } = get();
      setActiveExplorerIconPackId(get().explorerIconPack);
      applyUiPreferences(uiFontFamily, uiTextScale);

      set({ isInitialized: true, isLoading: false });


      // Load onboarding state from localStorage
      const hasSeen = localStorage.getItem('aurora_has_seen_onboarding') === 'true';
      set({ hasSeenOnboarding: hasSeen });
    } catch (error) {
      console.error('Failed to initialize settings from database:', error);
      set({ isInitialized: true, isLoading: false });
    }
  },

  saveToDatabase: () => scheduleSettingsSave(() => get().saveToDatabaseImmediate()),

  saveToDatabaseImmediate: async () => {
    const state = get();

    try {
      // Save app settings
      const appSettings: DbAppSettings = {
        selectedModel: state.selectedModel,
        agentExecutionMode: state.agentExecutionMode,
        auroraSurface: state.auroraSurface,
        deepResearchNext: state.deepResearchNext,
        chatModelShortlist: state.chatModelShortlist,
        imageProviders: state.imageProviders,
        seededImageProviderIds: state.seededImageProviderIds,
        teamEnabled: state.teamEnabled,
        maxTeamSize: state.maxTeamSize,
        teamLeadModel: state.teamLeadModel,
        teamMemberModel: state.teamMemberModel,
        // Legacy mirror: older builds read the single string, so it carries
        // the active set's text (empty when none is active).
        globalInstructions: selectActiveGlobalInstructions(state),
        globalInstructionProfiles: state.globalInstructionProfiles,
        activeGlobalInstructionProfileId: state.activeGlobalInstructionProfileId,
        compactionThresholdPct: state.compactionThresholdPct,
        compactionSummaryBudget: state.compactionSummaryBudget,
        compactionModel: state.compactionModel,
        titleMakerEnabled: state.titleMakerEnabled,
        titleMakerMode: state.titleMakerMode,
        titleMakerBaseUrl: state.titleMakerBaseUrl,
        titleMakerApiKey: state.titleMakerApiKey,
        titleMakerModel: state.titleMakerModel,
        workspaceAccess: state.workspaceAccess,
        allowOutsideWorkspace: state.allowOutsideWorkspace,
        notifyOnTurnComplete: state.notifyOnTurnComplete,
        showActivityInTitle: state.showActivityInTitle,
        transcriptChapters: state.transcriptChapters,
        browserTools: state.browserTools,
        deferTools: state.deferTools,
        mcpBridgeEnabled: state.mcpBridgeEnabled,
        autoApproveTools: state.autoApproveTools,
        autoAcceptChanges: state.autoAcceptChanges,
        explorerIconPack: state.explorerIconPack,
        syntaxValidationEnabled: state.syntaxValidationEnabled,
        projectLayoutEnabled: state.projectLayoutEnabled,
        skillsEnabled: state.skillsEnabled,
        skillToggles: state.skillToggles,
        speechEnabled: state.speechEnabled,
        speechEngine: state.speechEngine,
        speechRuntimePath: state.speechRuntimePath,
        speechModelPath: state.speechModelPath,
        speechBackend: state.speechBackend,
        speechDevicePreference: state.speechDevicePreference,
        speechThreads: state.speechThreads,
        speechLanguage: state.speechLanguage,
        fireworksTabEnabled: state.fireworksTabEnabled,
        fireworksAccountId: state.fireworksAccountId,
        removedProviderIds: state.removedProviderIds,
        removedPresetModelIds: state.removedPresetModelIds,
        fontSize: state.fontSize,
        wrapMode: state.wrapMode,
        theme: state.theme,
        thinkingEnabled: state.thinkingEnabled,
        maxTokens: state.maxTokens,
        temperature: state.temperature,
        autoSave: state.autoSave,
        autoSaveDelay: state.autoSaveDelay,
        maxToolCallsPerRequest: state.maxToolCallsPerRequest,
        uiFontFamily: state.uiFontFamily,
        uiScale: 1,
        uiTextScale: state.uiTextScale,
      };

      await databaseService.saveAppSettings(appSettings);

      // Save providers
      const dbProviders = state.providers.map((p, i) => providerToDb(p, i));
      await databaseService.saveAllProviders(dbProviders);

      // Save tool settings
      const toolSettingsArray: [string, string][] = Object.entries(state.toolApprovalSettings);
      await databaseService.saveAllToolSettings(toolSettingsArray);

      // Save onboarding state
      // (For now using localStorage as it's UI state, but could be DB if needed)
      // Actually let's assume it's part of app settings in next migration or just use localStorage for this specific flag
      // since it's purely frontend "seen" state.
    } catch (error) {
      console.error('Failed to save settings to database:', error);
    }
  },

  // Onboarding
  hasSeenOnboarding: false,
  setHasSeenOnboarding: (seen: boolean) => {
    set({ hasSeenOnboarding: seen });
    localStorage.setItem('aurora_has_seen_onboarding', String(seen));
  },

  // ============================================
  // PROVIDER ACTIONS
  // ============================================

  updateProvider: (id: string, updates: Partial<LLMProvider>) => {
    // Translate writes to legacy fields back into models-slice ops.
    // This keeps existing UI (Fireworks tab, LocalProviderPanel) and
    // their `updateProvider({ customModels, modelAliases, supportsThinking,
    // supportsVision })` calls working without per-call rewrites.
    const {
      customModels: nextCustomModels,
      modelAliases: nextModelAliases,
      supportsThinking: nextSupportsThinking,
      supportsVision: nextSupportsVision,
      ...providerUpdates
    } = updates;

    set((state: SettingsState) => {
      const providers = state.providers.map((provider: LLMProvider) => {
        if (provider.id !== id) return provider;

        const nextProvider = {
          ...provider,
          ...providerUpdates,
        };

        return {
          ...nextProvider,
          nickname: nextProvider.nickname?.trim() || undefined,
          description: normalizeProviderDescription(nextProvider.description),
        };
      });

      // ── Reconcile legacy field writes against the models slice ──
      let nextModels = state.models;
      if (nextCustomModels !== undefined) {
        const targetKeys = Array.from(
          new Set((nextCustomModels || []).filter(Boolean)),
        );
        const existing = state.models.filter((m) => m.providerId === id);
        const others = state.models.filter((m) => m.providerId !== id);
        const reconciled = targetKeys.map((modelKey, idx) => {
          const prior = existing.find((m) => m.modelKey === modelKey);
          if (prior) return { ...prior, sortOrder: idx };
          return {
            id: `${id}::${modelKey}`,
            providerId: id,
            modelKey,
            label: nextModelAliases?.[modelKey] || undefined,
            contextWindow: undefined,
            maxOutputTokens: undefined,
            supportsVision: false,
            supportsThinking: nextSupportsThinking ?? false,
            supportsToolStream: false,
            enabled: true,
            sortOrder: idx,
          } satisfies LLMModel;
        });
        nextModels = [...others, ...reconciled];
        // Persist the new roster (fire-and-forget; UI doesn't block).
        databaseService
          .replaceProviderModels(id, reconciled.map(modelToDb))
          .catch(console.error);
      }

      if (nextModelAliases !== undefined) {
        nextModels = nextModels.map((m) => {
          if (m.providerId !== id) return m;
          const nextLabel = nextModelAliases[m.modelKey];
          if (nextLabel === undefined && !m.label) return m;
          if (nextLabel === m.label) return m;
          const updated = { ...m, label: nextLabel?.trim() || undefined };
          databaseService.upsertProviderModel(modelToDb(updated)).catch(console.error);
          return updated;
        });
      }

      // Provider-level capability writes propagate to the active
      // model row (this is the closest match to the v14 semantics).
      const [activeProviderId, activeModelKey] = state.selectedModel.split(":");
      if (
        (nextSupportsVision !== undefined || nextSupportsThinking !== undefined) &&
        activeProviderId === id
      ) {
        nextModels = nextModels.map((m) => {
          if (m.providerId !== id || m.modelKey !== activeModelKey) return m;
          const updated: LLMModel = {
            ...m,
            supportsVision:
              nextSupportsVision !== undefined ? nextSupportsVision : m.supportsVision,
            supportsThinking:
              nextSupportsThinking !== undefined ? nextSupportsThinking : m.supportsThinking,
          };
          databaseService.upsertProviderModel(modelToDb(updated)).catch(console.error);
          return updated;
        });
      }

      const selectedModel = resolveSelectedModel(state.selectedModel, providers);
      const synthesized = synthesizeLegacyProviderFields(
        providers,
        nextModels,
        selectedModel,
      );

      return {
        providers: synthesized,
        models: nextModels,
        selectedModel,
        thinkingEnabled: syncThinkingForSelectedModel(
          selectedModel,
          synthesized,
          nextModels,
          state.thinkingEnabled,
        ),
      };
    });
    // Persist (debouncing now lives inside saveToDatabase).
    get().saveToDatabase();
  },

  addCustomProvider: (provider: Omit<LLMProvider, "id" | "isCustom">) => {
    const id = uuidv4();
    const newProvider: LLMProvider = {
      ...provider,
      id,
      isCustom: true,
      nickname: provider.nickname?.trim() || undefined,
      description: normalizeProviderDescription(provider.description),
    };

    // Seed the models slice from the legacy fields the caller passed.
    // Old AddProviderForm hands us `{ model, customModels: [model],
    // supportsThinking, supportsVision }`; the new ProvidersHubTab
    // calls `addModel` separately. Both paths land in the same place.
    const seedKeys = Array.from(
      new Set(
        [provider.model, ...(provider.customModels || [])].filter(
          (k): k is string => !!k && !!k.trim(),
        ),
      ),
    );
    const seededModels: LLMModel[] = seedKeys.map((modelKey, idx) => ({
      id: `${id}::${modelKey}`,
      providerId: id,
      modelKey,
      label: provider.modelAliases?.[modelKey] || undefined,
      contextWindow: undefined,
      maxOutputTokens: undefined,
      supportsVision: !!provider.supportsVision,
      supportsThinking: !!provider.supportsThinking,
      supportsToolStream: !!provider.supportsToolStream,
      enabled: true,
      sortOrder: idx,
    }));

    set((state: SettingsState) => {
      const nextProviders = [...state.providers, newProvider];
      const nextModels = [...state.models, ...seededModels];
      const synthesized = synthesizeLegacyProviderFields(
        nextProviders,
        nextModels,
        state.selectedModel,
      );
      return { providers: synthesized, models: nextModels };
    });

    // Persist provider + models.
    get().saveToDatabase();
    for (const m of seededModels) {
      databaseService.upsertProviderModel(modelToDb(m)).catch(console.error);
    }
    return id;
  },

  deleteProvider: (id: string) => {
    const state = get();
    const provider = state.providers.find((p: LLMProvider) => p.id === id);
    // Only allow deleting custom providers
    if (provider?.isCustom) {
      set((state: SettingsState) => {
        const nextProviders = state.providers.filter((p: LLMProvider) => p.id !== id);
        const nextModels = state.models.filter((m) => m.providerId !== id);
        const nextSelected = state.selectedModel.startsWith(id + ":")
          ? DEFAULT_SELECTED_MODEL
          : state.selectedModel;
        const synthesized = synthesizeLegacyProviderFields(
          nextProviders,
          nextModels,
          nextSelected,
        );
        return {
          providers: synthesized,
          models: nextModels,
          selectedModel: nextSelected,
        };
      });
      // Delete from database. Models cascade via FK, but we also call
      // the explicit delete to keep things tidy on platforms where
      // foreign_keys is off.
      databaseService.deleteProvider(id).catch(console.error);
      get().saveToDatabase();
    }
  },

  removeSkillToggle: (storageKey: string) => {
    const state = get();
    let changed = false;
    const nextToggles: Record<string, Record<string, boolean>> = {};

    for (const [scopeKey, scopeToggles] of Object.entries(state.skillToggles ?? {})) {
      if (!(storageKey in scopeToggles)) {
        nextToggles[scopeKey] = scopeToggles;
        continue;
      }
      const rest = { ...scopeToggles };
      delete rest[storageKey];
      nextToggles[scopeKey] = rest;
      changed = true;
    }

    if (!changed) return;
    set({ skillToggles: nextToggles });
    get().saveToDatabase();
  },

  removeProvider: (id: string) => {
    const state = get();
    const provider = state.providers.find((p: LLMProvider) => p.id === id);
    if (!provider) return;

    // Custom providers are truly deleted — nothing re-seeds them.
    if (provider.isCustom) {
      get().deleteProvider(id);
      return;
    }

    // Built-in preset: it would re-seed on the next launch, so record its id
    // in `removedProviderIds` (persisted) AND drop it (+ its models) from the
    // live state now. Also delete its DB row. This is permanent — the recorded
    // id is the only thing keeping the preset from silently re-seeding.
    set((s: SettingsState) => {
      const removedProviderIds = s.removedProviderIds.includes(id)
        ? s.removedProviderIds
        : [...s.removedProviderIds, id];
      const nextProviders = s.providers.filter((p: LLMProvider) => p.id !== id);
      const nextModels = s.models.filter((m) => m.providerId !== id);
      const nextSelected = s.selectedModel.startsWith(id + ":")
        ? DEFAULT_SELECTED_MODEL
        : s.selectedModel;
      const synthesized = synthesizeLegacyProviderFields(
        nextProviders,
        nextModels,
        nextSelected,
      );
      return {
        removedProviderIds,
        providers: synthesized,
        models: nextModels,
        selectedModel: nextSelected,
      };
    });
    databaseService.deleteProvider(id).catch(console.error);
    get().saveToDatabase();
  },

  setSelectedModel: (model: string) => {
    set((state) => {
      const synthesized = synthesizeLegacyProviderFields(
        state.providers,
        state.models,
        model,
      );
      return {
        selectedModel: model,
        providers: synthesized,
        thinkingEnabled: syncThinkingForSelectedModel(
          model,
          synthesized,
          state.models,
          state.thinkingEnabled,
        ),
      };
    });
    get().saveToDatabase();
  },

  // ============================================
  // MODELS SLICE ACTIONS (v15+)
  // ============================================

  modelsForProvider: (providerId: string) => {
    return get()
      .models
      .filter((m) => m.providerId === providerId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  },

  getActiveModel: () => {
    const state = get();
    const [providerId, modelKey] = state.selectedModel.split(":");
    if (!providerId || !modelKey) return undefined;
    return state.models.find(
      (m) => m.providerId === providerId && m.modelKey === modelKey,
    );
  },

  getModelFor: (selection) => {
    if (!selection) return get().getActiveModel();
    const state = get();
    const [providerId, modelKey] = selection.split(":");
    if (!providerId || !modelKey) return state.getActiveModel();
    return (
      state.models.find(
        (m) => m.providerId === providerId && m.modelKey === modelKey,
      ) ?? undefined
    );
  },

  getResolvedActiveModel: () => {
    const state = get();
    const [providerId] = state.selectedModel.split(":");
    const provider = state.providers.find((p) => p.id === providerId);
    const model = state.getActiveModel();
    if (!provider || !model) return undefined;
    return resolveModel(model, provider);
  },

  addModel: (providerId, init) => {
    const id = `${providerId}::${init.modelKey}`;
    const sortOrder =
      init.sortOrder ?? get().models.filter((m) => m.providerId === providerId).length;
    const newModel: LLMModel = {
      id,
      providerId,
      sortOrder,
      ...init,
    };
    set((state) => {
      const nextModels = [...state.models.filter((m) => m.id !== id), newModel];
      const synthesized = synthesizeLegacyProviderFields(
        state.providers,
        nextModels,
        state.selectedModel,
      );
      return {
        models: nextModels,
        providers: synthesized,
        // Re-adding a model the user once deleted is a change of mind —
        // lift its tombstone so the roster and the record agree.
        removedPresetModelIds: state.removedPresetModelIds.includes(id)
          ? state.removedPresetModelIds.filter((r) => r !== id)
          : state.removedPresetModelIds,
      };
    });
    databaseService.upsertProviderModel(modelToDb(newModel)).catch(console.error);
    return id;
  },

  updateModel: (id, updates) => {
    set((state) => {
      let updatedRow: LLMModel | undefined;
      const nextModels = state.models.map((m) => {
        if (m.id !== id) return m;
        const next: LLMModel = { ...m, ...updates };
        updatedRow = next;
        return next;
      });
      if (updatedRow) {
        databaseService
          .upsertProviderModel(modelToDb(updatedRow))
          .catch(console.error);
      }
      const synthesized = synthesizeLegacyProviderFields(
        state.providers,
        nextModels,
        state.selectedModel,
      );
      return { models: nextModels, providers: synthesized };
    });
  },

  deleteModel: (id) => {
    const state = get();
    const target = state.models.find((m) => m.id === id);
    if (!target) return;
    const nextModels = state.models.filter((m) => m.id !== id);
    databaseService
      .deleteProviderModel(target.providerId, target.modelKey)
      .catch(console.error);
    // If the deleted model was selected, fall back to first available.
    let nextSelected = state.selectedModel;
    const [activeProviderId, activeModelKey] = state.selectedModel.split(":");
    if (activeProviderId === target.providerId && activeModelKey === target.modelKey) {
      const fallback = nextModels
        .filter((m) => m.providerId === activeProviderId && m.enabled)
        .sort((a, b) => a.sortOrder - b.sortOrder)[0];
      if (fallback) {
        nextSelected = `${fallback.providerId}:${fallback.modelKey}`;
      } else {
        // No models left under this provider — fall back across all.
        const cross = nextModels
          .filter((m) => m.enabled)
          .sort((a, b) => a.sortOrder - b.sortOrder)[0];
        if (cross) nextSelected = `${cross.providerId}:${cross.modelKey}`;
      }
    }
    const synthesized = synthesizeLegacyProviderFields(
      state.providers,
      nextModels,
      nextSelected,
    );
    // A model deleted from a BUILT-IN provider must not resurrect: the
    // preset roster re-adds any missing key on launch, so record the id.
    // Custom providers' models are truly deleted — nothing re-seeds them.
    const owner = state.providers.find((p) => p.id === target.providerId);
    const removedPresetModelIds =
      owner && !owner.isCustom && !state.removedPresetModelIds.includes(id)
        ? [...state.removedPresetModelIds, id]
        : state.removedPresetModelIds;
    set({
      models: nextModels,
      selectedModel: nextSelected,
      providers: synthesized,
      removedPresetModelIds,
    });
    get().saveToDatabase();
  },

  replaceModelsForProvider: (providerId, init, renamedKeys) => {
    const reconciled: LLMModel[] = init.map((m, idx) => ({
      ...m,
      id: `${providerId}::${m.modelKey}`,
      providerId,
      sortOrder: idx,
    }));
    databaseService
      .replaceProviderModels(providerId, reconciled.map(modelToDb))
      .catch(console.error);
    set((state) => {
      const others = state.models.filter((m) => m.providerId !== providerId);
      const nextModels = [...others, ...reconciled];

      // Follow a rename before reconciling. Without this the old key is simply
      // gone, `resolveSelectedModel` bounces the selection to whichever model
      // happens to sort first — often another provider entirely — and the
      // person's chosen model changes because they changed a gateway region.
      let selectedModel = state.selectedModel;
      const separator = selectedModel.indexOf(":");
      if (renamedKeys && separator > 0 && selectedModel.slice(0, separator) === providerId) {
        const renamed = renamedKeys[selectedModel.slice(separator + 1)];
        if (renamed) selectedModel = `${providerId}:${renamed}`;
      }
      selectedModel = resolveSelectedModel(
        selectedModel,
        synthesizeLegacyProviderFields(state.providers, nextModels, selectedModel),
      );

      const synthesized = synthesizeLegacyProviderFields(
        state.providers,
        nextModels,
        selectedModel,
      );
      return { models: nextModels, providers: synthesized, selectedModel };
    });
    // The models themselves went to the database above; `selectedModel` lives
    // in app settings and has to be written too, or a restart reads the old
    // key back and reconciles it away.
    get().saveToDatabase();
  },

  getAvailableModels: () => {
    return buildAvailableModelOptions(get().providers);
  },

  getSelectedProvider: () => {
    const state = get();
    const [providerId] = state.selectedModel.split(":");
    return state.providers.find((p: LLMProvider) => p.id === providerId);
  },

  // ============================================
  // SETTINGS ACTIONS
  // ============================================

  setAutoApproveTools: (value: boolean) => {
    set({ autoApproveTools: value });
    get().saveToDatabase();
  },

  setAgentExecutionMode: (mode: AgentExecutionMode) => {
    const nextMode = normalizeAgentExecutionMode(mode);
    // `chat` is a SURFACE, not a Build mode. Routing it here would let the
    // composer's Agent↔Plan cycle move the window to another product, and
    // would overwrite the Build mode this field exists to remember.
    if (nextMode === "chat") {
      get().setAuroraSurface("chat");
      return;
    }
    set({ agentExecutionMode: nextMode });
    get().saveToDatabase();
  },

  setAuroraSurface: (surface: AuroraSurface) => {
    set({ auroraSurface: normalizeAuroraSurface(surface) });
    get().saveToDatabase();
  },

  setDeepResearchNext: (enabled: boolean) => {
    set({ deepResearchNext: enabled });
    get().saveToDatabase();
  },

  addImageProvider: (provider) => {
    const id = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    set({ imageProviders: [...get().imageProviders, { ...provider, id, models: [] }] });
    get().saveToDatabase();
    return id;
  },

  updateImageProvider: (id, patch) => {
    set({
      imageProviders: get().imageProviders.map((provider) =>
        provider.id === id ? { ...provider, ...patch } : provider,
      ),
    });
    get().saveToDatabase();
  },

  deleteImageProvider: (id) => {
    // A shipped provider stays. Its card offers no delete control, so reaching
    // here means something other than the button asked — and the row would come
    // straight back on the next load anyway, which is worse than refusing.
    if (get().imageProviders.some((provider) => provider.id === id && provider.builtIn)) {
      return;
    }
    // The models go with it. They live inside the row, so there is nothing to
    // orphan — which is the reason they live inside the row.
    set({ imageProviders: get().imageProviders.filter((provider) => provider.id !== id) });
    get().saveToDatabase();
  },

  addImageModel: (providerId, model) => {
    // Keyed on provider AND model name, so the same model offered by two
    // providers is two rows rather than one that silently overwrites the other.
    const id = `${providerId}:${model.modelKey}`;
    set({
      imageProviders: get().imageProviders.map((provider) =>
        provider.id === providerId
          ? {
              ...provider,
              models: provider.models.some((existing) => existing.id === id)
                ? provider.models
                : [...provider.models, { ...model, id, providerId }],
            }
          : provider,
      ),
    });
    get().saveToDatabase();
    return id;
  },

  updateImageModel: (id, patch) => {
    set({
      imageProviders: get().imageProviders.map((provider) => ({
        ...provider,
        models: provider.models.map((model) =>
          model.id === id ? { ...model, ...patch } : model,
        ),
      })),
    });
    get().saveToDatabase();
  },

  deleteImageModel: (id) => {
    set({
      imageProviders: get().imageProviders.map((provider) => ({
        ...provider,
        models: provider.models.filter((model) => model.id !== id),
      })),
    });
    get().saveToDatabase();
  },

  toggleChatShortlistModel: (selection: string) => {
    const key = selection.trim();
    if (!key) return;
    const current = get().chatModelShortlist;
    if (current.includes(key)) {
      set({ chatModelShortlist: current.filter((entry) => entry !== key) });
    } else {
      // Silently at the cap rather than throwing: the control that calls this
      // is already disabled at ten and says why, so reaching here means two
      // rapid clicks, not a user who needs telling twice.
      if (current.length >= CHAT_SHORTLIST_MAX) return;
      set({ chatModelShortlist: [...current, key] });
    }
    get().saveToDatabase();
  },

  setTeamEnabled: (enabled: boolean) => {
    // Disabling the feature must not leave the input box stuck in Team mode —
    // fall back to Agent so the team tools/prompt are no longer in play.
    const patch: Partial<SettingsState> = { teamEnabled: enabled };
    if (!enabled && get().agentExecutionMode === "team") {
      patch.agentExecutionMode = "agent";
    }
    set(patch);
    get().saveToDatabase();
  },

  setMaxTeamSize: (size: number) => {
    set({ maxTeamSize: clampTeamSize(size) });
    get().saveToDatabase();
  },

  setTeamLeadModel: (selection: string) => {
    set({ teamLeadModel: selection });
    get().saveToDatabase();
  },

  setTitleMaker: (value) => {
    const patch: Partial<SettingsState> = {};
    if (value.mode !== undefined) {
      patch.titleMakerMode = value.mode;
      // Keep the legacy boolean in lockstep for anything still reading it.
      patch.titleMakerEnabled = value.mode === 'cloud';
    }
    if (value.enabled !== undefined) patch.titleMakerEnabled = value.enabled;
    if (value.baseUrl !== undefined) patch.titleMakerBaseUrl = value.baseUrl;
    if (value.apiKey !== undefined) patch.titleMakerApiKey = value.apiKey;
    if (value.model !== undefined) patch.titleMakerModel = value.model;
    set(patch);
    get().saveToDatabase();
  },

  setWorkspaceAccess: (value: WorkspaceAccess) => {
    // The legacy boolean is derived, never set by hand: the two can then only
    // disagree if someone edits the database, and a reader that predates the
    // mode still sees the nearest true answer.
    set({ workspaceAccess: value, allowOutsideWorkspace: value !== 'workspace' });
    get().saveToDatabase();
  },

  setNotifyOnTurnComplete: (value: boolean) => {
    set({ notifyOnTurnComplete: value });
    get().saveToDatabase();
  },

  setShowActivityInTitle: (value: boolean) => {
    set({ showActivityInTitle: value });
    get().saveToDatabase();
  },

  setTranscriptChapters: (value: boolean) => {
    set({ transcriptChapters: value });
    get().saveToDatabase();
  },

  setBrowserTools: (value: boolean) => {
    set({ browserTools: value });
    get().saveToDatabase();
  },

  setDeferTools: (value: boolean) => {
    set({ deferTools: value });
    get().saveToDatabase();
  },

  setMcpBridgeEnabled: (value: boolean) => {
    set({ mcpBridgeEnabled: value });
    get().saveToDatabase();
  },

  setTeamMemberModel: (selection: string) => {
    set({ teamMemberModel: selection });
    get().saveToDatabase();
  },

  addGlobalInstructionProfile: () => {
    const profiles = get().globalInstructionProfiles;
    if (profiles.length >= GLOBAL_INSTRUCTION_PROFILE_LIMIT) return null;
    const id = uuidv4();
    set({
      globalInstructionProfiles: [
        ...profiles,
        { id, name: `Persona ${profiles.length + 1}`, text: '' },
      ],
    });
    get().saveToDatabase();
    return id;
  },

  renameGlobalInstructionProfile: (id: string, name: string) => {
    const trimmed = clampProfileName(name);
    if (!trimmed) return; // an empty commit keeps the old name
    set({
      globalInstructionProfiles: get().globalInstructionProfiles.map((p) =>
        p.id === id ? { ...p, name: trimmed } : p,
      ),
    });
    get().saveToDatabase();
  },

  setGlobalInstructionProfileText: (id: string, text: string) => {
    set({
      globalInstructionProfiles: get().globalInstructionProfiles.map((p) =>
        p.id === id ? { ...p, text } : p,
      ),
    });
    get().saveToDatabase();
  },

  setActiveGlobalInstructionProfile: (id: string | null) => {
    // Activation is exclusive by construction — one id field, not per-set
    // flags — so switching a set on switches every other set off.
    const next =
      id && get().globalInstructionProfiles.some((p) => p.id === id) ? id : '';
    set({ activeGlobalInstructionProfileId: next });
    get().saveToDatabase();
  },

  removeGlobalInstructionProfile: (id: string) => {
    const profiles = get().globalInstructionProfiles;
    if (profiles.length <= 1) return; // the editor always keeps one set
    const remaining = profiles.filter((p) => p.id !== id);
    if (remaining.length === profiles.length) return;
    set({
      globalInstructionProfiles: remaining,
      // Deleting the live set deactivates rather than silently promoting
      // another persona into every future chat.
      ...(get().activeGlobalInstructionProfileId === id
        ? { activeGlobalInstructionProfileId: '' }
        : null),
    });
    get().saveToDatabase();
  },

  setCompactionThresholdPct: (value: number) => {
    set({ compactionThresholdPct: clampCompactionThreshold(value) });
    get().saveToDatabase();
  },

  setCompactionModel: (selection: string) => {
    set({ compactionModel: selection });
    get().saveToDatabase();
  },

  setCompactionSummaryBudget: (value: number) => {
    set({ compactionSummaryBudget: clampCompactionBudget(value) });
    get().saveToDatabase();
  },

  setAutoAcceptChanges: (value: boolean) => {
    set({ autoAcceptChanges: value });
    get().saveToDatabase();
  },

  setSyntaxValidationEnabled: (value: boolean) => {
    set({ syntaxValidationEnabled: value });
    get().saveToDatabase();
  },

  setProjectLayoutEnabled: (value: boolean) => {
    set({ projectLayoutEnabled: value });
    get().saveToDatabase();
  },

  setSkillsEnabled: (enabled: boolean) => {
    set({ skillsEnabled: enabled });
    get().saveToDatabase();
  },

  setSkillEnabled: (scopeKey: string, storageKey: string, enabled: boolean) => {
    const state = get();
    const scopeToggles = state.skillToggles[scopeKey] ?? {};
    const isCurrentlyEnabled = scopeToggles[storageKey] === true;

    // No-op: nothing to change.
    if (isCurrentlyEnabled === enabled) {
      return true;
    }

    // Enforce hard cap when turning ON, scoped to THIS workspace. Turning OFF
    // is always allowed. Counting per scope is what keeps one project's
    // selection from blocking another's.
    if (enabled) {
      const enabledCount = countEnabledSkillToggles(scopeToggles);
      if (enabledCount >= MAX_ENABLED_SKILLS) {
        console.warn(
          `[Skills] Cannot enable more than ${MAX_ENABLED_SKILLS} skills in this workspace. ` +
            `Disable an existing skill before enabling \`${storageKey}\`.`
        );
        return false;
      }
    }

    set((current) => {
      const currentScope = current.skillToggles[scopeKey] ?? {};
      const nextScope = { ...currentScope, [storageKey]: enabled };
      return {
        skillToggles: {
          ...current.skillToggles,
          [scopeKey]: nextScope,
        },
      };
    });
    get().saveToDatabase();
    return true;
  },

  setSpeechEnabled: (enabled: boolean) => {
    set({ speechEnabled: enabled });
    get().saveToDatabase();
  },

  setSpeechEngine: (engine: string) => {
    set({ speechEngine: engine || "qwen3-rust" });
    get().saveToDatabase();
  },

  setSpeechRuntimePath: (path: string) => {
    set({ speechRuntimePath: normalizeSpeechRuntimePath(path) });
    get().saveToDatabase();
  },

  setSpeechModelPath: (path: string) => {
    set({ speechModelPath: path });
    get().saveToDatabase();
  },

  setSpeechBackend: (backend: string) => {
    set({ speechBackend: backend || "auto" });
    get().saveToDatabase();
  },

  setSpeechDevicePreference: (preference: 'auto' | 'cpu' | 'gpu') => {
    set({ speechDevicePreference: preference });
    get().saveToDatabase();
  },

  setSpeechThreads: (threads: number) => {
    set({ speechThreads: Math.min(32, Math.max(1, Math.round(threads) || 4)) });
    get().saveToDatabase();
  },

  setSpeechLanguage: (language: string) => {
    set({ speechLanguage: language || "auto" });
    get().saveToDatabase();
  },

  setFontSize: (size: number) => {
    set({ fontSize: size });
    get().saveToDatabase();
  },

  setExplorerIconPack: (packId: ExplorerIconPackId) => {
    const nextPackId = isExplorerIconPackAvailable(packId)
      ? packId
      : DEFAULT_EXPLORER_ICON_PACK_ID;
    set({ explorerIconPack: nextPackId });
    setActiveExplorerIconPackId(nextPackId);
    get().saveToDatabase();
  },

  setFireworksTabEnabled: (enabled: boolean) => {
    set({ fireworksTabEnabled: enabled });
    get().saveToDatabase();
  },

  setFireworksAccountId: (accountId: string) => {
    set({ fireworksAccountId: accountId });
    get().saveToDatabase();
  },

  setWrapMode: (enabled: boolean) => {
    set({ wrapMode: enabled });
    get().saveToDatabase();
  },

  setUiTextScale: (scale: number) => {
    const clamped = clampTextScale(scale);
    set({ uiTextScale: clamped });
    applyUiPreferences(get().uiFontFamily, clamped);
    get().saveToDatabase();
  },

  setUiFontFamily: (family: string) => {
    set({ uiFontFamily: family });
    applyUiPreferences(family, get().uiTextScale);
    get().saveToDatabase();
  },

  setTheme: (theme: "dark" | "light") => {
    set({ theme });
    get().saveToDatabase();
  },


  setThinkingEnabled: (enabled: boolean) => {
    set({ thinkingEnabled: enabled });
    get().saveToDatabase();
  },

  setMaxTokens: (tokens: number) => {
    set({ maxTokens: tokens });
    get().saveToDatabase();
  },

  setTemperature: (temp: number) => {
    set({ temperature: temp });
    get().saveToDatabase();
  },

  setAutoSave: (mode: 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange') => {
    set({ autoSave: mode });
    get().saveToDatabase();
  },

  setAutoSaveDelay: (delay: number) => {
    set({ autoSaveDelay: delay });
    get().saveToDatabase();
  },

  setMaxToolCallsPerRequest: (max: number) => {
    set({ maxToolCallsPerRequest: max });
    get().saveToDatabase();
  },

  setToolApproval: (toolName: string, setting: 'auto' | 'always_ask' | 'deny') => {
    set((state) => ({
      toolApprovalSettings: {
        ...state.toolApprovalSettings,
        [toolName]: setting,
      },
    }));
    // Save individual tool setting
    databaseService.setToolApproval(toolName, setting).catch(console.error);
  },

  getToolApproval: (toolName: string) => {
    const state = get();
    return state.toolApprovalSettings[toolName] || 'always_ask';
  },

  // Get current LLM provider config based on selectedModel.
  //
  // v15+: capability flags (supportsVision, supportsThinking,
  // supportsToolStream) and per-model context/output overrides come
  // from the resolved active `LLMModel`, not from the provider row.
  // This is what drives `browser_screenshot` tool gating in
  // agent-service and `<aurora_image>` routing in the API adapters.
  getLLMConfig: () => {
    const state = get();
    const [providerId, modelKey] = state.selectedModel.split(":");
    const provider = state.providers.find(
      (p: LLMProvider) => p.id === providerId,
    );
    const activeModel =
      provider &&
      state.models.find(
        (m) => m.providerId === providerId && m.modelKey === modelKey,
      );

    if (provider) {
      const resolved = activeModel ? resolveModel(activeModel, provider) : undefined;
      return {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        apiKeys: provider.apiKeys,
        model: resolved?.modelKey || modelKey || provider.model,
        maxOutputTokens: resolved?.resolvedMaxOutputTokens ?? provider.maxOutputTokens,
        contextWindow: resolved?.resolvedContextWindow ?? provider.contextWindow,
        supportsThinking: resolved?.supportsThinking ?? false,
        supportsToolStream:
          resolved?.supportsToolStream ?? provider.supportsToolStream ?? false,
        supportsVision: resolved?.supportsVision ?? false,
        providerType:
          (resolved?.providerType as LLMProvider["providerType"] | undefined) ??
          provider.providerType ??
          "custom",
        customHeaders: provider.customHeaders,
        customParams: provider.customParams,
        defaultTemperature: provider.defaultTemperature,
        // Explicit override only — see `toLlmConfig`. Falling back to the
        // provider row here lets a stale 8192 outrank the per-model cap.
        defaultMaxTokens: provider.defaultMaxTokens ?? undefined,
      };
    }

    // Fallback to first available provider with API key
    const fallback = state.providers.find(
      (p: LLMProvider) => p.enabled && p.apiKey,
    );
    if (fallback) {
      const fallbackModel = state.models
        .filter((m) => m.providerId === fallback.id && m.enabled)
        .sort((a, b) => a.sortOrder - b.sortOrder)[0];
      const resolved = fallbackModel
        ? resolveModel(fallbackModel, fallback)
        : undefined;
      return {
        id: fallback.id,
        name: fallback.name,
        baseUrl: fallback.baseUrl,
        apiKey: fallback.apiKey,
        apiKeys: fallback.apiKeys,
        model: resolved?.modelKey || fallback.model,
        maxOutputTokens: resolved?.resolvedMaxOutputTokens ?? fallback.maxOutputTokens,
        contextWindow: resolved?.resolvedContextWindow ?? fallback.contextWindow,
        supportsThinking: resolved?.supportsThinking ?? false,
        supportsToolStream:
          resolved?.supportsToolStream ?? fallback.supportsToolStream ?? false,
        supportsVision: resolved?.supportsVision ?? false,
        providerType:
          (resolved?.providerType as LLMProvider["providerType"] | undefined) ??
          fallback.providerType ??
          "custom",
        customHeaders: fallback.customHeaders,
        customParams: fallback.customParams,
        defaultTemperature: fallback.defaultTemperature,
        // Explicit override only — see `toLlmConfig`.
        defaultMaxTokens: fallback.defaultMaxTokens ?? undefined,
      };
    }

    // No provider available
    return null;
  },

  getLLMConfigFor: (selection) => {
    if (!selection) return get().getLLMConfig();
    const { providers, models } = get();
    return (
      buildProviderConfigForSelection(selection, providers, models) ??
      get().getLLMConfig()
    );
  },

  // Agent Team provider overrides. Each resolves the configured
  // `"providerId:modelKey"` selection when set & valid, else falls back to
  // the active chat config — so by default the team rides the chat provider.
  getTeamLeadConfig: () => {
    const { teamLeadModel, providers, models } = get();
    if (teamLeadModel) {
      const cfg = buildProviderConfigForSelection(teamLeadModel, providers, models);
      if (cfg) return cfg;
    }
    return get().getLLMConfig();
  },

  getTeamMemberConfig: () => {
    const { teamMemberModel, providers, models } = get();
    if (teamMemberModel) {
      const cfg = buildProviderConfigForSelection(teamMemberModel, providers, models);
      if (cfg) return cfg;
    }
    return get().getLLMConfig();
  },

  // Returns `null` rather than falling back to the chat config, because the
  // runtime already summarizes on the conversation's own model when it gets
  // no override — and an unresolvable pin (deleted provider) must degrade to
  // that same default rather than to whichever model is selected right now.
  getCompactionConfig: () => {
    const { compactionModel, providers, models } = get();
    if (!compactionModel) return null;
    return buildProviderConfigForSelection(compactionModel, providers, models);
  },
}));

/**
 * Resolves once the saved settings have been read out of the database.
 *
 * Anything that has to know a **persisted** setting before it acts has to wait
 * for this, and `auroraSurface` is the one that bites. The agent window's chat
 * store asks which product the window is on the moment it mounts — and React
 * runs a child's effect before its parent's, so the mount that fills the rail
 * happens before the mount that starts this load. Asking early gets the
 * default, not the answer, and nothing asks again when the real one lands.
 *
 * Starts the load if nothing has started it, so a caller cannot wait on
 * something that was never going to happen. It always resolves: a load that
 * fails still marks the store initialized, on defaults, because a window that
 * waits forever is worse than one showing the wrong default.
 */
export const whenSettingsReady = (): Promise<void> => {
  if (useSettingsStore.getState().isInitialized) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsubscribe = useSettingsStore.subscribe((state) => {
      if (!state.isInitialized) return;
      unsubscribe();
      resolve();
    });
    // No-op when a load is already running or finished.
    void useSettingsStore.getState().initializeFromDatabase();
  });
};

/**
 * Force any debounced settings write to flush immediately. Safe to call
 * when nothing is pending (no-op). Exposed for the unload flush below and
 * for callers that need a durable write before navigating away.
 */
export const flushSettingsSave = (): void => {
  if (!settingsSaveTimer) return;
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = null;
  const resolvers = settingsSaveResolvers;
  settingsSaveResolvers = [];
  void useSettingsStore
    .getState()
    .saveToDatabaseImmediate()
    .finally(() => {
      for (const r of resolvers) r();
    });
};

// Initialize settings from database when the module loads (for Tauri)
if (typeof window !== 'undefined') {
  // Wait for Tauri to be ready
  setTimeout(() => {
    useSettingsStore.getState().initializeFromDatabase();
  }, 100);

  // Flush any pending debounced save on unload so the last change inside
  // the debounce window isn't lost when the window closes.
  window.addEventListener('beforeunload', () => {
    flushSettingsSave();
  });
}
