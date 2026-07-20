/**
 * Agent Window — Center conversation column [view].
 *
 * A thin layout shell. When no chat is open it shows the dedicated `EmptyState`
 * (Codex-style home: heading + centered composer + suggestions). When a chat is
 * open it renders the transcript via the dedicated `MessageBubble` (which in turn
 * uses `ToolCallCard`) with the composer docked at the bottom. Message rendering
 * and the empty/home state live in their own files; this component only wires
 * them together. All chrome reads `--agw-*`.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { AgentIcon } from "../shared/AgentIcon";
import { AgentComposer } from "./AgentComposer";
import { AgentTaskPanel } from "./AgentTaskPanel";
import { AgentQueuedDock } from "./AgentQueuedDock";
import { ApprovalBar } from "./ApprovalBar";
import { ContextRing } from "./ContextRing";
import { EmptyState } from "./EmptyState";
import { MessageBubble } from "./MessageBubble";
import { JumpRail } from "./JumpRail";
import { CompactionCard } from "./CompactionCard";
import { QuestionPrompt } from "./QuestionPrompt";
import { StreamingDotMatrix } from "./StreamingDotMatrix";
import { buildTurns } from "./timeline";
import { useAgentChatStore } from "../store/useAgentChatStore";
import { useAgentWorkspaceStore } from "../store/useAgentWorkspaceStore";
import { useAgentUiStore } from "../store/useAgentUiStore";
import { useAgentDraftStore } from "../store/useAgentDraftStore";
import { useAgentSuggestStore } from "../store/useAgentSuggestStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { FileIcon, FolderIcon } from "../../components/explorer/FileIcons";
import { useAgentAutoScroll } from "../hooks/useAgentAutoScroll";
import {
  requestReplySuggestions,
  useAgentWindowSend,
} from "../hooks/useAgentWindowSend";
import { useAgentTeamNotifier } from "../hooks/useAgentTeamNotifier";

/** Stable empty array so the suggestion selector never re-renders on misses. */
const EMPTY_SUGGESTIONS: string[] = [];

/** Wheel steps rate-limit for the suggestion drum (ms between rotations). */
const DRUM_STEP_COOLDOWN_MS = 110;

/**
 * Reply-suggestion drum — one visible option above the composer; hovering it
 * and rolling the mouse wheel rotates through the rest like a vertical
 * cylinder picker (the centered row is active; neighbors curve away with a
 * rotateX falloff). Click the centered row to fill the composer. Naked text,
 * no chrome — a quiet "i / n" on the right signals there's more to roll.
 */
const SuggestDrum: React.FC<{
  suggestions: string[];
  onPick: (text: string) => void;
}> = ({ suggestions, onPick }) => {
  const [active, setActive] = useState(0);
  const lastStepRef = useRef(0);
  const count = suggestions.length;
  const index = Math.min(active, count - 1);

  const step = (direction: number) =>
    setActive((current) => (Math.min(current, count - 1) + direction + count) % count);

  return (
    <div
      className="agw-suggest-drum"
      role="listbox"
      aria-label="Suggested replies — scroll to rotate, click to use"
      onWheel={(event) => {
        if (count < 2) return;
        event.preventDefault();
        const now = Date.now();
        if (now - lastStepRef.current < DRUM_STEP_COOLDOWN_MS) return;
        lastStepRef.current = now;
        step(event.deltaY > 0 ? 1 : -1);
      }}
    >
      {suggestions.map((suggestion, itemIndex) => {
        // Shortest cyclic distance so wrap-around rotates naturally.
        let offset = itemIndex - index;
        if (offset > count / 2) offset -= count;
        if (offset < -count / 2) offset += count;
        const isActive = offset === 0;
        const isVisible = Math.abs(offset) <= 1;
        return (
          <button
            key={suggestion}
            type="button"
            role="option"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            className="agw-suggest-item"
            data-active={isActive || undefined}
            style={{
              opacity: isVisible ? (isActive ? 1 : 0.45) : 0,
              // Neighbors straddle the drum's edges — the container clips them
              // mid-row and its mask fades them out, the iOS reel look.
              transform: `translateY(${offset * 28}px) rotateX(${offset * -48}deg) scale(${isActive ? 1 : 0.94})`,
              pointerEvents: isActive ? "auto" : "none",
            }}
            onClick={() => isActive && onPick(suggestion)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                step(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                step(-1);
              }
            }}
          >
            {suggestion}
          </button>
        );
      })}
      {count > 1 && (
        <span className="agw-suggest-count" aria-hidden>
          {index + 1} / {count}
        </span>
      )}
    </div>
  );
};

