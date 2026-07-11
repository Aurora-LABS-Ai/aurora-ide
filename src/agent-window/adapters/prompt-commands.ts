/**
 * Agent Window — slash (`/`) command catalog (adapter / inbound channel).
 *
 * The `/` picker is the sibling of the `@`-file picker (see `file-index.ts`):
 * where `@` references **files**, `/` references **directives** — skills, project
 * rules, and connected MCP servers. It never lists files.
 *
 *   - **Skills**   — every discoverable skill (built-in + workspace + global),
 *                    regardless of the per-workspace toggle. Slash is the natural
 *                    way to pull a skill in on demand without flipping it on in
 *                    Settings; resolution honours explicit keys for any skill
 *                    (`resolveSkillsForPrompt`), so picking one here just works.
 *   - **Rules**    — project rules from `.aurora/*.md` (the same source the IDE
 *                    context builder reads). Their content is injected on send.
 *   - **MCP**      — currently-connected MCP servers, as a soft "prefer this
 *                    server" nudge (its tools are already available to the agent).
 *
 * Cached per project root; the cache is dropped after each turn (skills/rules can
 * change on disk) — mirrors the `@`-index lifecycle so the two pickers behave the
 * same.
 */

import { loadAllSkillCandidates, type SkillDefinition } from "../../services/skills";
import { loadProjectRules } from "../../services/context-builder";
import { useMcpStore } from "../../store/useMcpStore";

export type PromptCommandKind = "skill" | "rule" | "mcp";

export interface PromptCommand {
  /** Stable, unique key across all kinds (also the dedupe key for attachments). */
  key: string;
  kind: PromptCommandKind;
  /** Primary label shown in the menu + chip. */
  title: string;
  /** Secondary muted label (skill id / rule filename / tool count). */
  subtitle: string;
  /** One-line description for the menu row. */
  description: string;
  /** Provenance tag ("Built-in Skill", "Project Rule", "MCP Server"). */
  sourceLabel: string;
  /** Lowercased haystack for matching (built once at load). */
  haystack: string;

  // ── kind-specific payload (exactly one is set) ──────────────────────
  skillStorageKey?: string;
  ruleFilename?: string;
  mcpServerId?: string;
}

const cache = new Map<string, PromptCommand[]>();
const inflight = new Map<string, Promise<PromptCommand[]>>();

const CACHE_KEY_NO_ROOT = "__no_root__";

function skillSourceLabel(skill: SkillDefinition): string {
  if (skill.source === "workspace") return "Project Skill";
  if (skill.source === "global") return "Global Skill";
  return "Built-in Skill";
}

function mapSkill(skill: SkillDefinition): PromptCommand {
  return {
    key: `skill:${skill.storageKey}`,
    kind: "skill",
    title: skill.name,
    subtitle: skill.id,
    description: skill.description,
    sourceLabel: skillSourceLabel(skill),
    haystack: `${skill.name} ${skill.id} ${skill.description} ${skill.triggers.join(" ")}`.toLowerCase(),
    skillStorageKey: skill.storageKey,
  };
}

function mapRule(filename: string): PromptCommand {
  const title = filename.replace(/\.md$/i, "");
  return {
    key: `rule:${filename}`,
    kind: "rule",
    title,
    subtitle: filename,
    description: `Project rule from .aurora/${filename}`,
    sourceLabel: "Project Rule",
    haystack: `${title} ${filename}`.toLowerCase(),
    ruleFilename: filename,
  };
}

function mapMcpServers(): PromptCommand[] {
  const { servers } = useMcpStore.getState();
  return servers
    .filter((s) => s.status === "connected")
    .map((s) => {
      const toolCount = s.tools?.length ?? 0;
      return {
        key: `mcp:${s.config.id}`,
        kind: "mcp" as const,
        title: s.config.name,
        subtitle: toolCount === 1 ? "1 tool" : `${toolCount} tools`,
        description: `Prefer the ${s.config.name} MCP server for this task.`,
        sourceLabel: "MCP Server",
        haystack: `${s.config.name} mcp ${s.config.id}`.toLowerCase(),
        mcpServerId: s.config.id,
      };
    });
}

async function build(root: string | null): Promise<PromptCommand[]> {
  const [skills, rules] = await Promise.all([
    loadAllSkillCandidates({ workspacePath: root ?? undefined }),
    root ? loadProjectRules(root).catch(() => []) : Promise.resolve([]),
  ]);

  const commands: PromptCommand[] = [
    ...rules.map((r) => mapRule(r.filename)),
    ...mapMcpServers(),
    ...skills.map(mapSkill),
  ];

  // Stable order: rules, then MCP, then skills — each alphabetical within kind.
  const order: Record<PromptCommandKind, number> = { rule: 0, mcp: 1, skill: 2 };
  commands.sort(
    (a, b) => order[a.kind] - order[b.kind] || a.title.localeCompare(b.title),
  );
  return commands;
}

/** Load (and cache) the slash catalog for a project root. Concurrent calls share one build. */
export async function loadPromptCommands(root: string | null): Promise<PromptCommand[]> {
  const cacheKey = root ?? CACHE_KEY_NO_ROOT;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  const pending = inflight.get(cacheKey);
  if (pending) return pending;

  const p = build(root)
    .then((commands) => {
      cache.set(cacheKey, commands);
      inflight.delete(cacheKey);
      return commands;
    })
    .catch((err) => {
      inflight.delete(cacheKey);
      console.warn("[agent-window] slash catalog build failed:", err);
      return [];
    });
  inflight.set(cacheKey, p);
  return p;
}

/** Drop the cache (call after a turn — skills/rules/MCP may have changed). */
export function invalidatePromptCommands(root?: string | null): void {
  if (root === undefined) cache.clear();
  else cache.delete(root ?? CACHE_KEY_NO_ROOT);
}

/**
 * Rank commands against a query. Ordering: title prefix > title substring >
 * any-field substring; kept stable by the catalog's own order on ties. Empty
 * query returns the catalog head.
 */
export function rankCommands(
  commands: PromptCommand[],
  query: string,
  limit = 8,
): PromptCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands.slice(0, limit);

  const scored: Array<{ c: PromptCommand; score: number; i: number }> = [];
  commands.forEach((c, i) => {
    const title = c.title.toLowerCase();
    let score = -1;
    if (title.startsWith(q)) score = 0;
    else if (title.includes(q)) score = 1;
    else if (c.haystack.includes(q)) score = 2;
    if (score >= 0) scored.push({ c, score, i });
  });
  scored.sort((a, b) => a.score - b.score || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.c);
}
