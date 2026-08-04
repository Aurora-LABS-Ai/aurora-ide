//! The surface doctrine payload.
//!
//! Adapted from the `surface-philosophy` reference set for an agent building
//! **in-app product surfaces**. Marketing, pricing, and conversion-funnel
//! material is deliberately dropped — it does not apply to the work this agent
//! does — while the anti-slop gate, state coverage, accessibility, and copy
//! rules are kept in full, because those are what separate a shipped interface
//! from a screenshot.
//!
//! Content lives in Rust consts so it is compiled into the binary: it cannot be
//! edited, deleted, or toggled off the way a user skill can, and it is never
//! listed in the skills catalogue.
//!
//! The short always-on core is NOT here — it lives beside the prompt builder in
//! `src/services/agent-prompt.ts`, because that is the only thing that uses it.
//! Keeping a second copy in Rust would guarantee the two drift apart.

/// Visual, layout, interaction, motion, accessibility, performance.
pub const VISUAL: &str = r#"# Visual and interaction doctrine

## Order of decisions
Objective → audience and job → content and hierarchy → interaction and states → composition → accessibility and responsiveness → performance → decorative polish. Never start at gradients, cards, or typography tricks.

## Hierarchy
Every area has ONE dominant element. If everything is prominent, nothing is. Build hierarchy with size, weight, position, contrast, colour, and whitespace — not font size alone. In a repeated row, lead with the primary object, separate secondary metadata, and align comparable values so a column can be read vertically.

## Spacing and grouping
Whitespace is structure. Small gaps inside a group, larger gaps between groups, consistent section padding. Use a 4px-based scale; unexplained spacing drift is the clearest tell of generated work.
Do NOT solve grouping by putting every cluster in a bordered card. Try whitespace, alignment, a background change, typography, or a divider first. Cards are for genuinely contained, repeatable, selectable, or elevated objects.

## Measure and density
Constrain reading surfaces to a comfortable measure even when the container is wide — a title and its value separated by a metre of dead gutter is a layout failure. Dense operational panels use tight, predictable structure; do not import a marketing-page rhythm into a tool.

## Typography
One family used with intent. A limited scale with clear heading / body / label / caption / code roles. Sentence case for interface text — an uppercase, letter-spaced micro-label is an eyebrow, and it is almost never earned. Large display text can take tighter tracking; small chrome should not.

## Colour
Define roles, not swatches: background, surface, elevated surface, text primary/secondary, border, primary action, focus, info, success, warning, danger. Semantic colour keeps ONE meaning throughout. Decorative colour stays subordinate to content and action.

## Dark mode
Not an inverted light theme. Build depth from surface luminance steps, restrained borders, and controlled saturation. Shadows do little on dark; layer surfaces instead. Dim large areas and spend brightness on the one thing that matters — the active item, the primary action, the live value.

## Elevation
Shadows explain elevation, they do not advertise themselves. Cards need little or none; popovers need real separation; dialogs need clear modal elevation. Increase blur and reduce opacity before reaching for a harder shadow. Glass is valid only where it explains layering (command palette, overlay, floating inspector) — never on every card.

## Icons
One family, sized to the adjacent line height, consistent stroke. Label anything ambiguous. An icon never replaces a word whose meaning is not obvious, and decorative icons must earn their space.

## Controls and states
One primary action per decision area; secondary actions carry less weight; destructive actions are distinct both visually and verbally. Every control implements default, hover, focus-visible, pressed, selected, disabled, and loading as applicable. Never rely on hover as the only signifier — touch and keyboard users never see it. Targets stay comfortably large.

## Forms
Visible labels, format hints where needed, clear focus, field-level validation, input preserved after failure, explained errors with a recovery path. Never validate so eagerly that the interface scolds someone mid-typing. Never use a placeholder as the only label.

## Signifiers
A person must be able to tell, without experimenting: what is interactive, what is selected, what is inactive, what changed, what is processing, what succeeded, what failed, and what happens next.

## Motion
Motion must guide, explain, connect, or confirm. Ask: what does the user understand better because this moved? If there is no answer, delete it. No universal fade-up on every section, no floating decoration, no animation that blocks interaction. Always honour `prefers-reduced-motion`, and make sure the non-animated state still communicates.

## Micro-interactions
Small, honest feedback: copy → Copied, saving → Saved, a validated field confirming itself, a pressed response. Impressive but semantically empty motion is decoration, not feedback.

## Accessibility (target WCAG 2.2 AA)
Semantic elements, full keyboard operation, visible focus, logical focus order, sufficient contrast, non-colour state cues, accessible names, labelled inputs, announced status changes, identified errors, reduced-motion support, and reflow at zoom. This is structural — it is decided while building, not cleaned up afterwards.

