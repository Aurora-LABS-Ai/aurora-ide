/**
 * Agent settings constants, clamps and normalizers — the pure values the agent
 * settings store and its consumers share. Re-exported from
 * `useAgentSettingsStore`.
 */
import type { GlobalInstructionProfile } from "@/kernel/types/database";

export const countEnabledSkillToggles = (toggles: Record<string, boolean>): number => {
  let count = 0;
  for (const value of Object.values(toggles)) {
    if (value === true) count += 1;
  }
  return count;
};

// Agent Team — the user-configured ceiling on how many agents the Lead may
// convene per task. Hard ceiling is 16, recommended value is 5 (see
// DOCS/aurora-agent-team-ground-truth.md §11). The Lead never exceeds this.
export const TEAM_SIZE_HARD_CEILING = 16;
export const TEAM_SIZE_RECOMMENDED = 5;
export const clampTeamSize = (value: number): number =>
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

export const clampProfileName = (name: string): string =>
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

/** When dictated words reach the composer. */
export type SpeechMode = 'batch' | 'live';

/**
 * Live dictation settings — the user's own audio.cpp build running
 * Confucius4-R2T2. Grouped rather than spread across the store because they
 * configure one program, and every flat field here costs an edit in nine
 * places across TypeScript and Rust.
 */
export interface SpeechLiveSettings {
  /** `audiocpp_cli` itself, or the folder holding it. */
  runtimePath: string;
  /** The `.gguf` model file. */
  modelPath: string;
  /**
   * Extra folder to put on the program's PATH. CUDA 13 keeps its runtime files
   * in `bin\x64` rather than `bin`, and without them the program dies the
   * moment it starts with no message.
   */
  libraryPath: string;
  /** `auto`, `cuda`, `vulkan` or `cpu`. */
  backend: string;
  /** How much audio the model takes at a time, 80-2000 ms. */
  chunkMs: number;
  /**
   * How many words the model keeps back until it is sure of them. They arrive
   * when you press stop. Lower shows text sooner but risks keeping a wrong
   * word, because text already shown is never taken back.
   */
  holdBack: number;
  /**
   * Seconds of no dictation before the loaded model is released. It holds
   * about 2.3 GB of video memory while it waits. 0 keeps it loaded.
   */
  idleSeconds: number;
}

export const DEFAULT_SPEECH_LIVE: SpeechLiveSettings = {
  runtimePath: '',
  modelPath: '',
  libraryPath: '',
  backend: 'auto',
  chunkMs: 320,
  holdBack: 2,
  idleSeconds: 300,
};

/** Fill in anything a stored value is missing, so an older row still loads. */
export function normalizeSpeechLive(value: unknown): SpeechLiveSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_SPEECH_LIVE };
  const raw = value as Partial<SpeechLiveSettings>;
  const int = (n: unknown, fallback: number, min: number, max: number) =>
    typeof n === 'number' && Number.isFinite(n)
      ? Math.min(max, Math.max(min, Math.round(n)))
      : fallback;
  return {
    runtimePath: typeof raw.runtimePath === 'string' ? raw.runtimePath : '',
    modelPath: typeof raw.modelPath === 'string' ? raw.modelPath : '',
    libraryPath: typeof raw.libraryPath === 'string' ? raw.libraryPath : '',
    backend: typeof raw.backend === 'string' && raw.backend ? raw.backend : 'auto',
    chunkMs: int(raw.chunkMs, DEFAULT_SPEECH_LIVE.chunkMs, 80, 2000),
    holdBack: int(raw.holdBack, DEFAULT_SPEECH_LIVE.holdBack, 1, 16),
    idleSeconds: int(raw.idleSeconds, DEFAULT_SPEECH_LIVE.idleSeconds, 0, 86_400),
  };
}

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
export const clampCompactionThreshold = (value: number): number =>
  Math.min(
    COMPACTION_THRESHOLD_MAX,
    Math.max(COMPACTION_THRESHOLD_MIN, Math.round(value) || DEFAULT_COMPACTION_THRESHOLD_PCT),
  );
export const clampCompactionBudget = (value: number): number =>
  Math.min(
    COMPACTION_SUMMARY_BUDGET_MAX,
    Math.max(COMPACTION_SUMMARY_BUDGET_MIN, Math.round(value) || DEFAULT_COMPACTION_SUMMARY_BUDGET),
  );

export const normalizeSpeechRuntimePath = (value?: string | null): string => {
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
export const normalizeChatShortlist = (value: unknown): string[] => {
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

export const DEFAULT_TOOL_APPROVAL_SETTINGS: Record<string, 'auto' | 'always_ask' | 'deny'> = {
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
