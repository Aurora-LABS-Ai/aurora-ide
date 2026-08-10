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

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { AgentComposer } from "@/apps/agent/components/composer/AgentComposer";
import { AgentQueuedDock } from "@/apps/agent/components/composer/AgentQueuedDock";
import { ApprovalBar } from "@/apps/agent/components/tools/ApprovalBar";
import { ContextRing } from "@/apps/agent/components/composer/ContextRing";
import { TaskIndicator } from "@/apps/agent/components/panels/TaskIndicator";
import { EmptyState } from "@/apps/agent/components/conversation/EmptyState";
import { MessageBubble } from "@/apps/agent/components/conversation/MessageBubble";
import { JumpRail } from "@/apps/agent/components/shell/JumpRail";
import { JumpToLatest } from "@/apps/agent/components/conversation/JumpToLatest";
import { CompactionCard } from "@/apps/agent/components/conversation/CompactionCard";
import { QuestionPrompt } from "@/apps/agent/components/tools/QuestionPrompt";
import { StreamingDotMatrix } from "@/apps/agent/components/theme/StreamingDotMatrix";
import { buildTurns, turnWorkedMs, type AgwTurn } from "@/apps/agent/components/conversation/timeline";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
import { useAgentUiStore } from "@/apps/agent/store/ui/useAgentUiStore";
import { useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";
import { useAgentDraftStore } from "@/apps/agent/store/conversation/useAgentDraftStore";
import { useAgentSuggestStore } from "@/apps/agent/store/composer/useAgentSuggestStore";
import { useSettingsStore } from "@/kernel/store/useSettingsStore";
import { FileIcon, FolderIcon } from "@/kernel/ui/FileIcons";
import { useAgentAutoScroll } from "@/apps/agent/hooks/conversation/useAgentAutoScroll";
import {
  requestReplySuggestions,
  useAgentWindowSend,
} from "@/apps/agent/hooks/conversation/useAgentWindowSend";
import { useAgentTeamNotifier } from "@/apps/agent/hooks/conversation/useAgentTeamNotifier";

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
  const drumRef = useRef<HTMLDivElement>(null);
  const count = suggestions.length;
  const index = Math.min(active, count - 1);

  const step = (direction: number) =>
    setActive((current) => (Math.min(current, count - 1) + direction + count) % count);

  /**
   * Bound natively: React delegates `wheel` at the root with `{ passive: true }`,
   * so `preventDefault()` from an `onWheel` prop is discarded (and warns). The
   * drum has to swallow the wheel or the transcript scrolls away underneath
   * while the user is rotating through replies.
   */
  useEffect(() => {
    const drum = drumRef.current;
    if (!drum || count < 2) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const now = Date.now();
      if (now - lastStepRef.current < DRUM_STEP_COOLDOWN_MS) return;
      lastStepRef.current = now;
      setActive((current) => (Math.min(current, count - 1) + (event.deltaY > 0 ? 1 : -1) + count) % count);
    };
    drum.addEventListener("wheel", onWheel, { passive: false });
    return () => drum.removeEventListener("wheel", onWheel);
  }, [count]);

  return (
    <div
      ref={drumRef}
      className="agw-suggest-drum"
      role="listbox"
      aria-label="Suggested replies — scroll to rotate, click to use"
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
  const rewindToMessage = useAgentChatStore((s) => s.rewindToMessage);
  const newChat = useAgentChatStore((s) => s.newChat);

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

  /**
   * Turns grouped into per-exchange SECTIONS: a section opens at each user turn
   * and holds the assistant turn(s) answering it.
   *
   * This exists for `position: sticky`, and it is not optional for it. Sticky is
   * bounded by the element's PARENT, not by the scroller — so while every turn
   * was a flat sibling of one full-height column, every pinned user message
   * stayed pinned for the rest of the transcript and they piled up at the top,
   * three and four cards deep. Sectioning gives each pinned question a parent
   * that ends where its answer ends, so it releases as its own exchange scrolls
   * past and the next question takes the top. That is the whole mechanism; there
   * is no z-index trick that substitutes for it.
   *
   * Kept unconditional rather than gated on the preference: an extra wrapper div
   * costs nothing when the transcript is flat, and building the tree differently
   * per preference would remount every turn on toggle.
   *
   * `index` is carried through because it is the FLAT position — turn spacing,
   * "is this the newest turn", and the streaming test are all transcript-wide
   * questions, and a section-local index would answer all three wrongly.
   */
  const sections = useMemo(() => {
    const out: {
      key: string;
      items: { turn: (typeof turns)[number]; index: number }[];
    }[] = [];
    turns.forEach((turn, index) => {
      if (turn.role === "user" || out.length === 0) {
        out.push({ key: turn.id, items: [] });
      }
      out[out.length - 1].items.push({ turn, index });
    });
    return out;
  }, [turns]);

  // Why a retry didn't happen. Cleared on the next attempt — a stale
  // failure notice next to a working button is worse than none.
  const [retryError, setRetryError] = useState<string | null>(null);

  /**
   * Re-run an assistant turn.
   *
   * Rewinds the thread — transcript and Rust session both — to just before
   * the user message that opened this turn, then sends that message again.
   * The retried turn REPLACES the failed one rather than stacking after it,
   * so history gains no duplicate and the prompt-cache prefix survives.
   */
  const retryTurn = useCallback(
    async (turn: AgwTurn) => {
      setRetryError(null);
      try {
        const content = await rewindToMessage(turn.id);
        if (content) await send.send(content);
      } catch (err) {
        // The runtime refuses to rewind under a live turn. Surface it
        // rather than leaving a dead button — the user's next move is to
        // stop the turn first.
        console.error("[agent-chat] retry failed:", err);
        setRetryError(err instanceof Error ? err.message : String(err));
      }
    },
    [rewindToMessage, send],
  );
  // Dedicated smooth auto-scroll. A ResizeObserver follows EVERY transcript
  // growth — token text, reasoning, tool cards — and glides to the bottom while
  // streaming, unless the user scrolled up to read (then the jump pill appears).
  const { containerRef, contentRef, bottomRef, showJump, jumpToBottom } =
    useAgentAutoScroll({
      isStreaming: openIsStreaming,
      resetKey: currentThreadId,
      growthKey: messages.length,
    });

  /**
   * With the question pinned, a new turn lands the QUESTION at the top of the
   * viewport rather than the transcript at its bottom — the answer then grows
   * downward under it, which is the whole point of pinning.
   *
   * Declared AFTER `useAgentAutoScroll` on purpose: effects run in declaration
   * order, so this settles after the hook's own growth effect has scrolled to
   * the bottom, and wins without the hook needing to know pinning exists. It
   * does not then fight the stream either — landing here leaves the reader far
   * from the bottom, so the hook's `nearBottom` gate stops it following, and its
   * "jump to latest" pill is the way back.
   *
   * `scrollIntoView` is deliberately avoided: it scrolls every scrollable
   * ancestor, and this transcript sits inside the window's own panes.
   */
  const stickyUser = useAgentThemeStore((s) => s.transcriptStickyUser);
  useEffect(() => {
    if (!stickyUser) return;
    const el = containerRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const questions = content.querySelectorAll<HTMLElement>("[data-uturn]");
    const newest = questions[questions.length - 1];
    if (!newest) return;
    // Its section is what actually scrolls; the question is pinned inside it.
    const section = newest.closest<HTMLElement>(".agw-section") ?? newest;
    el.scrollTop = section.offsetTop - content.offsetTop;
  }, [stickyUser, messages.length, containerRef, contentRef]);

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
                fontSize: "var(--agw-fs-ui)",
                fontWeight: "var(--agw-fw-medium)",
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
        {/* The two "how is this turn going" readouts, together: what the agent
            is working through, and how much context it has left. */}
        <TaskIndicator />
        <ContextRing />
        {/* Starting a new chat lived only on left-rail hover, which meant it
            existed only if you already had the rail open and knew to reach for
            it. It is the most common action in the window, so it belongs where
            the other always-visible controls are. Same behaviour as the rail's
            pencil: a draft in the CURRENT project, materialised on first send.

            Absent rather than disabled on the empty state: with no thread open
            you are ALREADY in a new chat, so the control has nothing to do. A
            greyed-out button still asks the reader to work out why it is dead. */}
        {(currentThreadId || currentThread) && (
          <button
            type="button"
            className="agw-icon-btn"
            title="New chat"
            aria-label="Start a new chat"
            onClick={() => newChat()}
          >
            <AgentIcon name="inspect" size={16} />
          </button>
        )}
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
                    // 768px column → ~720px measure at 15px. The old 896px ran
                    // ~110 chars/line, which reads as a document dump; premium
                    // chat surfaces cap prose near this width and let the
                    // side whitespace breathe. Keep in sync with the composer
                    // (max-w-3xl) and .agw-tasks/.agw-queued (45rem).
                    maxWidth: 768,
                    margin: "0 auto",
                    padding: "24px 24px 16px",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                {sections.map((section) => (
                  <div key={section.key} className="agw-section">
                {section.items.map(({ turn, index: i }) => {
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
                  // Retry is offered on ANY assistant turn, not just the
                  // newest: a turn that failed several messages ago is still
                  // worth re-running, and rewinding makes that well-defined.
                  const canRetry = isAssistant && !openIsStreaming;
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
                        workedMs={isAssistant ? turnWorkedMs(turn) : null}
                        startedAt={isAssistant ? turn.startedAt : undefined}
                        showActions={showActions}
                        onRetry={canRetry ? () => void retryTurn(turn) : undefined}
                      />
                    </div>
                  );
                })}
                  </div>
                ))}
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

          {/* Back to the newest content. Centred, so it never collides with the
              jump rail on the right edge. */}
          <JumpToLatest
            show={showJump}
            streaming={openIsStreaming}
            onJump={() => jumpToBottom()}
          />
          </div>

          {/* Composer dock. NB: no `overflow-x:hidden` here — that would force
              overflow-y to `auto` and clip the model selector's upward dropdown. */}
          {/* `data-drum` tells the docked cards to stop tucking. They hide
              their bottom edge 12px behind whatever follows, which works only
              because the composer is opaque and paints over the strip — the
              suggestion drum is chrome-less and masked, so a card tucked
              behind it shows its own open edge and the drum's rows land on
              top of the card. */}
          <div
            className="agw-composer-dock"
            data-drum={(!openIsStreaming && suggestions.length > 0) || undefined}
          >
            {/* A retry that didn't happen says why, next to where the user
                just clicked. Dismissible, and cleared by the next attempt. */}
            {retryError && (
              <div className="agw-retry-error" role="status">
                <span>{retryError}</span>
                <button
                  type="button"
                  className="agw-retry-error-close"
                  onClick={() => setRetryError(null)}
                  aria-label="Dismiss"
                >
                  <AgentIcon name="close" size={12} />
                </button>
              </div>
            )}
            {/* The checklist (`todo`) and the live background processes
                (shell_spawn) used to mount their own cards HERE, which pushed
                the transcript down every time one woke up. Processes are now a
                chip in the composer rail (see ComposerRail), which has a fixed
                height, and the checklist moved to the header's TaskIndicator —
                so ambient state costs the reading area nothing. Only
                turn-BLOCKING surfaces still dock above the composer. */}
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
      fontSize: "var(--agw-fs-ui)",
      color: "var(--agw-text-subtle)",
    }}
  >
    {text}
  </div>
);
