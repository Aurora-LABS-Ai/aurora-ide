/**
 * Agent Window — empty / home state [view].
 *
 * Shown when no conversation is open (fresh window or after "New chat"). Mirrors
 * the Codex home layout: a centered heading, the composer in the middle of the
 * pane (not docked at the bottom), and a row of suggestion starters underneath.
 *
 * Isolated by design — all colour comes from `--agw-*` tokens; the composer is
 * reused (controlled here so a suggestion can prefill the draft).
 */

import React, { useMemo } from "react";

import { AgentIcon, type AgentIconName } from "../shared/AgentIcon";
import { useAgentChatStore } from "../store/useAgentChatStore";
import { newChatDraftKey, useAgentDraftStore } from "../store/useAgentDraftStore";
import { AgentComposer } from "./AgentComposer";
import type { AttachedPromptChip } from "../../services/thread-service";

interface Suggestion {
  icon: AgentIconName;
  label: string;
  prompt: string;
}

const SUGGESTIONS: Suggestion[] = [
  {
    icon: "files",
    label: "Explain this project",
    prompt: "Give me a high-level tour of this project's architecture.",
  },
  {
    icon: "search",
    label: "Find a bug",
    prompt: "Help me find and fix a bug. Here's what's happening: ",
  },
  {
    icon: "plus",
    label: "Build a feature",
    prompt: "I want to add a new feature. Here's the idea: ",
  },
  {
    icon: "review",
    label: "Write tests",
    prompt: "Write tests for ",
  },
];

interface EmptyStateProps {
  /** Send the first message (materialises the thread). */
  onSubmit?: (text: string, fileChips?: AttachedPromptChip[]) => void;
  /** True while the very first turn is streaming. */
  sending?: boolean;
  /** Cancel the in-flight turn. */
  onStop?: () => void;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  onSubmit,
  sending = false,
  onStop,
}) => {
  const projectRoot = useAgentChatStore((s) => s.projectRoot);
  // The new-chat draft is scoped per project, so an unsent idea in project A
  // survives a dip into project B (and an app restart). The composer clears it
  // on send via `onValueChange("")`; a suggestion click prefills it.
  const draftKey = newChatDraftKey(projectRoot);
  const draft = useAgentDraftStore((s) => s.drafts[draftKey] ?? "");
  const setDraftText = useAgentDraftStore((s) => s.setDraft);
  const setDraft = (text: string) => setDraftText(draftKey, text);

  const folder = useMemo(() => {
    if (!projectRoot) return null;
    const parts = projectRoot.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? projectRoot;
  }, [projectRoot]);

  return (
    <div
      className="agw-scroll"
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "32px 20px",
      }}
    >
      <div className="w-full max-w-4xl mx-auto">
        {/* Heading — text only, no icon (matches Codex home). */}
        <div className="text-center mb-6">
          <h1
            style={{
              fontSize: 27,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              color: "var(--agw-text)",
              margin: 0,
            }}
          >
            What should we build{folder ? "" : "?"}
            {folder && (
              <span style={{ color: "var(--agw-text-muted)", fontWeight: 600 }}>
                {" in "}
                {folder}?
              </span>
            )}
          </h1>
        </div>

        {/* Composer (centered) */}
        <AgentComposer
          autoFocus
          value={draft}
          onValueChange={setDraft}
          onSubmit={onSubmit}
          sending={sending}
          onStop={onStop}
          placeholder="Describe a task — type @ for files, / for skills and rules"
        />

        {/* Suggestion starters — plain rows with dividers (no boxes). */}
        <div className="mt-4">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              type="button"
              className="agw-suggestion"
              onClick={() => setDraft(s.prompt)}
            >
              <span
                style={{ color: "var(--agw-text-subtle)", display: "inline-flex" }}
              >
                <AgentIcon name={s.icon} size={16} />
              </span>
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
