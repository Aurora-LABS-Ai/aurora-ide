/**
 * Agent Window — chapter heading inside an assistant turn.
 *
 * The agent naming the part of the work it is starting, via the `chapter` tool.
 * It renders at the exact point the call landed, so a long turn can be scanned
 * from its headings instead of read end to end.
 *
 * Why an `<h4>` and not a styled `<div>`: a screen-reader user navigating a long
 * reply by heading is the person this feature helps most, and a div with heading
 * type is invisible to that. `h4` sits under the window's own structure (the
 * pane title) and level with the reply's own markdown headings, which is exactly
 * the relationship — a chapter names a section of one turn, it does not outrank
 * the document.
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

export function ChapterHeading({ title }: { title: string }) {
  return (
    <h4 className="agw-chapter">
      <span className="agw-chapter-title">{title}</span>
      <span className="agw-timeline-rule" aria-hidden="true" />
    </h4>
  );
}
