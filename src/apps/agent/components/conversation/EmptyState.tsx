/**
 * Agent Window — empty / home state [view].
 *
 * Shown when no conversation is open (fresh window or after "New chat"). The
 * layout is the OpenCode-style brand landing: a giant ghost "aurora" wordmark
 * floats above the centered composer (not docked at the bottom), with a row of
 * suggestion starters underneath.
 *
 * The starters are PROJECT-AWARE — the same four opening moves the IDE chat
 * panel offers, built by the shared `buildStarterPrompts` and named after the
 * workspace this window is scoped to. They were previously four fixed generic
 * lines ("Find a bug", "Write tests"), which asked the user to supply the
 * context the product already had.
 *
 * Isolated by design — all colour comes from `--agw-*` tokens; the composer is
 * reused (controlled here so a suggestion can prefill the draft).
 */

import React, { useMemo } from "react";

import { AgentIcon, type AgentIconName } from "@/apps/agent/shared/AgentIcon";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { newChatDraftKey, useAgentDraftStore } from "@/apps/agent/store/conversation/useAgentDraftStore";
import { AgentComposer } from "@/apps/agent/components/composer/AgentComposer";
import { ProjectSwitcher } from "@/apps/agent/components/panels/ProjectSwitcher";
import { useWorkspaceSummary } from "@/apps/agent/hooks/useWorkspaceSummary";
import {
  buildStarterPrompts,
  type StarterPromptKind,
} from "@/apps/agent/services/workspace/workspace-starter-prompts";
import type { AttachedPromptChip } from "@/apps/agent/services/threads/thread-service";

/**
 * Semantic starter kind -> `AgentIcon` glyph.
 *
 * The IDE maps the same kinds onto lucide; only the glyph family differs, so a
 * copy change lands on both surfaces at once. `review` and `debug` share
 * `shield` deliberately — both are "what is wrong here" jobs.
 */
const KIND_ICONS: Record<StarterPromptKind, AgentIconName> = {
  "getting-started": "book",
  architecture: "workspace-tree",
  review: "shield",
  debug: "shield",
  plan: "file-edit",
  tests: "checklist",
  "read-first": "book-open",
};

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

  // Scans the workspace root (one level deep) for framework, git and dominant
  // languages. Returns null until it resolves, so the builder's unnamed branch
  // renders first — same four rows in the same order, so the summary landing
  // refines the wording in place rather than reflowing the list.
  const rootPath = projectRoot ?? "";
  const summary = useWorkspaceSummary(rootPath);
  const starters = useMemo(
    () => buildStarterPrompts(rootPath, summary),
    [rootPath, summary],
  );

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
         *  transcript.
         *
         *  It is also the CONTROL for changing project — see ProjectSwitcher,
         *  which hides itself when no workspace is open rather than showing a
         *  placeholder that raises the question it exists to answer. */}
        <ProjectSwitcher />

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

        {/* Starters — plain rows with dividers (no boxes). Keyed by `kind`, not
         *  by label: the label is rewritten in place when the workspace scan
         *  resolves, and a title key would remount every row (dropping hover and
         *  keyboard focus) for what is only a wording refinement. */}
        <div className="mt-4">
          {starters.map((starter) => (
            <button
              key={starter.kind}
              type="button"
              className="agw-suggestion"
              onClick={() => setDraft(starter.prompt)}
            >
              <span className="agw-suggestion-icon">
                <AgentIcon name={KIND_ICONS[starter.kind]} size={16} />
              </span>
              <span className="agw-suggestion-label">{starter.title}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
