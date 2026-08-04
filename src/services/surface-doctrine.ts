/**
 * The always-on half of Aurora's surface doctrine.
 *
 * Aurora ships exactly one built-in body of design guidance, and it is
 * deliberately NOT a skill: skills are a catalogue the user browses, toggles,
 * and deletes, whereas this is a standing instruction about how user-facing
 * work must be done. It is never listed, never searchable, and cannot be
 * switched off.
 *
 * Delivery is two-part:
 *
 * 1. This core rides in every system prompt. It is short on purpose — it costs
 *    tokens on every single request — and carries only the rules whose absence
 *    is immediately visible in shipped work.
 * 2. The full adapted doctrine lives in the Rust `design_guidelines` tool
 *    (`src-tauri/src/tools/design/doctrine.rs`) and is pulled on demand, split
 *    into `visual` and `writing` so a copy task does not pay for the layout
 *    half.
 *
 * The two halves are kept in different places on purpose: each has exactly one
 * home, so there is no second copy to drift.
 */

export const SURFACE_DOCTRINE_CORE = `## User-facing work

Before you create, edit, review, or audit ANY user-facing surface — a page, panel, component, form, empty/loading/error state, label, button, or piece of copy — call \`design_guidelines\` and follow what it returns. This is not optional polish; it is how the work is judged.

These rules hold even if you never call the tool:
- **Never ship**: an uppercase micro-label "eyebrow", a card around every piece of content, decorative gradients/glass/glow that carry no meaning, \`OK\` / \`Submit\` / bare \`Continue\`, placeholder text as the only label, an empty state with no next action, an error with no recovery path, or raw ids, schema keys, and internal jargon shown to a person.
- **State is never carried by colour alone.** Pair it with an icon, a word, or a shape.
- **A spinner must never lie.** Animate only while work is genuinely happening; otherwise name the real state.
- **Every action gets a response** — hover, focus-visible, pressed, disabled, loading, success, and failure all exist.
- **Reuse existing tokens and components** before inventing values. In the agent window that means the \`--agw-*\` custom properties; never hard-code a colour or size a token already names.
- **Copy speaks to the person using the product**, never to the builder and never about the build.`;
