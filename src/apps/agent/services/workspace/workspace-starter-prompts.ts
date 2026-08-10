/**
 * Project-aware starter prompts — the shared source of truth for both empty
 * states.
 *
 * The IDE chat panel (`WorkspaceAwareEmptyState`) and the Agent Window home
 * (`agent-window/components/EmptyState`) offer the same four opening moves,
 * named after the workspace the user actually has open. Keeping the copy and
 * the branching here means the two surfaces cannot drift apart, which is the
 * only reason a user would notice they are two different code paths.
 *
 * Icons are NOT chosen here. Each surface owns its own icon family — the IDE
 * uses lucide, the Agent Window uses the bespoke `AgentIcon` set — so a prompt
 * declares a semantic `kind` and each renderer maps that to its own glyph.
 *
 * Behaviour note: the builder is called before AND after `scanWorkspace`
 * resolves. Every branch returns exactly four prompts in the same order and
 * with the same `kind` sequence per slot, so the arrival of the summary refines
 * the wording in place instead of reflowing the list.
 */

import type { WorkspaceSummary } from "@/apps/agent/services/workspace/workspace-summary";

/**
 * What a starter is FOR. Surfaces map this to a glyph; nothing here depends on
 * a particular icon family.
 */
export type StarterPromptKind =
  | "getting-started"
  | "architecture"
  | "review"
  | "debug"
  | "plan"
  | "tests"
  | "read-first";

export interface StarterPrompt {
  /** Semantic role — also a stable React key (unique within a result set). */
  kind: StarterPromptKind;
  /** The row label the user reads and clicks. */
  title: string;
  /** What actually lands in the composer. */
  prompt: string;
}

const joinList = (items: string[]): string => {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
};

/**
 * Four opening moves for the workspace, degrading gracefully.
 *
 * - No workspace at all: generic ways to start working with Aurora.
 * - Workspace open, scan not finished: the same four jobs, unnamed.
 * - Scan finished: the same four jobs, named after the project and tuned to
 *   what the scan actually found (framework, git, dominant languages).
 */
export function buildStarterPrompts(
  rootPath: string,
  summary: WorkspaceSummary | null,
): StarterPrompt[] {
  if (!summary && !rootPath) {
    return [
      {
        kind: "getting-started",
        title: "Show me how to start using Aurora on a real project",
        prompt:
          "Help me get started with Aurora. Explain the best workflow once I open a project workspace.",
      },
      {
        kind: "architecture",
        title: "Review some code and explain what matters first",
        prompt:
          "I want to paste in a file or idea. Help me review it, explain it, and suggest the next move.",
      },
      {
        kind: "plan",
        title: "Turn a feature idea into an implementation plan",
        prompt:
          "Help me turn a feature idea into an implementation plan with steps, files, and validation.",
      },
      {
        kind: "debug",
        title: "Debug a problem step by step",
        prompt:
          "Help me debug a bug systematically. Start by asking for the failing behavior, files, and any errors.",
      },
    ];
  }

  if (!summary) {
    return [
      {
        kind: "architecture",
        title: "Explain how this codebase is organized",
        prompt:
          "Explain the architecture of this workspace, identify the main entry points, and summarize how the important pieces fit together.",
      },
      {
        kind: "review",
        title: "Find likely bugs, risky areas, and missing validation",
        prompt:
          "Review this workspace for likely bugs, risky areas, and missing validation. Prioritize the highest-impact findings first.",
      },
      {
        kind: "plan",
        title: "Plan the next high-impact improvement",
        prompt:
          "Propose the next high-impact improvement for this workspace, then outline the files and implementation steps involved.",
      },
      {
        kind: "tests",
        title: "Identify the most important missing tests",
        prompt:
          "Identify the most important untested flows in this workspace and propose a focused test plan before writing tests.",
      },
    ];
  }

  const architecturePrompt =
    summary.framework === "Tauri"
      ? `Explain how the React frontend, Tauri commands, and Rust backend are connected in the ${summary.name} workspace. Map the main files and runtime data flow.`
      : summary.framework === "Next.js"
        ? `Explain the ${summary.name} workspace architecture with emphasis on routing, server/client boundaries, and the main data flow.`
        : summary.framework === "Rust (Cargo)"
          ? `Explain the ${summary.name} workspace structure, its main Rust modules, and how responsibilities are split across the codebase.`
          : `Explain the architecture of the ${summary.name} workspace, focusing on the main modules, data flow, and how the primary features are organized.`;

  const implementationPrompt =
    summary.hasTsConfig || summary.hasPackageJson
      ? `Propose the next high-impact improvement for the ${summary.name} workspace, then identify the frontend files and state/services that would need to change.`
      : `Propose the next high-impact improvement for the ${summary.name} workspace, then identify the files and modules that should change first.`;

  const options: StarterPrompt[] = [
    {
      kind: "architecture",
      title: `Explain how ${summary.name} is organized`,
      prompt: architecturePrompt,
    },
    {
      kind: "review",
      title: `Review ${summary.name} for bugs and risky areas`,
      prompt: `Review the ${summary.name} workspace for likely bugs, regressions, and missing validation. Prioritize the highest-impact findings first.`,
    },
    {
      kind: "plan",
      title: `Plan the next high-impact improvement for ${summary.name}`,
      prompt: implementationPrompt,
    },
    {
      kind: "tests",
      title: `Identify the most important missing tests in ${summary.name}`,
      prompt: `Identify the most important untested flows in the ${summary.name} workspace and propose a focused test plan before writing tests.`,
    },
  ];

  // A tracked project has history to reason about, so the review can be framed
  // as "what state is this in" rather than a cold bug hunt.
  if (summary.hasGit) {
    options[1] = {
      kind: "review",
      title: `Review the current state of ${summary.name}`,
      prompt: `Review the ${summary.name} workspace like a code reviewer. Focus on behavioral risks, architectural debt, and the most important gaps to fix next.`,
    };
  }

  // No JS/TS manifest but a clear dominant language means the useful first move
  // is orientation ("what do I read"), not a change proposal.
  if (summary.languages.length > 0 && !summary.hasPackageJson && !summary.hasTsConfig) {
    options[2] = {
      kind: "read-first",
      title: `Show me the core ${joinList(summary.languages)} files to read first`,
      prompt: `The ${summary.name} workspace looks centered around ${joinList(summary.languages)}. Identify the core files I should understand first and explain why they matter.`,
    };
  }

  return options;
}
