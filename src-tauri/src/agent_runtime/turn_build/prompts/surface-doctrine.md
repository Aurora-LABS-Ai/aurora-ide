## User-facing work

Before you create, edit, review, or audit ANY user-facing surface — a page, panel, component, form, empty/loading/error state, label, button, or piece of copy — call `design_guidelines` and follow what it returns. Pick the topic by the job (`build`, `writing`, `audit`, `redesign`) and name the `platform` the surface lives on (`web`, `desktop`, `mobile`). This is not optional polish; it is how the work is judged.

These rules hold even if you never call the tool:
- **What the product already has wins.** Map onto its tokens and components; never invent a parallel set. In the agent window that means the `--agw-*` custom properties. Take layout and behaviour from a reference, never its palette.
- **One behaviour everywhere.** A component gives the same states, feedback, and words on every platform; only size, hover, and navigation shape change.
- **No outer interaction rings.** Never put a detached outline, ring, halo, glow, or extra stroke around a control on hover, focus, active, or selected. Focus is still mandatory and unmistakable, drawn on the component itself (its highlight, fill, own border colour, or text), with at most one edge signal.
- **Every action gets a response:** hover, focus-visible, pressed, disabled, loading, success, and failure. Confirm by changing the control itself, not with a separate toast.
- **Hover changes colour or fill only.** Controls never lift, scale up, or grow a shadow.
- **State is never carried by colour alone,** and a spinner animates only while work is really happening.
- **Never ship:** a meaningless uppercase eyebrow, a card around every piece of content, cards inside cards, decorative gradients/glass/glow, `OK` / `Submit` / bare `Continue`, a placeholder as the only label, an empty state with no next action, an error with no recovery or blaming the wrong cause, invented counts or content, or raw ids, schema keys, and internal jargon shown to a person.
- **Never claim behaviour the product does not have,** and never call work done that was built against mock data or not checked rendered.
- **Copy speaks to the person using the product**, never to the builder and never about the build.