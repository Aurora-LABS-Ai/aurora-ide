/**
 * Agent Window — a conversation docked in the side panel [right-dock tab].
 *
 * A second, fully live chat beside the main one. It exists for a specific job:
 * comparing two models on the same prompt. Doing that by switching between
 * conversations means never seeing both answers form — you read one, navigate,
 * and read the other from its finished state. Side by side, the comparison is
 * the thing you actually watch.
 *
 * So this is not a preview. It streams, it takes tool approvals, it can be
 * stopped, and it has a real composer — the same `AgentComposer` and
 * `MessageBubble` the main pane uses, so a docked chat is not a lesser version
 * of the one beside it. What differs is only what the width can carry.
 *
 * Two conversations can stream at once because nothing in the pipeline was ever
 * window-scoped: the Rust runtime locks per thread, live transcripts are keyed
 * by thread id in `useAgentChatStore`, and `useAgentWindowSend` takes a binding
 * so this panel's composer, stop and approvals act on ITS thread.
 *
 * The transcript source follows one rule, the same one `selectThread` uses: a
 * live turn wins over the persisted copy, because in-flight text isn't written
 * to disk until the turn ends. When the turn settles, disk becomes authoritative
 * again and is re-read.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { AgentComposer } from "@/apps/agent/components/composer/AgentComposer";
import { AgentQueuedDock } from "@/apps/agent/components/composer/AgentQueuedDock";
import { ApprovalBar } from "@/apps/agent/components/tools/ApprovalBar";
import { MessageBubble } from "@/apps/agent/components/conversation/MessageBubble";
import { StreamingDotMatrix } from "@/apps/agent/components/theme/StreamingDotMatrix";
import { buildTurns, turnWorkedMs } from "@/apps/agent/components/conversation/timeline";
import { JumpToLatest } from "@/apps/agent/components/conversation/JumpToLatest";
import { useAgentAutoScroll } from "@/apps/agent/hooks/conversation/useAgentAutoScroll";
import { useAgentWindowSend } from "@/apps/agent/hooks/conversation/useAgentWindowSend";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentDraftStore } from "@/apps/agent/store/conversation/useAgentDraftStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { ConversationScopeContext } from "@/apps/agent/lib/thread/conversation-scope";
import { threadService, type DbThread } from "@/apps/agent/services/threads/thread-service";

/**
 * The docked composer keeps its OWN draft, separate from the main pane's, even
 * when both show the same conversation. Two visible inputs whose text mirrors
 * each other as you type reads as a glitch, not a feature.
 */
const dockDraftKey = (threadId: string) => `dock:${threadId}`;

