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
import {
  buildStarterPrompts,
  type StarterPromptKind,
} from "../../services/workspace-starter-prompts";

type EmptyStateMode = "chat" | "agent";

interface WorkspaceAwareEmptyStateProps {
  mode: EmptyStateMode;
  onSelectPrompt: (prompt: string) => void;
  rootPath: string;
}

/**
 * Semantic starter kind -> lucide glyph, for the IDE's icon family.
 *
 * The Agent Window maps the same kinds onto its own `AgentIcon` set, so the two
 * empty states share wording and logic without sharing an icon library.
 */
const KIND_ICONS: Record<
  StarterPromptKind,
  React.ComponentType<{ className?: string }>
> = {
  "getting-started": ClipboardList,
  architecture: FolderTree,
  review: ShieldAlert,
  debug: ShieldAlert,
  plan: FilePenLine,
  tests: ListTodo,
  "read-first": ClipboardList,
};

export const WorkspaceAwareEmptyState: React.FC<
  WorkspaceAwareEmptyStateProps
> = ({ mode, onSelectPrompt, rootPath }) => {
  const workspaceSummary = useWorkspaceSummary(rootPath);

  const promptOptions = useMemo(
    () => buildStarterPrompts(rootPath, workspaceSummary),
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
          {promptOptions.map(({ kind, title: optionTitle, prompt }, index) => {
            const Icon = KIND_ICONS[kind];
            return (
              <button
                key={kind}
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