export const ConversationPane: React.FC = () => {
  const railOpen = useAgentWorkspaceStore((s) => s.railOpen);
  const toggleRail = useAgentWorkspaceStore((s) => s.toggleRail);
  const dockOpen = useAgentWorkspaceStore((s) => s.dockOpen);
  const toggleDock = useAgentWorkspaceStore((s) => s.toggleDock);
  const openSettings = useAgentUiStore((s) => s.openSettings);

  const currentThreadId = useAgentChatStore((s) => s.currentThreadId);
  const currentThread = useAgentChatStore((s) => s.currentThread);
  const threadLoading = useAgentChatStore((s) => s.threadLoading);

  const send = useAgentWindowSend();
  // When the background team run finishes/fails, submit a report turn to the
  // Lead (this chat) so it verifies and reports instead of going silent.
  useAgentTeamNotifier(send.send);

  // Per-chat composer draft: what you were typing in THIS chat, restored when
  // you switch back (and cleared by the composer's own `onValueChange("")` on
  // send). Keyed by the open thread id.
  const draftKey = currentThreadId ?? "";
  const draft = useAgentDraftStore((s) => s.drafts[draftKey] ?? "");
  const setDraft = useAgentDraftStore((s) => s.setDraft);

  // Tappable reply suggestions for THIS chat's last settled turn (composer
  // assists preference). Empty array when off, pending, or filtered out.
  const suggestions = useAgentSuggestStore((s) =>
    currentThreadId ? (s.byThread[currentThreadId] ?? EMPTY_SUGGESTIONS) : EMPTY_SUGGESTIONS,
  );
  const clearSuggestions = useAgentSuggestStore((s) => s.clear);

  // `send.sending` already reflects ONLY the open thread (a backgrounded turn in
  // another chat/project doesn't lock or animate the view you're reading).
  const openIsStreaming = send.sending;

  const title = currentThread?.title || "New Chat";

  // Live-activity narrator: while THIS chat streams, the header title becomes a
  // plain-language line of what the agent is doing ("Editing LeftRail.tsx"),
  // then snaps back to the real title the instant streaming ends. Opt-out in
  // Settings → Preferences.
  const showActivityInTitle = useSettingsStore((s) => s.showActivityInTitle);
  const activity = useAgentChatStore((s) =>
    currentThreadId ? s.activityByThread[currentThreadId] : undefined,
  );
  const isActivity = openIsStreaming && showActivityInTitle && !!activity;
  const headerText = isActivity ? activity!.label : title;
  // A named file/folder target renders its icon INLINE in the title (like the
  // tool cards) — the streaming matrix stays put in the glyph slot, never swapped.
  const activityName = isActivity ? activity?.name : undefined;
  const messages = useMemo(
    () => currentThread?.messages ?? [],
    [currentThread],
  );

  // Collapse the flat message list into render turns: consecutive assistant
  // messages (preamble + tool round(s) + final text) merge into ONE bubble that
  // renders the model's events in chronological order (text/tools interleaved).
  const turns = useMemo(() => buildTurns(messages), [messages]);
  const lastTurnIndex = turns.length - 1;

  // The text we'd resend for "Retry" = the most recent user turn.
  const lastUserContent = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i].content;
    }
    return null;
  }, [messages]);
  // Dedicated smooth auto-scroll. A ResizeObserver follows EVERY transcript
  // growth — token text, reasoning, tool cards — and glides to the bottom while
  // streaming, unless the user scrolled up to read (then the jump pill appears).
  const { containerRef, contentRef, bottomRef } = useAgentAutoScroll({
    isStreaming: openIsStreaming,
    resetKey: currentThreadId,
    growthKey: messages.length,
  });

  // The suggestion drum mounts AFTER the turn settles (auto-scroll already
  // released) and grows the dock, shrinking the transcript viewport — without
  // this, the reply's last lines hide behind it and the user must scroll.
  // Re-stick to the bottom, but only when they were already reading the end.
  const hasSuggestions = suggestions.length > 0;
  useEffect(() => {
    if (!hasSuggestions) return;
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 160) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [hasSuggestions, containerRef, bottomRef]);

  // Jump rail (Codex-style): one pin per USER turn down the right edge. Clicking
  // a pin scroll-jumps to that message; the pin nearest the top of the viewport
  // is marked active. Only shows once there are at least 2 user messages.
  const userPins = useMemo(
    () =>
      turns
        .filter((t) => t.role === "user")
        .map((t) => ({
          id: t.id,
          preview: (t.content || "").replace(/\s+/g, " ").trim().slice(0, 80),
        })),
    [turns],
  );
  const jumpToTurn = useCallback(
    (turnId: string) => {
      const el = containerRef.current?.querySelector(
        `[data-uturn="${turnId}"]`,
      ) as HTMLElement | null;
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [containerRef],
  );

  return (
    <div className="agw-zone" style={{ background: "var(--agw-conversation)" }}>
      {/* Header — Codex-style: seamless (NO divider), chat icon + title left, actions right. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 48,
          padding: "0 14px",
          flexShrink: 0,
        }}
      >
        {!railOpen && (
          <button
            type="button"
            className="agw-icon-btn"
            title="Open rail"
            aria-label="Open rail"
            onClick={toggleRail}
          >
            <AgentIcon name="panel-left" size={16} />
          </button>
        )}

        {currentThreadId && (
          <>
            {/* Title glyph: the static chat icon, which becomes a pulsing dot
                matrix while THIS chat's turn is streaming. */}
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 16,
                height: 16,
                flexShrink: 0,
              }}
            >
              {openIsStreaming ? (
                <StreamingDotMatrix size={22} />
              ) : (
                <AgentIcon
                  name="chat"
                  size={16}
                  style={{ color: "var(--agw-text-muted)" }}
                />
              )}
            </span>
            <span
              key={headerText}
              className={isActivity ? "agw-activity-title" : undefined}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                minWidth: 0,
                fontSize: 13,
                fontWeight: 600,
                color: isActivity ? "var(--agw-text-muted)" : "var(--agw-text)",
                whiteSpace: "nowrap",
                overflow: "hidden",
              }}
              title={isActivity ? `${title} — ${headerText}` : title}
            >
              {isActivity && activityName ? (
                <>
                  {activity?.verb && (
                    <span style={{ flexShrink: 0 }}>{activity.verb}</span>
                  )}
                  {activity?.kind === "folder" ? (
                    <FolderIcon name={activityName} className="agw-file-ico" />
                  ) : (
                    <FileIcon
                      name={activityName}
                      path={activity?.path}
                      className="agw-file-ico"
                    />
                  )}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                    {activityName}
                  </span>
                </>
              ) : (
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                  {headerText}
                </span>
              )}
            </span>
          </>
        )}

        <div style={{ flex: 1 }} />

        <JustFinishedFlash />
        <ContextRing />
        <button
          type="button"
          className="agw-icon-btn"
          title="Settings"
          aria-label="Open settings"
          onClick={() => openSettings()}
        >
          <AgentIcon name="settings" size={16} />
        </button>
        <button
          type="button"
          className="agw-icon-btn"
          title="Toggle side panel"
          aria-label="Toggle side panel"
          aria-pressed={dockOpen}
          onClick={toggleDock}
          style={dockOpen ? { color: "var(--agw-accent)" } : undefined}
        >
          <AgentIcon name="panel-right" size={16} />
        </button>
      </div>

      {/* Body — home (no chat) vs transcript + docked composer. */}
      {!currentThreadId ? (
        <EmptyState onSubmit={send.send} sending={openIsStreaming} onStop={send.stop} />
      ) : (
        <>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              position: "relative",
              display: "flex",
              flexDirection: "column",
            }}
          >
          <div
            ref={containerRef}
            className="agw-scroll"
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              overflowX: "hidden",
              scrollbarGutter: "stable",
              overscrollBehavior: "contain",
            }}
            // WebView2 150.x renderer CHECK (STATUS_BREAKPOINT): a mouse-up
            // while a text selection exists during style/layout churn kills
            // the page — and a streaming transcript IS constant layout churn.
            // While this thread streams, swallow double/triple-click word
            // selection and collapse any stale selection before the press
            // lands. Idle transcripts keep full native selection behavior.
            onMouseDownCapture={
              openIsStreaming
                ? (event) => {
                    if (event.detail > 1) event.preventDefault();
                    const selection = window.getSelection();
                    if (selection && !selection.isCollapsed) selection.removeAllRanges();
                  }
                : undefined
            }
          >
            {threadLoading && messages.length === 0 ? (
              <CenterNote text="Loading…" />
            ) : messages.length === 0 ? (
              <CenterNote text="Send a message to get started." />
            ) : (
              <div ref={contentRef}>
                {/* `select-text` opts this subtree out of the global context-menu
                    suppression (see App.tsx) so right-click → Copy works on the
                    transcript; CSS already makes the text selectable. */}
                <div
                  className="select-text"
                  style={{
                    maxWidth: 896,
                    margin: "0 auto",
                    padding: "24px 24px 16px",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                {turns.map((turn, i) => {
                  if (turn.role === "compaction") {
                    return (
                      <div key={turn.id} style={{ marginTop: i === 0 ? 0 : 22 }}>
                        <CompactionCard
                          beforeTokens={turn.compaction?.beforeTokens ?? 0}
                          afterTokens={turn.compaction?.afterTokens ?? 0}
                          running={turn.compaction?.running ?? false}
                        />
                      </div>
                    );
                  }
                  const isAssistant = turn.role === "assistant";
                  const isLast = i === lastTurnIndex;
                  // Streaming = the final assistant turn while THIS thread's send
                  // is live (a backgrounded turn never animates the open view).
                  const streaming = openIsStreaming && isAssistant && isLast;
                  // Actions render once per turn, when idle (not mid-stream).
                  const showActions = isAssistant ? !streaming : true;
                  // Retry hangs off the last assistant turn only, when idle.
                  const canRetry =
                    isAssistant && isLast && !openIsStreaming && !!lastUserContent;
                  return (
                    <div
                      key={turn.id}
                      data-uturn={turn.role === "user" ? turn.id : undefined}
                      // Entrance is gated to the NEWEST turn only: a turn animates
                      // once as it arrives, so opening a thread never triggers a
                      // bulk "wave" of every turn fading in at once.
                      className={isLast ? "agw-turn-enter" : undefined}
                      style={{ marginTop: i === 0 ? 0 : 22 }}
                    >
                      <MessageBubble
                        message={{
                          role: turn.role,
                          content: turn.content,
                          isThinking: turn.isThinking,
                          attachedSelectedElements: turn.attachedSelectedElements,
                          attachedCommands: turn.attachedCommands,
                          attachedPromptChips: turn.attachedPromptChips,
                        }}
                        events={isAssistant ? turn.events : undefined}
                        showLabel={isAssistant}
                        streaming={streaming}
                        showActions={showActions}
                        onRetry={
                          canRetry
                            ? () => void send.send(lastUserContent)
                            : undefined
                        }
                      />
                    </div>
                  );
                })}
                </div>
                {/* Scroll sentinel — the smooth-scroll target. */}
                <div ref={bottomRef} style={{ height: 1 }} />
              </div>
            )}
          </div>

          {/* Jump rail — one pin per user message, macOS-dock magnify on hover. */}
          {userPins.length > 1 && (
            <JumpRail pins={userPins} onJump={jumpToTurn} />
          )}
          </div>

          {/* Composer dock. NB: no `overflow-x:hidden` here — that would force
              overflow-y to `auto` and clip the model selector's upward dropdown. */}
          <div
            className="shrink-0 min-w-0 px-4 pt-4 pb-2 relative"
            style={{ background: "var(--agw-conversation)" }}
          >
            {/* Docked checklist (todo_write) for the open thread — sits above
                the composer, per-thread so background turns don't bleed in. */}
            <AgentTaskPanel />
            {/* Docked "queued message" card — a mid-turn injection waiting to
                ride in with the next tool result. Stacks under the task panel,
                directly above the composer (same dock slot). */}
            <AgentQueuedDock />
            {send.pendingApproval && (
              <ApprovalBar
                toolName={send.pendingApproval.toolName}
                args={send.pendingApproval.args}
                onApprove={send.approve}
                onApproveAlways={send.approveAlways}
                onReject={send.reject}
              />
            )}
            {/* Interactive `ask_question` tray — rises from behind the composer
                exactly like the task panel: narrower so it clears the composer's
                rounded corners, tucked ~12px behind its top edge. */}
            <QuestionPrompt />
            {/* Reply-suggestion drum — hidden while streaming; a new send
                clears the suggestions themselves. */}
            {!openIsStreaming && suggestions.length > 0 && (
              <SuggestDrum
                suggestions={suggestions}
                onPick={(text) => {
                  setDraft(draftKey, text);
                  if (currentThreadId) clearSuggestions(currentThreadId);
                }}
              />
            )}
            <AgentComposer
              value={draft}
              onValueChange={(text) => setDraft(draftKey, text)}
              onSubmit={send.send}
              onActionCommand={(actionId) => {
                if (actionId === "suggest") {
                  if (currentThreadId) requestReplySuggestions(currentThreadId);
                } else {
                  void send.compact();
                }
              }}
              sending={openIsStreaming}
              onStop={send.stop}
            />
          </div>
        </>
      )}
    </div>
  );
};

