import React, { useMemo } from "react";
import {
  ArrowRight,
  ClipboardList,
  FilePenLine,
  FolderTree,
  ListTodo,
  ShieldAlert,
} from "lucide-react";

import { useWorkspaceSummary } from "../../hooks/useWorkspaceSummary";

type EmptyStateMode = "chat" | "agent";

interface PromptOption {
  Icon: React.ComponentType<{ className?: string }>;
  title: string;
  prompt: string;
}

interface WorkspaceAwareEmptyStateProps {
  mode: EmptyStateMode;
  onSelectPrompt: (prompt: string) => void;
  rootPath: string;
}

const joinList = (items: string[]): string => {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
};

const buildWorkspacePromptOptions = (
  rootPath: string,
  summary: ReturnType<typeof useWorkspaceSummary>,
): PromptOption[] => {
  if (!summary && !rootPath) {
    return [
      {
        Icon: ClipboardList,
        title: "Show me how to start using Aurora on a real project",
        prompt:
          "Help me get started with Aurora. Explain the best workflow once I open a project workspace.",
      },
      {
        Icon: FolderTree,
        title: "Review some code and explain what matters first",
        prompt:
          "I want to paste in a file or idea. Help me review it, explain it, and suggest the next move.",
      },
      {
        Icon: FilePenLine,
        title: "Turn a feature idea into an implementation plan",
        prompt:
          "Help me turn a feature idea into an implementation plan with steps, files, and validation.",
      },
      {
        Icon: ShieldAlert,
        title: "Debug a problem step by step",
        prompt:
          "Help me debug a bug systematically. Start by asking for the failing behavior, files, and any errors.",
      },
    ];
  }

  if (!summary) {
    return [
      {
        Icon: FolderTree,
        title: "Explain how this codebase is organized",
        prompt:
          "Explain the architecture of this workspace, identify the main entry points, and summarize how the important pieces fit together.",
      },
      {
        Icon: ShieldAlert,
        title: "Find likely bugs, risky areas, and missing validation",
        prompt:
          "Review this workspace for likely bugs, risky areas, and missing validation. Prioritize the highest-impact findings first.",
      },
      {
        Icon: FilePenLine,
        title: "Plan the next high-impact improvement",
        prompt:
          "Propose the next high-impact improvement for this workspace, then outline the files and implementation steps involved.",
      },
      {
        Icon: ListTodo,
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

  const options: PromptOption[] = [
    {
      Icon: FolderTree,
      title: `Explain how ${summary.name} is organized`,
      prompt: architecturePrompt,
    },
    {
      Icon: ShieldAlert,
      title: `Review ${summary.name} for bugs and risky areas`,
      prompt: `Review the ${summary.name} workspace for likely bugs, regressions, and missing validation. Prioritize the highest-impact findings first.`,
    },
    {
      Icon: FilePenLine,
      title: `Plan the next high-impact improvement for ${summary.name}`,
      prompt: implementationPrompt,
    },
    {
      Icon: ListTodo,
      title: `Identify the most important missing tests in ${summary.name}`,
      prompt: `Identify the most important untested flows in the ${summary.name} workspace and propose a focused test plan before writing tests.`,
    },
  ];

  if (summary.hasGit) {
    options[1] = {
      Icon: ShieldAlert,
      title: `Review the current state of ${summary.name}`,
      prompt: `Review the ${summary.name} workspace like a code reviewer. Focus on behavioral risks, architectural debt, and the most important gaps to fix next.`,
    };
  }

  if (summary.languages.length > 0 && !summary.hasPackageJson && !summary.hasTsConfig) {
    options[2] = {
      Icon: ClipboardList,
      title: `Show me the core ${joinList(summary.languages)} files to read first`,
      prompt: `The ${summary.name} workspace looks centered around ${joinList(summary.languages)}. Identify the core files I should understand first and explain why they matter.`,
    };
  }

  return options;
};

export const WorkspaceAwareEmptyState: React.FC<
  WorkspaceAwareEmptyStateProps
> = ({ mode, onSelectPrompt, rootPath }) => {
  const workspaceSummary = useWorkspaceSummary(rootPath);

  const promptOptions = useMemo(
    () => buildWorkspacePromptOptions(rootPath, workspaceSummary),
    [rootPath, workspaceSummary],
  );

  const title =
    mode === "agent"
      ? workspaceSummary
        ? `Choose a starting point for ${workspaceSummary.name}`
        : "Choose a starting point"
      : workspaceSummary
        ? `Choose a starting point for ${workspaceSummary.name}`
        : rootPath
          ? "Choose a starting point"
          : "Start a new conversation";

  const description = workspaceSummary
    ? "Or type your own request below."
    : rootPath
      ? "Or type your own request below."
      : mode === "agent"
        ? "Open a workspace, or type your own request below."
        : "Open a workspace, or type your own request below.";

  return (
    <div className="flex flex-1 flex-col justify-center overflow-hidden px-6 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <div className="flex flex-col items-center text-center">
          <img
            src="/empty.png"
            alt={mode === "agent" ? "Agent empty state" : "Chat empty state"}
            width={82}
            height={82}
            className="mb-4 h-[82px] w-[82px] object-contain"
          />

          <h1 className="text-[30px] font-semibold tracking-tight text-text-primary">
            {title}
          </h1>
          <p className="mt-2 max-w-[620px] text-sm leading-relaxed text-text-secondary">
            {description}
          </p>
        </div>

        <div className="flex flex-col">
          {promptOptions.map(({ Icon, title: optionTitle, prompt }, index) => {
            return (
              <button
                key={optionTitle}
                onClick={() => onSelectPrompt(prompt)}
                className={`group flex items-center gap-4 py-4 text-left transition-colors duration-150 ${
                  index > 0
                    ? "border-t border-[var(--aurora-chat-surface-border)]"
                    : ""
                }`}
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary transition-colors duration-150 group-hover:text-primary" />
                <span className="min-w-0 flex-1 text-[15px] leading-6 text-text-primary transition-colors duration-150 group-hover:text-primary">
                  {optionTitle}
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-text-secondary transition-all duration-150 group-hover:translate-x-0.5 group-hover:text-primary" />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
