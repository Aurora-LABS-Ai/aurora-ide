/**
 * Agent Window — empty / home state [view].
 *
 * Shown when no conversation is open (fresh window or after "New chat"). The
 * layout is the OpenCode-style brand landing: a giant ghost "aurora" wordmark
 * floats above the centered composer (not docked at the bottom), with a row of
 * suggestion starters underneath.
 *
 * Isolated by design — all colour comes from `--agw-*` tokens; the composer is
 * reused (controlled here so a suggestion can prefill the draft).
 */

import React from "react";

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

/** Last segment of a path — the folder you actually think of the project as. */
function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Everything above the folder, kept as context but visually subordinate.
 *
 * Long paths are elided from the LEFT (`…\Users\Alvan\projects`) because the
 * segments nearest the project are the ones that disambiguate it — truncating
 * the tail would strip exactly the part that tells two same-named folders
 * apart.
 */
function parentPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 1) return "";
  const parent = parts.slice(0, -1);
  const shown = parent.length > 3 ? ["…", ...parent.slice(-3)] : parent;
  return shown.join(" / ");
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
        // Extra bottom padding biases the centred group above true centre —
        // the wordmark + composer sit in the upper half like the reference
        // landing instead of floating at dead centre.
        padding: "32px 20px clamp(128px, 18vh, 200px)",
      }}
    >
      <div className="w-full max-w-3xl mx-auto agw-home-column">
        {/* Brand wordmark — a rim-lit ghost watermark (decorative, hence
         *  aria-hidden). Sized in cqi so it tracks the PANE width (never clips
         *  when the rails squeeze the conversation). Each span owns its own
         *  gradient paint; the ::before light pool and ::after floor shadow sit
         *  behind the whole mark.
         *
         *  Split per LETTER so the arrival light can travel one glyph at a
         *  time. A gradient sweep cannot do that — it is continuous, so at any
         *  instant it straddles whatever glyphs it overlaps and lights two at
         *  once. Making the glyph the unit of animation is the only way to step
         *  it. Kept as inline spans (not flex items) so normal text layout,
         *  letter-spacing and centring are untouched.
         *
         *  Safe to split for a11y: the mark is already aria-hidden, so no
         *  screen reader ever spells it out letter by letter. */}
        <div className="agw-home-wordmark" aria-hidden="true">
          {[..."aurora"].map((glyph, index) => (
            <span
              key={index}
              data-glyph={glyph}
              style={{ ["--agw-lit-i" as string]: String(index) }}
            >
              {glyph}
            </span>
          ))}
        </div>

        {/* Workspace the window is scoped to. It sits between the mark and the
         *  composer because that is the order the questions arrive in: what is
         *  this, WHERE am I about to act, then the input. An empty state's job
         *  is to orient before it invites action, and "which folder is this
         *  agent pointed at" is the one fact you cannot recover from an empty
         *  transcript. Hidden entirely when no workspace is open rather than
         *  showing a placeholder — an empty path row would raise the question
         *  it exists to answer. */}
        {projectRoot && (
          <div className="agw-home-root" title={projectRoot}>
            <AgentIcon name="files" size={13} />
            <span className="agw-home-root-name">{folderName(projectRoot)}</span>
            <span className="agw-home-root-path">{parentPath(projectRoot)}</span>
          </div>
        )}

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
