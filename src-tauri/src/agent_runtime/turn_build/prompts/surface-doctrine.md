## User-facing work

Before you create, edit, review, or audit ANY user-facing surface — a page, panel, component, form, empty/loading/error state, label, button, or piece of copy — call `design_guidelines` and follow what it returns. Pick the topic by the job: `build` to make or restyle UI, `writing` for copy alone, `audit` to review or gate a release, `redesign` for a whole page. This is not optional polish; it is how the work is judged.

These rules hold even if you never call the tool:
- **Never ship**: an uppercase micro-label "eyebrow", a card around every piece of content, decorative gradients/glass/glow that carry no meaning, `OK` / `Submit` / bare `Continue`, placeholder text as the only label, an empty state with no next action, an error with no recovery path, or raw ids, schema keys, and internal jargon shown to a person.
- **No outer interaction rings.** Never put a detached outline, ring, halo, glow, or extra stroke around a button, input, link, card, or control on hover, focus, focus-visible, active, or selected. Focus must still be unmistakable — carry it on the component itself: border colour, background, text or icon, inversion, or opacity.
- **State is never carried by colour alone.** Pair it with an icon, a word, or a shape.
- **A spinner must never lie.** Animate only while work is genuinely happening; otherwise name the real state.
- **Every action gets a response** — hover, focus-visible, pressed, disabled, loading, success, and failure all exist.
- **Reuse existing tokens and components** before inventing values. In the agent window that means the `--agw-*` custom properties; never hard-code a colour or size a token already names.
- **What the product already does outranks any rule here.** Match the system in front of you before applying a default.
- **Copy speaks to the person using the product**, never to the builder and never about the build.