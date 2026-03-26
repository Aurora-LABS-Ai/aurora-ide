import { getGlobalSkillsPath, readDirectory, readFileContent } from "../lib/tauri";

export type SkillSource = 'builtin' | 'workspace' | 'global';

export interface SkillDefinition {
  content: string;
  description: string;
  id: string;
  name: string;
  source: SkillSource;
  sourcePath?: string;
  storageKey: string;
  triggers: string[];
}

export interface ResolveSkillsOptions {
  enabledSkillToggles?: Record<string, boolean>;
  explicitSkillKeys?: string[];
  globalSkillsPath?: string | null;
  maxActiveSkills?: number;
  skillsEnabled?: boolean;
  userMessage: string;
  workspacePath?: string | null;
}

export interface ResolvedSkills {
  activeSkills: SkillDefinition[];
  allSkills: SkillDefinition[];
}

interface ParsedFrontmatter {
  body: string;
  metadata: Record<string, string | string[]>;
}

interface SkillFileCandidate {
  fallbackId: string;
  filePath: string;
}

const WORKSPACE_SKILLS_FOLDER = ".aurora/skills";
const SKILL_FILE_NAME = "skill.md";
let cachedGlobalSkillsPath: string | null | undefined;

const BUILTIN_SKILL_BASE: Array<Omit<SkillDefinition, "storageKey">> = [
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
  storageKey: `builtin:${skill.id}`,
}));

const normalize = (value: string): string => value.trim().toLowerCase();

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

const toWorkspaceSkillsPath = (workspacePath: string): string =>
  workspacePath.includes("\\")
    ? `${workspacePath}\\${WORKSPACE_SKILLS_FOLDER.replace("/", "\\")}`
    : `${workspacePath}/${WORKSPACE_SKILLS_FOLDER}`;

const isSkillMarkdownFile = (name: string): boolean =>
  name.toLowerCase() === SKILL_FILE_NAME;

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

export async function loadWorkspaceSkills(workspacePath?: string | null): Promise<SkillDefinition[]> {
  return loadSkillsFromRoot(workspacePath ? toWorkspaceSkillsPath(workspacePath) : null, "workspace");
}

export async function loadGlobalSkills(globalSkillsPath?: string | null): Promise<SkillDefinition[]> {
  const resolvedGlobalPath = globalSkillsPath ?? await getResolvedGlobalSkillsPath();
  return loadSkillsFromRoot(resolvedGlobalPath, "global");
}

export function getBuiltinSkills(): SkillDefinition[] {
  return [...BUILTIN_SKILLS];
}

export function isSkillEnabled(
  skill: SkillDefinition,
  skillToggles?: Record<string, boolean>,
  skillsEnabled = true
): boolean {
  if (!skillsEnabled) {
    return false;
  }

  return skillToggles?.[skill.storageKey] ?? true;
}

export async function getSkillCatalog(options?: {
  enabledSkillToggles?: Record<string, boolean>;
  globalSkillsPath?: string | null;
  skillsEnabled?: boolean;
  workspacePath?: string | null;
}): Promise<SkillDefinition[]> {
  const { workspacePath, globalSkillsPath, enabledSkillToggles, skillsEnabled = true } = options ?? {};
  const [workspaceSkills, globalSkills] = await Promise.all([
    loadWorkspaceSkills(workspacePath),
    loadGlobalSkills(globalSkillsPath),
  ]);
  const allSkills = [...BUILTIN_SKILLS, ...workspaceSkills, ...globalSkills];

  return allSkills.filter((skill) => isSkillEnabled(skill, enabledSkillToggles, skillsEnabled));
}

function scoreSkill(skill: SkillDefinition, normalizedMessage: string): number {
  let score = 0;
  const normalizedName = normalize(skill.name);

  if (
    normalizedMessage.includes(`$${skill.id}`) ||
    normalizedMessage.includes(`skill ${skill.id}`) ||
    normalizedMessage.includes(`$${normalizedName}`)
  ) {
    score += 100;
  }

  if (normalizedMessage.includes(skill.id)) {
    score += 40;
  }

  if (normalizedMessage.includes(normalizedName)) {
    score += 30;
  }

  for (const trigger of skill.triggers) {
    const normalizedTrigger = normalize(trigger);
    if (!normalizedTrigger) {
      continue;
    }
    if (normalizedMessage.includes(normalizedTrigger)) {
      score += normalizedTrigger.includes(" ") ? 14 : 8;
    }
  }

  return score;
}

export async function resolveSkillsForPrompt(
  options: ResolveSkillsOptions
): Promise<ResolvedSkills> {
  const {
    userMessage,
    workspacePath,
    globalSkillsPath,
    enabledSkillToggles,
    explicitSkillKeys,
    skillsEnabled = true,
    maxActiveSkills = 4,
  } = options;
  const allSkills = await getSkillCatalog({
    workspacePath,
    globalSkillsPath,
    enabledSkillToggles,
    skillsEnabled,
  });
  const normalizedMessage = normalize(userMessage);
  const normalizedExplicitKeys = new Set((explicitSkillKeys ?? []).map((key) => key.trim()).filter(Boolean));

  if (normalizedExplicitKeys.size > 0) {
    const activeSkills = allSkills.filter((skill) => normalizedExplicitKeys.has(skill.storageKey));

    return {
      allSkills,
      activeSkills,
    };
  }

  const activeSkills = allSkills
    .map((skill) => ({ score: scoreSkill(skill, normalizedMessage), skill }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
    .slice(0, maxActiveSkills)
    .map((entry) => entry.skill);

  return {
    allSkills,
    activeSkills,
  };
}

function formatSkillSource(source: SkillSource): string {
  if (source === "workspace") {
    return "project";
  }

  return source;
}

export function formatSkillCatalog(skills: SkillDefinition[]): string {
  if (skills.length === 0) {
    return "No enabled skills available.";
  }

  return skills
    .map((skill) => {
      const triggerSuffix = skill.triggers.length > 0 ? ` Triggers: ${skill.triggers.join(", ")}.` : "";
      return `- \`${skill.id}\` (${formatSkillSource(skill.source)}): ${skill.description}${triggerSuffix}`;
    })
    .join("\n");
}

export function formatActiveSkills(skills: SkillDefinition[]): string {
  if (skills.length === 0) {
    return "No active skills selected for this request.";
  }

  return skills
    .map(
      (skill) => `<skill id="${skill.id}" name="${skill.name}" source="${formatSkillSource(skill.source)}">
${skill.content}
</skill>`
    )
    .join("\n\n");
}
