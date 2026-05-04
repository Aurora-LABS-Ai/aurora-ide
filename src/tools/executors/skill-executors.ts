/**
 * Skill discovery tool executors.
 *
 * Both tools are read-only and operate on the unfiltered skill candidate list
 * (built-in + workspace + global). They intentionally bypass the per-user
 * toggle gate so the agent can pull in any skill it judges relevant to the
 * task — toggles only control which skills are previewed up front.
 */
import {
  findSkillById,
  searchSkillCandidates,
  type SkillSearchResult,
  type SkillSource,
} from "../../services/skills";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import { toolRegistry } from "../registry";

const VALID_SOURCES: ReadonlySet<SkillSource> = new Set(["builtin", "workspace", "global"]);

function getCurrentWorkspacePath(): string | null {
  try {
    return useWorkspaceStore.getState().rootPath ?? null;
  } catch {
    return null;
  }
}

function coerceLimit(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 30;
}

function coerceSourceFilter(raw: unknown): SkillSource | null {
  if (typeof raw !== "string") {
    return null;
  }
  return VALID_SOURCES.has(raw as SkillSource) ? (raw as SkillSource) : null;
}

export async function executeAuroraSkillSearch(args: Record<string, unknown>): Promise<string> {
  try {
    const query = typeof args.query === "string" ? args.query : null;
    const limit = coerceLimit(args.limit);
    const sourceFilter = coerceSourceFilter(args.source);
    const workspacePath = getCurrentWorkspacePath();

    let results: SkillSearchResult[] = await searchSkillCandidates(query, limit, {
      workspacePath,
    });

    if (sourceFilter) {
      results = results.filter((skill) => skill.source === sourceFilter);
    }

    return JSON.stringify({
      success: true,
      count: results.length,
      query: query ?? null,
      source_filter: sourceFilter,
      results,
    });
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : "Skill search failed",
    });
  }
}

export async function executeAuroraSkillLoad(args: Record<string, unknown>): Promise<string> {
  try {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!id) {
      return JSON.stringify({
        success: false,
        error: "`id` is required.",
      });
    }

    const workspacePath = getCurrentWorkspacePath();
    const skill = await findSkillById(id, { workspacePath });

    if (!skill) {
      return JSON.stringify({
        success: false,
        error: `No skill found with id \`${id}\`. Use aurora_skill_search to discover available skills.`,
      });
    }

    return JSON.stringify({
      success: true,
      skill: {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        source: skill.source,
        sourcePath: skill.sourcePath,
        triggers: skill.triggers,
        content: skill.content,
      },
    });
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : "Skill load failed",
    });
  }
}

export const registerSkillExecutors = (): void => {
  toolRegistry.registerExecutor("aurora_skill_search", executeAuroraSkillSearch);
  toolRegistry.registerExecutor("aurora_skill_load", executeAuroraSkillLoad);
};
