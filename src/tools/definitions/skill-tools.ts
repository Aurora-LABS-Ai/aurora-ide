/**
 * Skill discovery tools.
 *
 * The agent prompt only previews the skills the user has explicitly enabled
 * (capped at 10). Everything else lives in the workspace `.aurora/skills/` and
 * `agents/skills/` folders plus the global Aurora skills directory, and is
 * reachable through these two tools:
 *
 * - `aurora_skill_search` — browse the catalog by query.
 * - `aurora_skill_load`   — fetch a single skill's full SKILL.md body.
 *
 * Both are read-only. Results are JSON-serialized strings.
 */
import type { ToolDefinition } from "../types";

export const auroraSkillSearchTool: ToolDefinition = {
  type: "function",
  function: {
    name: "aurora_skill_search",
    description: `Browse Aurora skill catalog by query. Returns a ranked list of matching skills (id, name, description, source, optional path).

Use this when:
- The user's task may benefit from a specialized playbook that is not currently enabled in settings.
- You want to discover what skills exist for a given topic (e.g. "react performance", "rust async", "tailwind v4").

Behavior:
- With \`query\`: ranks by id/name/description/trigger match and returns the best matches.
- Without \`query\`: returns the first \`limit\` skills (alphabetical / source order).
- Always returns a small JSON array; load full content via \`aurora_skill_load\`.`,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional free-text query. Matches against id, name, description, and triggers.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (1-100). Default: 30.",
          default: 30,
        },
        source: {
          type: "string",
          enum: ["builtin", "workspace", "global"],
          description: "Restrict results to a specific skill source.",
        },
      },
      required: [],
    },
  },
};

export const auroraSkillLoadTool: ToolDefinition = {
  type: "function",
  function: {
    name: "aurora_skill_load",
    description: `Load the full SKILL.md body for a single skill by id. Returns name, description, source, optional path, triggers, and the complete skill content as a JSON object.

Use this immediately after \`aurora_skill_search\` returns a relevant skill — or when an explicit attachment references a skill you don't have the full body for. Do not call this tool eagerly; only load skills that are clearly applicable to the current task.`,
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The skill id to load (matches the id returned by aurora_skill_search). Storage keys are also accepted.",
        },
      },
      required: ["id"],
    },
  },
};

export const skillTools: ToolDefinition[] = [
  auroraSkillSearchTool,
  auroraSkillLoadTool,
];
