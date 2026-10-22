/**
 * Agent Window — send pipeline: the per-message context blocks.
 *
 * What a turn adds beside the user's words: `/`-attached rules, the standing
 * project rules, the open files, `/image`, and the preferred MCP servers.
 * Pure text builders; the pipeline joins what they return.
 */

import { loadProjectRules } from "@/apps/agent/services/runtime/context-builder";

/**
 * Load the user's `/`-selected project rules and format them as an authoritative
 * context block (mirrors how the IDE context builder injects rules). Returns
 * `null` when nothing is selected, the project is unknown, or none resolve.
 */
export async function buildRuleContext(
  projectRoot: string | null,
  ruleFilenames: string[],
): Promise<string | null> {
  if (!projectRoot || ruleFilenames.length === 0) return null;
  let rules: Array<{ filename: string; content: string }>;
  try {
    rules = await loadProjectRules(projectRoot);
  } catch {
    return null;
  }
  const wanted = new Set(ruleFilenames);
  const selected = rules.filter((r) => wanted.has(r.filename));
  if (selected.length === 0) return null;

  const body = selected
    .map((r) => `<rule file="${r.filename}">\n${r.content}\n</rule>`)
    .join("\n\n");
  return `<project_rules>\nThe user explicitly attached these project rules to this turn. Treat them as authoritative standing rules for this task.\n\n${body}\n</project_rules>`;
}

/**
 * Total character budget for auto-attached project rules (~2.5K tokens).
 * Oversized rules are truncated with a pointer to the file so the agent can
 * `file_read` the rest when it actually matters.
 */
const AUTO_RULES_CHAR_BUDGET = 10_000;

/**
 * Auto-attach the project's `.aurora/*.md` rules — parity with the IDE's
 * context builder, which injects `<project_rules>` on a chat's first message.
 * Without this, rules only reached the agent window when the user explicitly
 * `/`-attached them. Rules already selected via `/` are excluded here (they
 * ride verbatim in `buildRuleContext`), and the total is capped by
 * [`AUTO_RULES_CHAR_BUDGET`] so a huge rules folder can't flood the context.
 */
export async function buildAutoRulesContext(
  projectRoot: string | null,
  excludeFilenames: string[],
): Promise<string | null> {
  if (!projectRoot) return null;
  let rules: Array<{ filename: string; content: string }>;
  try {
    rules = await loadProjectRules(projectRoot);
  } catch {
    return null;
  }
  const exclude = new Set(excludeFilenames);
  const auto = rules.filter((r) => !exclude.has(r.filename) && r.content.length > 0);
  if (auto.length === 0) return null;

  let remaining = AUTO_RULES_CHAR_BUDGET;
  const parts: string[] = [];
  for (const rule of auto) {
    if (remaining <= 0) {
      parts.push(
        `<rule file="${rule.filename}" omitted="true">Omitted for context budget — read .aurora/${rule.filename} with file_read if relevant.</rule>`,
      );
      continue;
    }
    let body = rule.content;
    if (body.length > remaining) {
      body = `${body.slice(0, remaining)}\n…[truncated — read .aurora/${rule.filename} for the rest]`;
    }
    remaining -= body.length;
    parts.push(`<rule file="${rule.filename}">\n${body}\n</rule>`);
  }
  return `<project_rules description="Project-specific rules from .aurora/*.md files that must be followed">\n${parts.join("\n\n")}\n</project_rules>`;
}

/**
 * What the user currently has open in the right-hand Files panel.
 *
 * NAMES ONLY, never content. A path costs a few tokens and tells the agent
 * where the user's attention is; the file body costs thousands and it already
 * has `file_read` for the moment it actually needs one. Injecting content here
 * would re-send it on every request of the conversation for as long as the file
 * stayed open.
 *
 * This replaces the IDE-derived open-tab list, which is gone: the agent window
 * is the product and the separate editor window is no longer where the user's
 * files are. The rail viewer shows one file at a time today, so the block is
 * built from a LIST rather than a single path — if the panel grows tabs, every
 * tab's filename lands here with no redesign and no change to the contract.
 */
export function buildOpenFilesContext(
  paths: string[],
  activePath: string | null,
): string | null {
  const open = paths.map((path) => path.trim()).filter(Boolean);
  if (open.length === 0) return null;
  // Marked, not positional: the dock's active tab may be the file tree, the
  // browser or a terminal, in which case none of these files is the one being
  // looked at and claiming the first one is would be a small lie every turn.
  const rows = open.map(
    (path) => `- ${path}${path === activePath ? "  (showing)" : ""}`,
  );
  return `<open_files count="${open.length}">
Open in the user's Files panel right now. Filenames only — read one with file_read if you need what is in it.

${rows.join("\n")}
</open_files>`;
}

/**
 * `/image` — the user has prioritised a picture. This goes to the SELECTED
 * model, never around it: the model reads the request and runs
 * `generate_image`, which lets it catch a prompt that would waste forty
 * seconds and a paid call before the call is made. The design notes record
 * that a direct-to-API `/image` was proposed and overruled for this reason.
 */
export function buildImageRequest(requested: boolean): string | null {
  if (!requested) return null;
  return `<image_request>
The user attached /image: they want a picture made of this message, and that comes before any other reply. Reply in a sentence at most, then call generate_image with a prompt written out from what they said. If what they wrote is too thin to draw from (a bare noun, no subject or setting), offer one fuller prompt in one or two lines and ask before spending the call. Otherwise do not ask; make it.
</image_request>`;
}

/** Soft nudge toward the `/`-selected MCP servers (their tools are already available). */
export function buildMcpDirective(serverNames: string[]): string | null {
  if (serverNames.length === 0) return null;
  const list = serverNames.join(", ");
  return `<preferred_mcp_servers>\nThe user explicitly referenced these connected MCP server(s) for this task: ${list}. Prefer their tools where relevant.\n</preferred_mcp_servers>`;
}
