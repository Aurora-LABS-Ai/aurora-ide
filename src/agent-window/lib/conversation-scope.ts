/**
 * Agent Window — which conversation a subtree belongs to (leaf, non-component).
 *
 * The window used to render exactly one conversation, so anything deep in the
 * tree could read `useAgentChatStore.currentThreadId` and be right. A chat
 * docked in the side panel breaks that assumption: two conversations are on
 * screen, and a component that reads the OPEN one now describes — or acts on —
 * the wrong chat.
 *
 * Props are the fix wherever the chain is short (see `AgentComposer`). This
 * exists for the deep cases, where threading a prop through every intermediate
 * renderer would touch a dozen files that have no interest in the answer: a
 * tool card buried inside a message bubble is four levels below anything that
 * knows which chat it is.
 *
 * Absent provider = the open chat, so every existing caller keeps working
 * unchanged and only the docked panel has to declare itself.
 */

import { createContext, useContext } from "react";

export interface ConversationScope {
  threadId: string | null;
  /** The project the conversation belongs to — not necessarily the window's. */
  projectRoot: string | null;
}

export const ConversationScopeContext = createContext<ConversationScope | null>(null);

/**
 * The conversation this subtree renders, or `null` when it is whichever chat is
 * open. Callers resolve `null` against the store themselves rather than having
 * it resolved here, so a component that genuinely wants the open chat can say
 * so instead of silently receiving it.
 */
export function useConversationScope(): ConversationScope | null {
  return useContext(ConversationScopeContext);
}