## Responsive
Preserve intent, not just fit. At each width check hierarchy, reading order, content priority, targets, wrapping, data density, overflow, sticky elements, and that no essential action is hidden. Recompose when shrinking stops working.

## Performance
Protect image and font cost, JavaScript and animation cost, layout stability, and interaction latency. A slow or shifting interface is not premium regardless of how it looks.

## Implementation discipline
Reuse existing components and tokens. No one-off magic values. Remove dead wrappers, unused classes, and orphaned styles. Keep semantics. Leave no TODOs, lorem ipsum, mock values presented as real, or dead controls that look interactive.

## The anti-slop gate — run before declaring done
Reject on sight:
- an uppercase eyebrow above a heading that the structure did not require
- an italic serif headline with one colour-accented word, used to manufacture sophistication
- `Section 01` / `Section 02` numbering that carries no function
- a layout that could belong to any product — restructure around the actual content
- every sentence, metric, and action wrapped in its own rounded card
- gradients, glows, blobs, or glass that express nothing
- imagery unrelated to the adjacent message
- approximate brand colours where exact tokens exist
- spacing that drifts between sections for no reason
- a correct screenshot with broken behaviour: test the controls, the keyboard path, the loading state, and the failure state"#;

/// Copy, states, and ethical interaction psychology.
pub const WRITING: &str = r#"# Surface writing and psychology

## The core rule
Once shipped, the interface speaks to the person using it. It never speaks to the builder, narrates the build, exposes prompts or internal notes, prints debug text, or leaks schema names, ids, and raw parameters. If a string sounds written for whoever asked for the feature rather than whoever uses it, rewrite it.

## Classify before writing
Know the audience (end user, admin, developer), the surface (app UI, form, settings, tooltip, empty/loading/error state, docs), and the job (orient, explain, confirm, warn, recover, unblock). Density follows: product UI is direct and task-focused, settings state precise consequences, errors stay calm and actionable, docs may go deep. Never mix those registers in one surface.

## Actions
Buttons start with a verb and name the result: `Save changes`, `Create project`, `Try again`, `View 12 results`. Avoid `OK` and `Submit`. Use `Continue` only when the person is genuinely mid-sequence. Where possible, put the outcome in the label — `View 12 results` beats `Search`.

## Scanning and clarity
Short headings, front-loaded meaning, consistent terminology, obvious actions. Nobody should read a paragraph to learn what a control does. Assume translation: avoid idioms, unexplained abbreviations, and strings concatenated out of English word order.

## Help and disclosure
Anything REQUIRED to complete a task is visible — a label, hint, example, or inline instruction. Tooltips are supplemental only: brief, non-essential, non-interactive. Never hide critical guidance, links, or controls inside one. Use progressive disclosure for depth rather than deleting it.

## States
- **Loading**: specific and honest — `Saving…`, `Checking connection…`. Prefer a skeleton of the real shape over a bare spinner for content. Never claim progress you cannot observe.
- **Success**: confirm what completed (`Changes saved`) without celebrating routine actions.
- **Empty**: say why it is empty AND give one next action. Never a bare `No data`. If empty means finished, say so rather than inventing a task.
- **Errors**: what happened, and what to do next. Preserve what was entered. Do not blame the person, do not show a bare code, do not force a restart when they could edit and retry.
- **Warnings**: name the real consequence, the affected item, and the timing. Never invent urgency.

## Ethical psychology — apply only what fits
- **Smart defaults**: preselect the common, low-risk choice and prefill what is already known; make defaults visible and reversible. Never preselect consent, payment, data sharing, or anything destructive.
- **Goal gradient**: show position and what remains, and count work already done. Never start at zero when real progress exists, and never fake progress.
- **Reciprocity**: show useful value before asking for commitment. Never gate everything behind a wall, and never preview something fake.
- **Endowment**: let people configure or create something real before asking them to commit, and preserve that work. Never manufacture busywork to trap them.
- **Loss aversion**: name genuine risk — real deadlines, real expiry, real data — with a clear protective action. Never invent a deadline or imply a loss that will not occur.
- **Contrast**: give honest comparison context. Never use irrelevant anchors or disguise total cost.

## Hard-fail patterns — rewrite or remove
AI self-reference; builder-facing narration; "here is what I made"; prompt residue; debug strings; TODOs; lorem ipsum; mock values presented as real; raw schema or parameter names on a user surface; unexplained internal abbreviations; vague `OK`/`Submit`; placeholder-only instructions; critical help buried in a tooltip; dead-end empty states; unrecoverable errors; warnings that hide the real consequence; fabricated urgency; deceptive preselection; any dark pattern.

## Tone
Concise on controls and states. Calm in failure. Warm in empty states and onboarding where it fits. Technical only when the audience and surface justify it. Confident without chest-thumping, human without filler."#;
