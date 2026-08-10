/**
 * Agent Window — chapter heading inside an assistant turn.
 *
 * The agent naming the part of the work it is starting, via the `chapter` tool.
 * It renders at the exact point the call landed, so a long turn can be scanned
 * from its headings instead of read end to end — and it OWNS the rows beneath
 * it up to the next chapter, which it can collapse out of the way once that
 * part of the work is done.
 *
 * Why an `<h4>` wrapping a `<button>` rather than either alone: the two roles
 * are both real and neither substitutes for the other. A screen-reader user
 * navigating a long reply by heading is the person this feature helps most, and
 * a button with heading styling is invisible to that; a heading that is not a
 * button announces nothing about the content it hides. The pair is the standard
 * disclosure pattern and costs one element. `h4` sits under the window's own
 * structure (the pane title) and level with the reply's own markdown headings,
 * which is exactly the relationship — a chapter names a section of one turn, it
 * does not outrank the document.
 *
 * Deliberately not a card, and deliberately not big bold text. A reply is full of
 * bold sentences the model wrote itself, so a chapter set in heavier prose is
 * indistinguishable from one — it has to be a different KIND of type, not a
 * louder amount of it. Hence the label-plus-rule form, built from the same
 * `agw-timeline-rule` this window already uses for a named boundary in the
 * timeline (see the tool group header).
 *
 * Left-aligned, not centred between two rules: every other line in the turn
 * starts at the same left edge, and a centred title breaks that column for the
 * one element whose job is to let the eye run straight down it.
 */

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";

export function ChapterHeading({
  title,
  open,
  bodyId,
  onToggle,
}: {
  title: string;
  /** Whether this chapter's body is showing. */
  open: boolean;
  /** Id of the region this heading controls, for `aria-controls`. */
  bodyId: string;
  onToggle: () => void;
}) {
  return (
    <h4 className="agw-chapter">
      <button
        type="button"
        className="agw-chapter-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <AgentIcon
          name="chevron-down"
          size={13}
          className="agw-chapter-chev"
          // Rotation, not a second glyph: the chevron is the same object
          // pointing somewhere else, and swapping icons reads as a state change
          // in the control rather than in what it controls.
          style={{ transform: open ? "none" : "rotate(-90deg)" }}
        />
        <span className="agw-chapter-title">{title}</span>
        <span className="agw-timeline-rule" aria-hidden="true" />
      </button>
    </h4>
  );
}
