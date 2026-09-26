import type { StoreApi } from "zustand";

import type { AgentExecutionMode, AuroraSurface } from "@/apps/agent/services/runtime/agent-execution-mode";
import type { ImageModel, ImageProvider } from "@/apps/agent/services/providers/image-providers";
import type { CategoryColor, ProviderCategoryState } from "@/apps/agent/services/providers/provider-categories";
import type { ProviderConfig } from "@/kernel/services/providers/types";
import type { GlobalInstructionProfile } from "@/kernel/types/database";
import type { LLMModel, LLMProvider, ResolvedLLMModel } from "./provider-model";
import type { SpeechLiveSettings, SpeechMode, TitleMakerMode, WorkspaceAccess } from "./values";

// ============================================
// SETTINGS STATE TYPES
// ============================================
export interface SettingsState {
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
   * The folders the user files providers into, and which provider is in which.
   *
   * Persisted with the settings rather than in localStorage (where pinning
   * lives), because a category is a fact about the account: it names what a
   * provider is FOR, and it groups the model selector as well as the settings
   * rail. See `services/providers/provider-categories.ts` for the rules — most
   * importantly that a provider is in exactly one category, and that the two
   * seeded ones cannot be renamed or deleted because every provider needs a
   * home.
   */
  providerCategories: ProviderCategoryState;
  /** Make a category. Returns its id, or `null` when the name is empty or taken. */
  createProviderCategory: (name: string, color?: CategoryColor) => string | null;
  /** Rename one. Returns false when the name is empty, taken, or the row is a seed. */
  renameProviderCategory: (id: string, name: string) => boolean;
  setProviderCategoryColor: (id: string, color: CategoryColor) => void;
  /** Delete one. Its providers return to their unfiled home; nothing is lost. */
  deleteProviderCategory: (id: string) => void;
  moveProviderCategory: (id: string, direction: -1 | 1) => void;
  /** File a provider under a category, or unfile it with `null`. */
  setProviderCategory: (providerId: string, categoryId: string | null) => void;

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
  /** Local mode only. Empty = reuse the prompt-refine model, which is what
   *  local mode has always done. Set it to point titling at its own GGUF while
   *  both features keep sharing one llama.cpp folder. */
  titleMakerLocalModel: string;
  /** Chat format for `titleMakerLocalModel` (a `ChatFormat` wire name). */
  titleMakerLocalChatFormat: string;
  setTitleMaker: (
    value: Partial<{
      enabled: boolean;
      mode: TitleMakerMode;
      baseUrl: string;
      apiKey: string;
      model: string;
      localModel: string;
      localChatFormat: string;
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
  /** Browser access for new turns, enabled by default. Available browser
   * tools are discovered on demand; switching this off removes the bucket. */
  browserTools: boolean;
  setBrowserTools: (value: boolean) => void;
  /** Legacy persisted preference. Optional discovery is always enabled. */
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
  /**
   * When words appear. `batch` records everything and transcribes on stop
   * (CrispASR); `live` shows them while you talk (audio.cpp Confucius4-R2T2).
   * Two different programs, so each keeps its own paths.
   */
  speechMode: SpeechMode;
  speechModelPath: string;
  speechRuntimePath: string;
  speechThreads: number;
  /** Settings for live dictation. Grouped because they configure one program. */
  speechLive: SpeechLiveSettings;

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
  setFireworksAccountId: (accountId: string) => void;
  setFireworksTabEnabled: (enabled: boolean) => void;
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
  setSpeechMode: (mode: SpeechMode) => void;
  /** Change some live-dictation settings; the rest keep their values. */
  setSpeechLive: (patch: Partial<SpeechLiveSettings>) => void;
  setSpeechModelPath: (path: string) => void;
  setSpeechRuntimePath: (path: string) => void;
  setSpeechThreads: (threads: number) => void;
  setSyntaxValidationEnabled: (value: boolean) => void;
  setTemperature: (temp: number) => void;
  setThinkingEnabled: (enabled: boolean) => void;
  setToolApproval: (toolName: string, setting: 'auto' | 'always_ask' | 'deny') => void;

  // Agent Guardrails
  syntaxValidationEnabled: boolean; // Pre-save syntax validation

  // Temperature
  temperature: number;

  // Thinking Settings
  thinkingEnabled: boolean;
  toolApprovalSettings: Record<string, 'auto' | 'always_ask' | 'deny'>;

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
}

/** `set` and `get` as every settings slice receives them. */
export type SettingsSet = StoreApi<SettingsState>["setState"];
export type SettingsGet = StoreApi<SettingsState>["getState"];
