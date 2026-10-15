/**
 * The Tauri commands behind answer boxes: what a conversation's boxes were
 * left at. Rust: `agent_runtime/answer_boxes.rs`.
 */

import { auroraInvoke } from "@/kernel/lib/ipc/runtime";

/** Input id → value, for one box. */
export type AnswerBoxValues = Record<string, number>;

/** Mirrors Rust `AnswerBoxes`: box key → its values. */
export interface SavedAnswerBoxes {
  boxes: Record<string, AnswerBoxValues>;
}

/** Everything saved for a conversation's boxes. Empty when nothing was changed. */
export function getAnswerBoxes(threadId: string): Promise<SavedAnswerBoxes> {
  return auroraInvoke<SavedAnswerBoxes>("agent_answer_boxes_get", { threadId });
}

/** Save one box's values; an empty object forgets the box. */
export function setAnswerBox(
  threadId: string,
  key: string,
  values: AnswerBoxValues,
): Promise<SavedAnswerBoxes> {
  return auroraInvoke<SavedAnswerBoxes>("agent_answer_box_set", { threadId, key, values });
}