export const ChatPanel: React.FC<{
  threadId: string;
  /** The project this conversation belongs to (carried on the tab). */
  projectRoot: string | null;
  /** Tab label — shown until the transcript loads and supplies the real title. */
  fallbackTitle: string;
}> = ({ threadId, projectRoot, fallbackTitle }) => {
  const live = useAgentChatStore((s) => s.liveTurns[threadId]);
  const closeTab = useAgentWorkspaceStore((s) => s.closeTab);
  const clearUnseenDone = useAgentChatStore((s) => s.clearUnseenDone);

  // One record, stamped with the thread it describes. Deriving "still loading"
  // from a stale stamp (rather than resetting three flags when `threadId`
  // changes) keeps the reset out of an effect — an effect that writes state
  // synchronously costs an extra render pass for something already known.
  const [record, setRecord] = useState<{
    id: string;
    thread: DbThread | null;
    missing: boolean;
  } | null>(null);
  const aliveRef = useRef(true);

  const current = record?.id === threadId ? record : null;
  const loaded = current?.thread ?? null;
  const loading = current === null;
  const missing = current?.missing ?? false;

  const pull = useCallback(() => {
    void threadService
      .loadThread(threadId)
      .then((thread) => {
        if (!aliveRef.current) return;
        setRecord({ id: threadId, thread: thread ?? null, missing: !thread });
      })
      .catch((err) => {
        if (!aliveRef.current) return;
        console.error(`[chat-panel] failed to load chat ${threadId}:`, err);
        setRecord({ id: threadId, thread: null, missing: true });
      });
  }, [threadId]);

  useEffect(() => {
    aliveRef.current = true;
    pull();
    return () => {
      aliveRef.current = false;
    };
  }, [pull]);

  // Disk becomes authoritative again the moment a turn settles, so re-read then
  // — that is what folds the runtime's own record (final timestamps, persisted
  // ids) into this panel. Keyed on the live turn DISAPPEARING, not on a timer.
  const streaming = !!live;
  useEffect(() => {
    if (streaming) return;
    pull();
  }, [streaming, pull]);

  // Watching a docked chat counts as watching it: clear the rail's "finished
  // while you were looking elsewhere" dot rather than making the user open the
  // chat in the main pane just to dismiss a marker for work they just saw.
  useEffect(() => {
    if (!streaming) clearUnseenDone(threadId);
  }, [streaming, threadId, clearUnseenDone]);

  // A live turn outranks the persisted copy — in-flight text isn't on disk yet.
  const thread = live ?? loaded;
  const title = thread?.title || fallbackTitle;

  const send = useAgentWindowSend(
    useMemo(
      () => ({ threadId, projectRoot, getSeed: () => loaded }),
      [threadId, projectRoot, loaded],
    ),
  );

  const scope = useMemo(
    () => ({ threadId, projectRoot }),
    [threadId, projectRoot],
  );

  const draftKey = dockDraftKey(threadId);
  const draft = useAgentDraftStore((s) => s.drafts[draftKey] ?? "");
  const setDraft = useAgentDraftStore((s) => s.setDraft);

  const showActivityInTitle = useAgentSettingsStore((s) => s.showActivityInTitle);
  const activity = useAgentChatStore((s) => s.activityByThread[threadId]);
  const isActivity = streaming && showActivityInTitle && !!activity;

  const messages = useMemo(() => thread?.messages ?? [], [thread]);
  const turns = useMemo(() => buildTurns(messages), [messages]);
  const lastTurnIndex = turns.length - 1;

  const { containerRef, contentRef, bottomRef, showJump, jumpToBottom } =
    useAgentAutoScroll({
      isStreaming: streaming,
      resetKey: threadId,
      growthKey: messages.length,
    });

  if (missing) {
    return (
      <div className="agw-tp-root">
        <div className="agw-tp-head">
          <span className="agw-tp-title">{fallbackTitle}</span>
        </div>
        <div className="agw-team-empty" style={{ flex: 1 }}>
          <AgentIcon name="chat" size={22} />
          <span>This chat no longer exists.</span>
          <button
            type="button"
            className="agw-btn-ghost"
            onClick={() => closeTab(`chat:${threadId}`)}
          >
            Close tab
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="agw-tp-root">
      <div className="agw-tp-head">
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
          {streaming ? (
            <StreamingDotMatrix size={20} />
          ) : (
            <AgentIcon name="chat" size={14} style={{ color: "var(--agw-text-muted)" }} />
          )}
        </span>
        <span className="agw-tp-title" title={title} style={{ flex: 1, minWidth: 0 }}>
          {isActivity ? activity!.label : title}
        </span>
        {/* Title only, deliberately. There WAS an "open in main view" button
            here, drawn with a panel glyph — which reads as the main header's
            side-panel toggle, a different control whose meaning is nonsense
            inside the panel it opens. It was redundant besides: clicking the
            chat's row in the left rail already opens it in the main pane. */}
      </div>

      <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
        <div ref={containerRef} className="agw-tp-body agw-scroll">
          {loading && messages.length === 0 ? (
            <div className="agw-team-empty">
              <span>Loading…</span>
            </div>
          ) : messages.length === 0 ? (
            <div className="agw-team-empty">
              <AgentIcon name="chat" size={22} />
              <span>No messages yet.</span>
            </div>
          ) : (
            <div ref={contentRef} className="agw-chatpanel-turns select-text">
              {/* Declares which conversation these bubbles belong to, for the
                  components too deep to reach by prop — a tool card's "open in
                  Canvas" would otherwise load the OPEN chat's artifact. */}
              <ConversationScopeContext.Provider value={scope}>
              {turns.map((turn, i) => {
                const isAssistant = turn.role === "assistant";
                const isLast = i === lastTurnIndex;
                const turnStreaming = streaming && isAssistant && isLast;
                return (
                  <div key={turn.id} style={{ marginTop: i === 0 ? 0 : 20 }}>
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
                      streaming={turnStreaming}
                      workedMs={isAssistant ? turnWorkedMs(turn) : null}
                      startedAt={isAssistant ? turn.startedAt : undefined}
                      outputTokens={isAssistant ? turn.outputTokens : undefined}
                      outputTokensEstimated={isAssistant ? turn.outputTokensEstimated : undefined}
                      // No per-message action row here: at dock width it would
                      // crowd the text it belongs to, and every action it offers
                      // is available on the same turn in the main view.
                      showActions={false}
                    />
                  </div>
                );
              })}
              </ConversationScopeContext.Provider>
              <div ref={bottomRef} style={{ height: 1 }} />
            </div>
          )}
        </div>

        <JumpToLatest
          show={showJump}
          streaming={streaming}
          onJump={() => jumpToBottom()}
        />
      </div>

      {/* The composer only exists once there is a transcript to send into: a
          turn is seeded from the loaded thread, so pressing send before the
          load resolves would do nothing at all. A control that silently
          discards a message is worse than one that isn't there yet.

          No `onActionCommand`: that prop gates BOTH `/compact` and `/suggest`
          in the composer's menu, and reply chips aren't rendered at this width.
          Offering an action whose result is invisible would be the same dead
          control in a different place. Opening the chat from the left rail puts
          it in the main pane, where both work. */}
      {!loading && (
        <div className="agw-composer-dock">
          {/* Sending while this chat streams QUEUES the text as a mid-turn
              injection. Without this card the message would appear to vanish. */}
          <AgentQueuedDock threadId={threadId} draftKey={draftKey} />
          {send.pendingApproval && (
            <ApprovalBar
              toolName={send.pendingApproval.toolName}
              args={send.pendingApproval.args}
              onApprove={send.approve}
              onApproveAlways={send.approveAlways}
              onReject={send.reject}
            />
          )}
          <AgentComposer
            threadId={threadId}
            projectRoot={projectRoot}
            value={draft}
            onValueChange={(text) => setDraft(draftKey, text)}
            onSubmit={send.send}
            sending={streaming}
            onStop={send.stop}
            placeholder="Message this chat"
          />
        </div>
      )}
    </div>
  );
};
