/**
 * Agent Window — "this row is drawn inside a work card's running window"
 * [context].
 *
 * The running window shows the newest steps of a stretch while it works, as a
 * list of lines. A live thought auto-opens its full text in the transcript
 * (Transcript → Reasoning "Auto"), and inside the window (then 380px) that one row
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

/**
 * "This row is inside a work card and the turn is still running", closed (the
 * window) or open.
 *
 * The TURN, not the card's stretch. A card stops being the live edge whenever
 * text lifts out below it, and the stretch-level flag regrouped and folded
 * every run inside an open card at that moment, then unfolded them when the
 * next call arrived (Alvan, 2026-10-24: "folded asap"). Held for the whole
 * turn, runs group once, when the turn ends. Thoughts read it too, and stay
 * on their line instead of opening while written.
 *
 * A tool run in the transcript grows a "N calls · N done" header at its third
 * call, sits in its own height-capped box, and folds to that header once
 * something lands below it. Inside a running card none of that is needed: the
 * card already bounds the work and drops its oldest rows. With a fast model it
 * was most of what moved: a round of two calls every 0.8s, each run folding
 * 600ms after the next thought (Alvan, 2026-10-18; probe
 * `Documents/aurora-work-card-motion-designs.html`, 02). Runs read this and
 * draw as plain rows that fade in instead. Open AND closed, so opening a
 * running card does not regroup its runs under the click; once the turn ends,
 * runs group as they do everywhere else.
 */
export const LiveWorkCardContext = createContext(false);

/** True while rendering inside a work card during a turn that is still running. */
export function useInLiveWorkCard(): boolean {
  return useContext(LiveWorkCardContext);
}
