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

import React, { useCallback, useEffect, useMemo } from "react";
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
import { useSettingsStore } from "../../store/useSettingsStore";
import { FileIcon, FolderIcon } from "../../components/explorer/FileIcons";
import { useAgentAutoScroll } from "../hooks/useAgentAutoScroll";
import { useAgentWindowSend } from "../hooks/useAgentWindowSend";
import { useAgentTeamNotifier } from "../hooks/useAgentTeamNotifier";

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
            className="shrink-0 min-w-0 px-4 md:px-8 lg:px-16 pt-4 pb-2 relative"
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
            <AgentComposer
              value={draft}
              onValueChange={(text) => setDraft(draftKey, text)}
              onSubmit={send.send}
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
      fontSize: 13.5,
      color: "var(--agw-text-subtle)",
    }}
  >
    {text}
  </div>
);
