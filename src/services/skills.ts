import { getGlobalSkillsPath, readDirectory, readFileContent } from "../lib/tauri";

export type SkillSource = 'builtin' | 'workspace' | 'global';

export interface SkillDefinition {
  content: string;
  description: string;
  id: string;
  name: string;
  /**
   * First five non-empty lines of the skill body, intended for the inline
   * catalog preview the agent sees in the prompt. The full content is loaded
   * on demand via `aurora_skill_load`.
   */
  previewLines: string[];
  source: SkillSource;
  sourcePath?: string;
  storageKey: string;
  triggers: string[];
}

export interface ResolveSkillsOptions {
  enabledSkillToggles?: Record<string, boolean>;
  explicitSkillKeys?: string[];
  globalSkillsPath?: string | null;
  /**
   * Hard cap on auto-injected skills. Defaults to {@link MAX_ENABLED_SKILLS}.
   * Explicit per-message attachments are not affected by this cap; they are
   * always included.
   */
  maxActiveSkills?: number;
  skillsEnabled?: boolean;
  userMessage?: string;
  workspacePath?: string | null;
}

export interface ResolvedSkills {
  /** All discovered skill candidates (built-in + workspace + global). */
  allSkills: SkillDefinition[];
  /**
   * Skills the agent should treat as authoritative this turn. This is the
   * union of explicit attachments and toggle-on skills, deduped and capped.
   */
  activeSkills: SkillDefinition[];
  /** Skills the user toggled ON in settings, capped at {@link MAX_ENABLED_SKILLS}. */
  enabledSkills: SkillDefinition[];
  /** Skills explicitly attached to this turn (e.g. via @-mention). */
  explicitSkills: SkillDefinition[];
}

interface ParsedFrontmatter {
  body: string;
  metadata: Record<string, string | string[]>;
}

interface SkillFileCandidate {
  fallbackId: string;
  filePath: string;
}

/**
 * Workspace folders we scan for project-scoped skills, in priority order.
 * `.aurora/skills` is the canonical Aurora location; `.agents/skills` is the
 * shared convention used by other agentic tools so projects don't have to
 * duplicate skills across ecosystems. Both are dotfile directories so they
 * stay out of the workspace's regular file tree.
 */
export const WORKSPACE_SKILL_FOLDERS = [".aurora/skills", ".agents/skills"] as const;

/**
 * Maximum number of toggle-on skills auto-injected into the agent prompt.
 * Beyond this cap, the agent must use the discovery tools (`aurora_skill_search`
 * / `aurora_skill_load`) to pull in additional skills. Explicit attachments
 * bypass this cap.
 */
export const MAX_ENABLED_SKILLS = 10;

/**
 * Number of leading non-empty body lines surfaced as a preview in the agent
 * prompt. The agent loads the full content on demand.
 */
export const SKILL_PREVIEW_LINE_COUNT = 5;

const SKILL_FILE_NAME = "skill.md";
let cachedGlobalSkillsPath: string | null | undefined;

