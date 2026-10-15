/**
 * The Tauri commands behind work cards: which cards a conversation has open.
 * Rust: `agent_runtime/work_cards.rs`.
 */

import { auroraInvoke } from "@/kernel/lib/ipc/runtime";

/** Mirrors Rust `WorkCards`. */
export interface SavedWorkCards {
  /** Ids of the cards the reader opened, oldest first. */
  open: string[];
}

/** The cards opened in a conversation. Empty when none were. */
export function getWorkCards(threadId: string): Promise<SavedWorkCards> {
  return auroraInvoke<SavedWorkCards>("agent_work_cards_get", { threadId });
}

/** Open or close one card; resolves to the conversation's open cards. */
export function setWorkCard(threadId: string, cardId: string, open: boolean): Promise<SavedWorkCards> {
  return auroraInvoke<SavedWorkCards>("agent_work_card_set", { threadId, cardId, open });
}