/**
 * Header completion flash. When any turn (foreground or background) finishes,
 * the store stamps `justFinished`; this shows a small pill naming that chat for
 * a few seconds, then auto-dismisses. Clicking it opens the chat that finished.
 * Isolated in its own component so its timer + subscription don't re-render the
 * whole conversation header.
 */
const FLASH_MS = 5000;
const JustFinishedFlash: React.FC = () => {
  const justFinished = useAgentChatStore((s) => s.justFinished);
  const dismiss = useAgentChatStore((s) => s.dismissJustFinished);
  const selectThread = useAgentChatStore((s) => s.selectThread);

  useEffect(() => {
    if (!justFinished) return;
    // Re-arms on every new completion (each carries a fresh object identity).
    const t = window.setTimeout(() => dismiss(), FLASH_MS);
    return () => window.clearTimeout(t);
  }, [justFinished, dismiss]);

  return (
    <AnimatePresence>
      {justFinished && (
        <motion.button
          key={`${justFinished.threadId}:${justFinished.at}`}
          type="button"
          className="agw-done-flash"
          title={`${justFinished.title} — finished`}
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          onClick={() => {
            void selectThread(justFinished.threadId);
            dismiss();
          }}
        >
          <AgentIcon name="check" size={13} />
          <span className="agw-done-flash-label">{justFinished.title}</span>
          <span className="agw-done-flash-sub">finished</span>
        </motion.button>
      )}
    </AnimatePresence>
  );
};

/** Minimal centered status line for transcript-level states. */
const CenterNote: React.FC<{ text: string }> = ({ text }) => (
  <div
    style={{
      height: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      fontSize: 13,
      color: "var(--agw-text-subtle)",
    }}
  >
    {text}
  </div>
);