const BUILTIN_SKILL_BASE: Array<Omit<SkillDefinition, "previewLines" | "storageKey">> = [
  {
    id: "project-overview",
    name: "Project Overview",
    description: "Map project architecture, entry points, data flow, and where core behavior lives before changing code.",
    triggers: [
      "architecture",
      "codebase",
      "project overview",
      "how does this work",
      "where is",
      "understand project",
      "flow",
    ],
    source: "builtin",
    content: `Use this skill when the task is primarily about understanding an unfamiliar codebase.

Focus on:
- Entry points and runtime flow
- Store/service/component boundaries
- Provider and tool integration points
- Where to make the smallest correct change

Prefer reading a few high-signal files over scanning everything. Summaries should explain where behavior is implemented, not just list files.`,
  },
  {
    id: "typescript",
    name: "TypeScript",
    description: "Apply type-safe, idiomatic TypeScript patterns and keep interfaces precise.",
    triggers: [
      "typescript",
      "type-safe",
      "type safety",
      "typing",
      "tsconfig",
      "zustand",
      "tsx",
    ],
    source: "builtin",
    content: `Use this skill for TypeScript and TSX work.

Guidelines:
- Prefer strict types over any-shaped payloads
- Let inference work when obvious, but model public interfaces explicitly
- Use async/await and Promise.all where concurrency is safe
- Keep function contracts narrow and descriptive
- Avoid adding redundant abstractions for small tasks`,
  },
  {
    id: "react-frontend",
    name: "React Frontend",
    description: "Work on React UI, component structure, state flow, and responsive editor/chat surfaces.",
    triggers: [
      "react",
      "frontend",
      "component",
      "hook",
      "ui",
      "layout",
      "tailwind",
      "monaco",
    ],
    source: "builtin",
    content: `Use this skill for React UI changes.

Guidelines:
- Preserve established component patterns in the repo
- Keep state colocated unless it is clearly shared app state
- Respect the centralized theme/token system
- Prefer small, composable changes over broad rewrites
- Make mobile and narrow-panel behavior explicit when touching layout`,
  },
  {
    id: "tauri-rust",
    name: "Tauri Rust Bridge",
    description: "Handle Tauri IPC, Rust command boundaries, and frontend/backend integration.",
    triggers: [
      "tauri",
      "rust",
      "src-tauri",
      "ipc",
      "invoke",
      "command",
      "plugin",
    ],
    source: "builtin",
    content: `Use this skill for Tauri and Rust-backed features.

Guidelines:
- Trace the full path: frontend service -> invoke() -> Rust command -> backend service
- Keep TypeScript and Rust payload shapes aligned
- Prefer additive command changes over breaking existing IPC contracts
- Be explicit about desktop-only behavior and Tauri runtime assumptions`,
  },
  {
    id: "mcp-integration",
    name: "MCP Integration",
    description: "Extend agent capabilities through MCP server registration, naming, approval, and execution flow.",
    triggers: [
      "mcp",
      "model context protocol",
      "server tools",
      "tool registry",
      "marketplace",
      "external tools",
    ],
    source: "builtin",
    content: `Use this skill when the task involves external tool ecosystems or capability expansion through MCP.

Focus on:
- Tool discovery and registration
- Naming and capability summaries
- Approval and safety behavior
- Execution flow and result formatting

When comparing MCP and skills, keep clear separation between instruction overlays and executable external tools.`,
  },
  {
    id: "testing-debugging",
    name: "Testing And Debugging",
    description: "Drive changes with targeted validation, diagnostics, and bug-oriented reasoning.",
    triggers: [
      "test",
      "tests",
      "debug",
      "bug",
      "failing",
      "error",
      "regression",
      "verify",
    ],
    source: "builtin",
    content: `Use this skill when investigating failures or validating edits.

Guidelines:
- Reproduce the issue with the narrowest possible signal
- Prefer existing diagnostics, lints, and tests before adding more instrumentation
- State what was verified and what remains unverified
- If behavior is prompt-driven, distinguish prompt guidance from hard enforcement`,
  },
];

const BUILTIN_SKILLS: SkillDefinition[] = BUILTIN_SKILL_BASE.map((skill) => ({
  ...skill,
  previewLines: extractPreviewLines(skill.content),
  storageKey: `builtin:${skill.id}`,
}));

const normalize = (value: string): string => value.trim().toLowerCase();

const normalizeStorageKey = (value: string): string =>
  value.trim().replace(/\\/g, "/").toLowerCase();

const uniqueStrings = (values: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = normalize(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(value.trim());
  }

  return result;
};

const splitInlineList = (value: string): string[] =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const normalizeStoragePath = (path: string): string =>
  path.replace(/\\/g, "/").toLowerCase();

const createStorageKey = (source: SkillSource, sourcePath: string | undefined, fallbackId: string): string =>
  sourcePath ? `${source}:${normalizeStoragePath(sourcePath)}` : `${source}:${normalize(fallbackId).replace(/\s+/g, "-")}`;

