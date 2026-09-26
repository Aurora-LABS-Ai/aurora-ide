import { withBuiltInImageProviders } from "@/apps/agent/services/providers/image-providers";
import { emptyProviderCategoryState } from "@/apps/agent/services/providers/provider-categories";
import { DEFAULT_SELECTED_MODEL } from "../provider-model";
import type { SettingsState } from "../state";
import {
  DEFAULT_COMPACTION_SUMMARY_BUDGET,
  DEFAULT_COMPACTION_THRESHOLD_PCT,
  DEFAULT_SPEECH_LIVE,
  DEFAULT_TOOL_APPROVAL_SETTINGS,
  LEGACY_GLOBAL_INSTRUCTION_PROFILE_ID,
  TEAM_SIZE_RECOMMENDED,
  type SpeechMode,
  type TitleMakerMode,
} from "../values";

/** Every stored setting's value before the database has been read. */
export const initialSettingsState = {
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

  // Tool Approval
  autoApproveTools: false,
  agentExecutionMode: "agent",
  // Aurora opens on the side that writes software. Chat is the deliberate trip.
  auroraSurface: "build",
  deepResearchNext: false,
  chatModelShortlist: [],
  // Seeded, not empty: the shipped a6api row exists before the database has
  // answered, so the rail never flashes an empty Image group on a cold start.
  providerCategories: emptyProviderCategoryState(),
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
  titleMakerLocalModel: '',
  titleMakerLocalChatFormat: 'auto',

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

  fireworksTabEnabled: false,
  fireworksAccountId: "",

  // Providers the user removed from the Providers page (presets re-seed
  // each launch, so removal is tracked here and filtered out on merge).
  removedProviderIds: [],
  // Preset models the user deleted — same mechanism, per model row.
  removedPresetModelIds: [],

  // Thinking Settings
  thinkingEnabled: true,

  // Max Tokens
  maxTokens: 8192,

  // Temperature
  temperature: 1.0,

  // Tool Settings
  maxToolCallsPerRequest: 25,
  toolApprovalSettings: { ...DEFAULT_TOOL_APPROVAL_SETTINGS },
  skillsEnabled: true,
  skillToggles: {},
  speechEnabled: false,
  speechEngine: "crispasr-gguf",
  speechRuntimePath: "",
  speechModelPath: "",
  speechBackend: "auto",
  speechDevicePreference: "auto",
  speechThreads: 4,
  speechLanguage: "auto",
  speechMode: "batch" as SpeechMode,
  speechLive: { ...DEFAULT_SPEECH_LIVE },
} satisfies Partial<SettingsState>;
