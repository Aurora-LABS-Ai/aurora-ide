import React from "react";

import { type ToolCall, toolStatus } from "@/apps/agent/components/tools/tool-call";

/**
 * `design_guidelines` in the transcript — a rule across the pane, not a row.
 *
 * ## Why it is not a tool card
 *
 * Every other row reports an act on the workspace: a file was read, a pattern
 * was searched, an edit landed. Its tick means the act finished, its body is
 * what came back, and opening it is how you find out what happened.
 *
 * This call does none of that. It opens no file, runs no process, and changes
 * nothing. What it returns is a standing instruction — fixed, compiled into the
 * binary, identical on every call — and its effect is on everything that comes
 * AFTER it. That is a boundary, not an event, so it is drawn as one: a hairline
 * with the label inset in the middle and the lines running out to both edges.
 *
 * What follows from that:
 *
 * - **No tick.** Nothing completed. A green check would claim a result that
 *   does not exist.
 * - **No chevron, and no click target.** The body is the same text every time,
 *   so a dropdown would open onto the one thing nobody needs to re-read.
 * - **No topic.** `build` / `writing` / `audit` decide what the model reads;
 *   the reader is told which rules are in force by the work that follows, not
 *   by a segment on a divider.
 * - **Not interactive, so no interaction states.** No hover, no focus ring —
 *   which is also the first rule the doctrine it loads enforces.
 *
 * A FAILED call never reaches here: `ToolCallCard` sends it to the standard
 * card instead, because an error has a message worth reading and a body worth
 * opening. Failure is possible only through an invalid `topic`; the payload
 * itself cannot fail, as it touches no disk.
 *
 * ## The mark
 *
 * Three translucent discs — subtractive colour mixing, the oldest sign for
 * "this is about how a thing looks". It replaces the artboard glyph, which was
 * a square with two guides through it and therefore wore the same silhouette as
 * every file and panel mark in the window, on the one entry that touches
 * neither.
 *
 * Colour comes from the theme, never from here — the same rule
 * `CanvasCategoryMark` follows. Each disc is a class, and
 * `08-transcript-flow.css` inks it from `--agw-dg-*`, so a custom theme's
 * accent flows through the first disc and the light scheme can darken the other
 * two without touching this file.
 */
export const DoctrineRule: React.FC<{
  call: ToolCall;
  isActivelyStreaming?: boolean;
}> = ({ call, isActivelyStreaming = false }) => {
  const running = toolStatus(call, isActivelyStreaming) === "running";

  return (
    <div className="agw-drule">
      <span className="agw-drule-lbl">
        <DoctrineMark />
        {/* The live label shimmers rather than spinning: nothing is being
         * waited on that could stall, so a spinner would imply a duration this
         * call does not have. */}
        <span className={running ? "agw-shimmer" : undefined}>
          {running ? "Loading design guideline…" : "Design guideline"}
        </span>
      </span>
    </div>
  );
};

/**
 * The three discs, authored in the 24 box every `AgentIcon` glyph uses so the
 * mark sits on the same optical grid as its neighbours. Rendered at 13px to
 * match the rule's micro type.
 *
 * Fill opacity rides `--agw-dg-o` from CSS rather than a `fill-opacity`
 * attribute here: a CSS declaration outranks a presentation attribute, so an
 * attribute would be silently flattened the moment any rule set that property.
 */
const DoctrineMark: React.FC = () => (
  <svg
    className="agw-dg-mark"
    xmlns="http://www.w3.org/2000/svg"
    width={13}
    height={13}
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
  >
    <circle className="agw-dg-a" cx="9.2" cy="9.6" r="5.4" />
    <circle className="agw-dg-b" cx="14.8" cy="9.6" r="5.4" />
    <circle className="agw-dg-c" cx="12" cy="15" r="5.4" />
  </svg>
);
