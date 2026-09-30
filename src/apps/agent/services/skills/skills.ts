import {
  deletePath,
  getGlobalSkillsPath,
  readDirectory,
  readFileContent,
} from "@/kernel/lib/ipc/tauri";

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
  /**
   * The skill's own folder, when it is stored as `<root>/<skill>/skill.md`
   * rather than as a loose `<root>/<skill>.md`.
   *
   * This is what makes deletion honest. A folder skill routinely carries far
   * more than its `skill.md` — `references/`, scripts, sample assets — so
   * removing the markdown alone would take the card off screen and leave the
   * bulk of the skill on disk.
   */
  sourceDir?: string;
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
  /** Set only for the `<root>/<skill>/skill.md` form. */
  containerDir?: string;
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

/**
 * Aurora ships no built-in *skills*.
 *
 * There used to be six here (typescript, react-frontend, tauri-rust,
 * mcp-integration, …), and they described Aurora's own stack rather than the
 * projects users open in it — noise in the catalogue the agent searches
 * whenever the workspace was Python, Go, or anything else.
 *
 * The one piece of built-in guidance Aurora does ship is the surface doctrine,
 * and it is deliberately NOT modelled as a skill: it is a standing instruction,
 * so it lives in the system prompt (`services/surface-doctrine.ts`) plus the
 * `design_guidelines` tool, where it cannot be listed, searched, toggled, or
 * deleted. Skills remain entirely user-owned: project and global.
 */
const BUILTIN_SKILLS: SkillDefinition[] = [];

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
  options: {
    fallbackId: string;
    source: SkillSource;
    sourceDir?: string;
    sourcePath?: string;
  }
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
    sourceDir: options.sourceDir,
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
            containerDir: entry.path,
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
            sourceDir: skillFile.containerDir,
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

// ── Deletion ─────────────────────────────────────────────────────────────────

export interface SkillDeleteTarget {
  /** `folder` means the skill's own directory and everything inside it. */
  kind: "file" | "folder";
  /** What will actually be removed from disk. */
  path: string;
}

/**
 * True when `target` sits STRICTLY inside `root`.
 *
 * Strictly, because a target equal to the skills root would mean deleting the
 * whole library, and no single skill's deletion is ever allowed to mean that.
 */
const isInsideRoot = (target: string, root: string): boolean => {
  const normalizedRoot = normalizeStoragePath(root).replace(/\/+$/, "");
  const normalizedTarget = normalizeStoragePath(target).replace(/\/+$/, "");
  if (!normalizedRoot || !normalizedTarget) {
    return false;
  }
  return normalizedTarget.startsWith(`${normalizedRoot}/`);
};

/** A `..` anywhere in the path can walk out of a root that `startsWith` says it is inside. */
const hasParentTraversal = (path: string): boolean =>
  normalizeStoragePath(path).split("/").includes("..");

/**
 * Work out what deleting a skill removes — and refuse if it isn't a skill.
 *
 * Deletion here is `remove_dir_all` on a user's own directory with no recycle
 * bin behind it, so the target is re-derived from the skill roots rather than
 * trusted from the record: the answer must be provably inside
 * `<project>/.aurora/skills`, `<project>/.agents/skills`, or the global skills
 * folder. Returns null when the skill is built in (nothing on disk to remove),
 * carries no path, or resolves anywhere else.
 */
export function resolveSkillDeleteTarget(
  skill: SkillDefinition,
  options?: {
    globalSkillsPath?: string | null;
    workspacePath?: string | null;
  },
): SkillDeleteTarget | null {
  if (skill.source === "builtin" || !skill.sourcePath) {
    return null;
  }

  const roots =
    skill.source === "workspace"
      ? options?.workspacePath
        ? WORKSPACE_SKILL_FOLDERS.map((folder) =>
            joinWorkspaceSubpath(options.workspacePath as string, folder),
          )
        : []
      : options?.globalSkillsPath
        ? [options.globalSkillsPath]
        : [];

  // The folder form owns everything beside its skill.md — references, scripts,
  // sample assets. Removing only the markdown would empty the card and leave
  // the skill on disk.
  const path = skill.sourceDir ?? skill.sourcePath;
  const kind: SkillDeleteTarget["kind"] = skill.sourceDir ? "folder" : "file";

  if (hasParentTraversal(path)) {
    return null;
  }
  if (!roots.some((root) => isInsideRoot(path, root))) {
    return null;
  }
  return { kind, path };
}

/**
 * Remove a skill from disk. Resolves the target through
 * {@link resolveSkillDeleteTarget} first and throws if it cannot be vouched
 * for, so a caller can never pass an arbitrary path through this door.
 */
export async function deleteSkillFromDisk(
  skill: SkillDefinition,
  options?: {
    globalSkillsPath?: string | null;
    workspacePath?: string | null;
  },
): Promise<SkillDeleteTarget> {
  const target = resolveSkillDeleteTarget(skill, options);
  if (!target) {
    throw new Error(
      `"${skill.name}" can't be deleted from here — it isn't stored in this project's or your global skills folder.`,
    );
  }
  await deletePath(target.path);
  return target;
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
 * Sentinel scope key used when no workspace is open. Per-workspace toggles
 * live under the normalized workspace root path; this bucket holds the
 * "no project" case so the shape stays uniform.
 */
export const GLOBAL_SKILL_SCOPE_KEY = "__global__";

/**
 * Normalize a workspace root path into the key used to bucket that project's
 * skill toggles. Skill enablement is **per workspace** — enabling a skill in
 * project A must never leak into project B, and the enabled-count / cap are
 * evaluated against the current project's bucket only.
 */
export function getSkillToggleScopeKey(workspacePath?: string | null): string {
  const trimmed = workspacePath?.trim();
  if (!trimmed) {
    return GLOBAL_SKILL_SCOPE_KEY;
  }
  return trimmed.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Pull the flat `{ storageKey: boolean }` bucket for a given workspace out of
 * the nested per-workspace toggle map. Returns an empty bucket when the
 * workspace has no recorded toggles yet.
 */
export function getWorkspaceSkillToggles(
  toggles: Record<string, Record<string, boolean>> | undefined,
  workspacePath?: string | null,
): Record<string, boolean> {
  if (!toggles) {
    return {};
  }
  return toggles[getSkillToggleScopeKey(workspacePath)] ?? {};
}

/**
 * Determine whether a given skill is enabled for prompt injection.
 *
 * **Default-off semantics:** when the user has never interacted with a
 * skill's toggle, it is treated as DISABLED. The user explicitly opts in
 * from the Skills settings tab. `skillToggles` here is the *flat bucket* for
 * the current workspace (see {@link getWorkspaceSkillToggles}).
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
  // Every word scores on its own, so "node test runner typescript" finds the
  // TypeScript skill by its one matching word. The whole phrase was the only
  // needle before, and a four-word query matched nothing in a 293-skill catalog
  // while any one of its words would have.
  const words = Array.from(new Set(needle.split(/\s+/).filter(Boolean)));
  const scored = candidates
    .map((skill) => ({
      score:
        words.reduce((sum, word) => sum + scoreSkillMatch(skill, word), 0) +
        (words.length > 1 ? scoreSkillMatch(skill, needle) : 0),
      skill,
    }))
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
