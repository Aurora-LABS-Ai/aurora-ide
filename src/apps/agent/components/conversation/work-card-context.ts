/**
 * Agent Window — "this row is drawn inside a work card's running window"
 * [context].
 *
 * The running window shows the newest steps of a stretch while it works, as a
 * list of lines. A live thought auto-opens its full text in the transcript
 * (Transcript → Reasoning "Auto"), and inside a 380px window that one row
 * filled the whole thing with monospace reasoning and pushed the steps out
 * (seen live 2026-10-15). Rows read this to stay folded there; the open card
 * and the transcript outside are unchanged.
 */

import { createContext, useContext } from "react";

export const WorkCardWindowContext = createContext(false);

/** True while rendering inside a work card's running window. */
export function useInWorkCardWindow(): boolean {
  return useContext(WorkCardWindowContext);
}