const joinWorkspaceSubpath = (workspacePath: string, subpath: string): string => {
  const usesWindows = workspacePath.includes("\\");
  const normalizedSub = usesWindows ? subpath.replace(/\//g, "\\") : subpath;
  const sep = usesWindows ? "\\" : "/";
  return workspacePath.endsWith(sep)
    ? `${workspacePath}${normalizedSub}`
    : `${workspacePath}${sep}${normalizedSub}`;
};

const isSkillMarkdownFile = (name: string): boolean =>
  name.toLowerCase() === SKILL_FILE_NAME;

/**
 * Extract the first {@link SKILL_PREVIEW_LINE_COUNT} non-empty lines from a
 * skill body, trimming horizontal whitespace. Heading-only lines (e.g. `#`)
 * still count, since they're meaningful in markdown skill structure.
 */
export function extractPreviewLines(body: string, limit: number = SKILL_PREVIEW_LINE_COUNT): string[] {
  if (!body) {
    return [];
  }
  const out: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    out.push(line);
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

function parseFrontmatter(document: string): ParsedFrontmatter {
  if (!document.startsWith("---")) {
    return { metadata: {}, body: document.trim() };
  }

  const endMarker = "\n---";
  const endIndex = document.indexOf(endMarker, 3);
  if (endIndex === -1) {
    return { metadata: {}, body: document.trim() };
  }

  const rawFrontmatter = document.slice(3, endIndex).trim();
  const body = document.slice(endIndex + endMarker.length).trim();
  const metadata: Record<string, string | string[]> = {};
  let currentArrayKey: string | null = null;

  for (const rawLine of rawFrontmatter.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("- ") && currentArrayKey) {
      const existing = metadata[currentArrayKey];
      const nextValue = line.slice(2).trim();
      if (Array.isArray(existing)) {
        existing.push(nextValue);
      } else {
        metadata[currentArrayKey] = [nextValue];
      }
      continue;
    }

    currentArrayKey = null;
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = normalize(line.slice(0, separatorIndex));
    const rawValue = line.slice(separatorIndex + 1).trim();

    if (!rawValue) {
      metadata[key] = [];
      currentArrayKey = key;
      continue;
    }

    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      metadata[key] = splitInlineList(rawValue.slice(1, -1));
      continue;
    }

    metadata[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }

  return { metadata, body };
}

export function parseSkillDocument(
  document: string,
  options: { fallbackId: string; source: SkillSource; sourcePath?: string }
): SkillDefinition | null {
  const { metadata, body } = parseFrontmatter(document);
  const name = typeof metadata.name === "string" ? metadata.name.trim() : options.fallbackId;
  const description =
    typeof metadata.description === "string" && metadata.description.trim()
      ? metadata.description.trim()
      : "No description provided.";
  const triggerMetadata = metadata.triggers;
  const triggers = Array.isArray(triggerMetadata)
    ? triggerMetadata
    : typeof triggerMetadata === "string"
      ? splitInlineList(triggerMetadata)
      : [];
  const content = body.trim();

  if (!content) {
    return null;
  }

  return {
    id: normalize(
      typeof metadata.id === "string" && metadata.id.trim() ? metadata.id : options.fallbackId
    ).replace(/\s+/g, "-"),
    name,
    description,
    triggers: uniqueStrings(triggers),
    content,
    previewLines: extractPreviewLines(content),
    source: options.source,
    sourcePath: options.sourcePath,
    storageKey: createStorageKey(options.source, options.sourcePath, options.fallbackId),
  };
}

async function discoverSkillFiles(rootPath: string): Promise<SkillFileCandidate[]> {
  const entries = await readDirectory(rootPath, { includeHidden: true });
  const skillFiles: SkillFileCandidate[] = [];

  for (const entry of entries) {
    if (entry.is_dir) {
      try {
        const folderEntries = await readDirectory(entry.path, { includeHidden: true });
        const skillFile = folderEntries.find((item) => item.is_file && isSkillMarkdownFile(item.name));
        if (skillFile) {
          skillFiles.push({
            fallbackId: entry.name,
            filePath: skillFile.path,
          });
        }
      } catch (error) {
        console.warn(`[Skills] Failed to read skill directory ${entry.path}:`, error);
      }
      continue;
    }

    if (entry.is_file && entry.name.endsWith(".md")) {
      skillFiles.push({
        fallbackId: entry.name.replace(/\.md$/i, ""),
        filePath: entry.path,
      });
    }
  }

  return skillFiles;
}

async function loadSkillsFromRoot(
  rootPath: string | null | undefined,
  source: Extract<SkillSource, "workspace" | "global">
): Promise<SkillDefinition[]> {
  if (!rootPath) {
    return [];
  }

  try {
    const skillFiles = await discoverSkillFiles(rootPath);
    const loadedSkills = await Promise.all(
      skillFiles.map(async (skillFile) => {
        try {
          const document = await readFileContent(skillFile.filePath);
          return parseSkillDocument(document, {
            fallbackId: skillFile.fallbackId,
            source,
            sourcePath: skillFile.filePath,
          });
        } catch (error) {
          console.warn(`[Skills] Failed to read ${source} skill ${skillFile.filePath}:`, error);
          return null;
        }
      })
    );

    return loadedSkills
      .filter((skill): skill is SkillDefinition => skill !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

export async function getResolvedGlobalSkillsPath(): Promise<string | null> {
  if (cachedGlobalSkillsPath !== undefined) {
    return cachedGlobalSkillsPath;
  }

  cachedGlobalSkillsPath = await getGlobalSkillsPath();
  return cachedGlobalSkillsPath;
}

/**
 * Load workspace skills from every {@link WORKSPACE_SKILL_FOLDERS} root,
 * de-duplicating by storage key (paths are normalized first). Folders earlier
 * in the array take precedence on conflict.
 */
export async function loadWorkspaceSkills(workspacePath?: string | null): Promise<SkillDefinition[]> {
  if (!workspacePath) {
    return [];
  }

  const folderSkillSets = await Promise.all(
    WORKSPACE_SKILL_FOLDERS.map((folder) =>
      loadSkillsFromRoot(joinWorkspaceSubpath(workspacePath, folder), "workspace")
    )
  );

  const seenKeys = new Set<string>();
  const merged: SkillDefinition[] = [];
  for (const skillSet of folderSkillSets) {
    for (const skill of skillSet) {
      const dedupeKey = normalizeStorageKey(skill.storageKey);
      if (seenKeys.has(dedupeKey)) {
        continue;
      }
      seenKeys.add(dedupeKey);
      merged.push(skill);
    }
  }

  return merged.sort((left, right) => left.name.localeCompare(right.name));
}

export async function loadGlobalSkills(globalSkillsPath?: string | null): Promise<SkillDefinition[]> {
  const resolvedGlobalPath = globalSkillsPath ?? await getResolvedGlobalSkillsPath();
  return loadSkillsFromRoot(resolvedGlobalPath, "global");
}

export function getBuiltinSkills(): SkillDefinition[] {
  return [...BUILTIN_SKILLS];
}

/**
 * Load every discoverable skill (built-in + workspace + global) without
 * applying any toggle/master-switch filtering. This is the canonical view for
 * tools (`aurora_skill_search`, `aurora_skill_load`) and for explicit
 * attachment lookups, both of which must work even when a skill is toggled
 * off in settings.
 */
export async function loadAllSkillCandidates(options?: {
  globalSkillsPath?: string | null;
  workspacePath?: string | null;
}): Promise<SkillDefinition[]> {
  const [workspaceSkills, globalSkills] = await Promise.all([
    loadWorkspaceSkills(options?.workspacePath),
    loadGlobalSkills(options?.globalSkillsPath),
  ]);

  return [...BUILTIN_SKILLS, ...workspaceSkills, ...globalSkills];
}

/**
 * Determine whether a given skill is enabled for prompt injection.
 *
 * **Default-off semantics:** when the user has never interacted with a
 * skill's toggle, it is treated as DISABLED. The user explicitly opts in
 * from the Skills settings tab.
 */
export function isSkillEnabled(
  skill: SkillDefinition,
  skillToggles?: Record<string, boolean>,
  skillsEnabled = true
): boolean {
  if (!skillsEnabled) {
    return false;
  }

  return skillToggles?.[skill.storageKey] ?? false;
}

/**
 * Filter a list of skills by toggle state, capping at {@link MAX_ENABLED_SKILLS}.
 * Order is preserved, so callers control the priority via the input order.
 */
export function filterEnabledSkills(
  skills: SkillDefinition[],
  options?: {
    enabledSkillToggles?: Record<string, boolean>;
    maxActiveSkills?: number;
    skillsEnabled?: boolean;
  }
): SkillDefinition[] {
  const cap = Math.max(0, options?.maxActiveSkills ?? MAX_ENABLED_SKILLS);
  if (cap === 0) {
    return [];
  }

  const enabled: SkillDefinition[] = [];
  for (const skill of skills) {
    if (!isSkillEnabled(skill, options?.enabledSkillToggles, options?.skillsEnabled)) {
      continue;
    }
    enabled.push(skill);
    if (enabled.length >= cap) {
      break;
    }
  }
  return enabled;
}

export async function getSkillCatalog(options?: {
  enabledSkillToggles?: Record<string, boolean>;
  globalSkillsPath?: string | null;
  skillsEnabled?: boolean;
  workspacePath?: string | null;
}): Promise<SkillDefinition[]> {
  const allSkills = await loadAllSkillCandidates(options);
  return allSkills.filter((skill) =>
    isSkillEnabled(skill, options?.enabledSkillToggles, options?.skillsEnabled ?? true)
  );
}

export async function resolveSkillsForPrompt(
  options: ResolveSkillsOptions
): Promise<ResolvedSkills> {
  const {
    workspacePath,
    globalSkillsPath,
    enabledSkillToggles,
    explicitSkillKeys,
    skillsEnabled = true,
    maxActiveSkills = MAX_ENABLED_SKILLS,
  } = options;

  const allSkills = await loadAllSkillCandidates({ workspacePath, globalSkillsPath });

  const normalizedExplicitKeys = new Set(
    (explicitSkillKeys ?? [])
      .map((key) => normalizeStorageKey(key))
      .filter(Boolean)
  );
  const explicitSkills =
    normalizedExplicitKeys.size === 0
      ? []
      : allSkills.filter((skill) =>
          normalizedExplicitKeys.has(normalizeStorageKey(skill.storageKey))
        );

  const enabledSkills = filterEnabledSkills(allSkills, {
    enabledSkillToggles,
    maxActiveSkills,
    skillsEnabled,
  });

  const explicitKeySet = new Set(
    explicitSkills.map((skill) => normalizeStorageKey(skill.storageKey))
  );
  const activeSkills = [
    ...explicitSkills,
    ...enabledSkills.filter((skill) => !explicitKeySet.has(normalizeStorageKey(skill.storageKey))),
  ];

  return {
    allSkills,
    activeSkills,
    enabledSkills,
    explicitSkills,
  };
}

/**
 * Find a single skill by id within the unfiltered candidate list. Used by the
 * `aurora_skill_load` tool so the agent can pull in a skill that isn't
 * toggled on in settings.
 */
export async function findSkillById(
  id: string,
  options?: {
    globalSkillsPath?: string | null;
    workspacePath?: string | null;
  }
): Promise<SkillDefinition | null> {
  const normalizedId = normalize(id).replace(/\s+/g, "-");
  if (!normalizedId) {
    return null;
  }

  const candidates = await loadAllSkillCandidates(options);
  return (
    candidates.find((skill) => skill.id === normalizedId) ??
    candidates.find(
      (skill) => normalizeStorageKey(skill.storageKey) === normalizeStorageKey(id)
    ) ??
    null
  );
}

export interface SkillSearchResult {
  description: string;
  id: string;
  name: string;
  source: SkillSource;
  sourcePath?: string;
  triggers: string[];
}

/**
 * Search the unfiltered skill catalog by id/name/description/trigger match.
 * Used by the `aurora_skill_search` tool. With no query, returns up to
 * `limit` candidates.
 */
export async function searchSkillCandidates(
  query?: string | null,
  limit: number = 30,
  options?: {
    globalSkillsPath?: string | null;
    workspacePath?: string | null;
  }
): Promise<SkillSearchResult[]> {
  const candidates = await loadAllSkillCandidates(options);
  const cap = Math.max(1, Math.min(limit, 100));
  const trimmedQuery = query?.trim() ?? "";

  if (!trimmedQuery) {
    return candidates.slice(0, cap).map(toSearchResult);
  }

  const needle = trimmedQuery.toLowerCase();
  const scored = candidates
    .map((skill) => ({ score: scoreSkillMatch(skill, needle), skill }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score || left.skill.name.localeCompare(right.skill.name)
    )
    .slice(0, cap)
    .map((entry) => toSearchResult(entry.skill));

  return scored;
}

function toSearchResult(skill: SkillDefinition): SkillSearchResult {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    sourcePath: skill.sourcePath,
    triggers: skill.triggers,
  };
}

function scoreSkillMatch(skill: SkillDefinition, needle: string): number {
  let score = 0;
  if (skill.id.includes(needle)) score += 50;
  if (skill.name.toLowerCase().includes(needle)) score += 30;
  if (skill.description.toLowerCase().includes(needle)) score += 15;
  for (const trigger of skill.triggers) {
    if (trigger.toLowerCase().includes(needle)) {
      score += 8;
      break;
    }
  }
  return score;
}
