//! The surface doctrine payload.
//!
//! Adapted from `surface-philosophy` v5 for an agent that builds real product
//! surfaces — both Aurora's own panels and whatever the user asks it to build,
//! which regularly includes marketing, pricing, and commerce pages. An earlier
//! version of this file dropped those on the grounds that "the agent does not
//! do that work". It does: a turn that starts from an empty workspace and ends
//! with a landing page is ordinary. They are kept, scoped to the sections that
//! own them, so a product-UI task still does not pay for them.
//!
//! ## Why it is split four ways
//!
//! The source skill is a router: a short core that classifies the work, and
//! three references loaded per task. This tool IS that router. [`CORE`] is
//! short and prepends every answer, because classification and the authority
//! order are what make the rest usable. The other three are loaded by topic —
//! see `mod.rs` — so a copy task never pays for the audit gates.
//!
//! Content lives in Rust consts so it is compiled into the binary: it cannot be
//! edited, deleted, or toggled off the way a user skill can, and it is never
//! listed in the skills catalogue.
//!
//! The short always-on half is NOT here — it lives beside the prompt builder in
//! `src/apps/agent/services/skills/surface-doctrine.ts`, because that is the
//! only thing that uses it. Keeping a second copy in Rust would guarantee the
//! two drift apart.

/// Classification, authority order, the rules, and the ship standard. Prepended
/// to every topic.
pub const CORE: &str = r#"# Surface doctrine

A surface is the visible, verbal, and interactive expression of a product. Design for the real product, real content, real states, and the whole journey — never for one attractive screenshot.

## Classify before designing
Name each of these before touching a file. If a request mixes surfaces or jobs, treat them separately.
- **Audience** — who actually uses or evaluates this.
- **Surface** — marketing, product page, onboarding, app UI, form, settings, billing, a single state, or other.
- **Job** — persuade, orient, explain, compare, confirm, warn, recover, or unblock.
- **Archetype** — the closest visual direction. The build half lists them; existing brand direction always wins.
- **Primary outcome** — the one result this surface must achieve.
- **Primary action** — the one action that most directly advances that outcome.
- **Required evidence** — what the user has to see to trust the claim or make the decision.
- **Constraints** — existing brand, design system, components, content, platform, technical limits.

## Authority order — use it when rules disagree
1. Existing product and repository reality.
2. Explicit user or brand requirements.
3. Accessibility, clarity, coherence, and truthful behaviour.
4. The surface's job and audience.
5. The chosen archetype.
6. Proven patterns and defaults.
7. Decorative treatment.

Everything in this doctrine below line 6 is a **default**. It is never permission to overwrite a system the product already has.

## The rules
1. **Strategy before styling.** Understand the user problem, the product objective, the content, and the flow before choosing a visual treatment.
2. **Design the system, not one screen.** A component must survive real variation: long and short copy, missing data, bright and dark images, different products, loading, errors, and every width.
3. **Hierarchy reduces decisions.** One dominant element per area. Related information and related controls stay visually close.
4. **Evidence goes where the decision happens.** Trust signals, price, status, consequences, and proof belong beside the claim or action they support.
5. **Restraint is the default.** Motion, gradients, glass, shadows, cards, badges, icons, and colour are added only when they improve meaning, hierarchy, feedback, or identity.
6. **No outer interaction rings.** Never add a detached outline, ring, halo, glow, or extra stroke around a button, input, link, card, or control on hover, focus, focus-visible, active, or selected. Focus must still be unmistakable — carry it on the component itself.
7. **Every action gets feedback.** Design default, hover, focus, pressed, disabled, loading, success, error, empty, and partial states wherever they apply.
8. **Keep the interface coherent.** One name per concept, repeated facts that agree, deliberate missing-data states, no dead controls, no contradictory badges or messages.
9. **Design the whole journey.** Never judge a component only in isolation — check how it behaves inside the page, the list, the flow, and the surfaces on either side of it.
10. **Accessibility and performance are design requirements.** They are decided with the surface, not added after the visual polish.
11. **Psychology must serve the user.** Defaults, urgency, progress, comparison, and commitment patterns are used only when they are honest and useful.

## Decision order
Objective → audience and surface → content architecture → hierarchy → interaction model and states → archetype and brand expression → responsive and accessibility → performance and implementation → decorative polish.

Do not reverse this order.

## Ship standard
A finished surface feels intentional because its strategy, content, hierarchy, interaction, and identity agree with each other. It must not reveal builder shortcuts, placeholder thinking, copied visual habits, or decoration with no product reason.

Never state that a rule was followed, a state was covered, or a width was checked unless it actually was."#;

/// Layout, type, colour, interaction, assets, motion, responsive, performance.
/// Loaded for `build`, `redesign`, `audit`, and `all`.
pub const PATTERNS: &str = r#"# Building the surface

Defaults and proven patterns. Existing product reality outranks every one of them.

## 1. Pick an archetype first
- **Systematic SaaS** — precise, product-led, restrained, evidence-heavy.
- **Cinematic brand** — photography-led, atmospheric, emotionally directed.
- **Playful editorial** — authored illustration, expressive composition, controlled colour.
- **Premium commerce** — product reality, strong imagery, clear buying information, trust signals.
- **Calm-tech** — quiet interfaces, soft atmosphere, minimal visual noise.
- **Dark technical SaaS** — near-black surfaces, technical fluency, product proof, controlled materials.
- **Dark portfolio** — atmosphere first, minimal controls, strong display hierarchy.
- **Art-object** — experimental storytelling, and only where the usability, accessibility, and SEO cost is accepted.

Do not mix archetypes casually.

## 2. Build order
Content order → archetype → reuse existing tokens and components → spacing, type, radius, colour → asset strategy → semantic structure with real content → component states → motion only where it explains something → responsive → audit.

## 3. Layout and spacing
One grid, and related content aligned to it. Repeated margins and section spacing stay consistent. Group with whitespace before reaching for a container. Related information sits together; related controls sit together. One dominant element per area. No large empty gaps that break continuity. Recompose on smaller screens rather than shrinking the desktop layout. The page body never scrolls horizontally.

Where the product defines no scale, use `4 8 12 16 24 32 48 64 96 128 160` — consistently, rather than inventing one-off values. Inside Aurora's agent window the product DOES define one: the `--agw-*` custom properties. Use them; never hard-code a colour or a size a token already names.

## 4. Typography
Prefer one strong family, and add a second only when it has a separate job. Reach for size, weight, line height, and colour before another family. Headings attract attention, body copy carries understanding, and body text stays comfortable to scan. Small uppercase labels may need extra tracking. Embedded UI should feel typographically related to the product around it. Sentence case is the default for interface text, and all-caps primary actions need a real brand reason.

## 5. Colour and hierarchy
Colour supports content rather than overpowering it. One main accent hue unless the design system requires more. Semantic colours keep one meaning throughout the product, and colour is never the only carrier of state. Secondary actions must not compete with the primary one. Dividers separate quietly. Muted text stays readable. Saturation matches the product context — high saturation everywhere to manufacture energy is a defect.

## 6. Interaction feedback
Every interactive control communicates its state deliberately: `default · hover · focus · pressed · selected · disabled · loading · success · error · empty`.

**Hard rule — no outer rings.** Never add a detached outline, ring, halo, glow, or extra stroke around a button, input, link, card, or control on hover, focus, focus-visible, active, or selected.

Focus still has to be obvious. Carry it on the component itself: a border-colour change, a background or surface change, a text or icon change, inversion, an opacity change, or an internal treatment such as the caret. A resting border that belongs to the component is fine — a second ring outside it is not.

**Hover.** Prefer colour, surface, text, or opacity changes. Avoid scale, lift, jump, and shadow-growth on controls. Hover must never be the only way to reach information, because touch and keyboard users never see it.

## 7. Buttons and controls
A primary action should be easy to find without shouting. Labels stay specific and name the outcome. Preserve button width while loading. Secondary controls stay visibly secondary. Never render unavailable functionality as though it were clickable. Controls belonging to one decision should read as one group — a quantity stepper and its buy action are one interaction, not two.

## 8. Forms
Visible labels by default; a placeholder is not a label. Format hints where they are needed. Input survives failure. Validation appears near its field, and does not interrupt someone mid-typing unless the problem must be prevented immediately. Prefill safe known values. The focused field is unmistakable without an outer ring. Error states explain the recovery.

## 9. Cards, borders, containers
Use a card only when the content is genuinely contained, repeatable, selectable, elevated, or independently scrollable. Do not cardify every section. Borders and dividers support grouping without becoming content themselves. Radius, shadow, glass, and texture are treatments — none of them is a quality signal on its own.

## 10. Asset strategy
Choose assets before decorative styling.

**Product imagery** must work alone, beside other products, across a catalogue, under variable lighting, and at every width. Consistency across the system matters more than one beautiful image.

**UI over imagery** must stay readable over dark, bright, busy, and simple pictures. Where contrast cannot be guaranteed, put the controls on a stable surface. A thin resting border on that container is allowed — it is not an interaction ring.

**Product proof.** Never shrink a whole dashboard to prove it exists. Prefer a focused crop, a live rebuild, one meaningful interaction, or a screenshot at a readable scale.

**Logos and icons.** Use real assets where they exist. Keep one icon style; do not mix filled, outlined, heavy, and light families without intent. Skip the decorative icon when the text already says it.

## 11. Information placement
Put information where the user needs it to make the next decision: the trust signal beside the claim, the rating beside the product identity, the price early when price drives the decision, the consequence beside the action that causes it, the error beside the field that needs fixing. Never separate dependent information just to open up visual space.

## 12. Commerce and pricing — when the surface is one
Product identity, trust, and price are easy to find early. Keep an adjustable quantity out of the title. Drop redundant labels such as `Price` beside an unambiguous currency value. Surface common quantity or configuration shortcuts only where real behaviour supports them, and keep a custom option for people who need it. A sticky purchase action helps when the decision comes after reading. Show cost and consequence before commitment. Say what changes between plans, make the billing period and recurring cost explicit, and state renewal and cancellation plainly. No hidden fees, invented scarcity, or misleading savings.

## 13. Motion
Motion must explain change, location, hierarchy, or feedback. Add it after structure and states are correct, never as decoration alone. Define entrance and exit. Respect `prefers-reduced-motion`, and make sure the still state still communicates. Looping media needs a pause once it runs long enough to distract.

## 14. Dark surfaces
Dark mode is not inverted light mode. Build depth from surface steps, keep borders restrained, and spend brightness deliberately — not every control glows. Glass and texture are archetype choices, not requirements. Existing brand treatment wins.

## 15. Responsive
Check representative mobile, tablet, and desktop widths, and confirm: hierarchy still reads, the primary action stays reachable, grids recompose cleanly, menus stay usable, touch targets stay large enough, hover-only behaviour has a tap or focus equivalent, and nothing is clipped or hidden by accident.

## 16. Accessibility and performance
Semantic HTML and real interactive elements. A complete keyboard path. Visible focus without an outer ring. Sufficient contrast. Meaning that survives without colour. Reduced-motion support. Alt text and accessible names. No avoidable layout shift. Images sized and loaded deliberately. Reuse existing components and tokens instead of inventing one-off behaviour.

The goal is not to make every surface look the same. It is to make every decision look intentional, coherent, and right for this product."#;

/// Copy, states, ethical psychology, tone. Loaded for `writing`, `redesign`,
/// and `all`.
pub const WRITING: &str = r#"# Surface writing

For every user-facing word: marketing, product UI, forms, pricing, onboarding, settings, states, and notifications.

## 1. The rules
Write to the person using the product — never to the builder, the person who asked for the feature, or the prompt. Match language density to the surface. Keep terminology stable. Put the most useful meaning first. Cut words that repeat what the interface already shows. Prefer specific language over interface filler. Write for scanning, and write so it can still be translated.

## 2. Match the surface
- **Marketing** — lead with the user's outcome, say why it is better, support important claims with evidence, give one clear next step. No feature dump in the hero, and no claim that could describe any competitor.
- **Product UI** — direct task language, short stable labels. No landing-page voice inside functional UI, and no explanation of what the control already makes obvious.
- **Pricing and billing** — say what changes between options, make the billing period and recurring cost explicit, state renewal, cancellation, and consequences.
- **Onboarding** — ask only for what is needed now, show real progress, prefill what is safely known, offer one meaningful choice early, and preserve work through sign-up.
- **Forms** — visible labels, format hints only where needed, optional fields marked, validation near the field, errors that explain recovery, input preserved.
- **Settings** — say what each choice changes and when it takes effect. Confirm destructive or costly actions specifically. Keep reversal understandable.

## 3. Actions
A button usually starts with a verb and names the result: `Save changes`, `Add to cart`, `View results`, `Start free trial`, `Download report`. Avoid `OK`, `Submit`, `Yes`, and `Continue` where the next step is not obvious. Do not pad an action with words it does not need. A primary action should sound clear, not aggressive.

## 4. Labels and badges
A badge says one thing quickly: `20% off`, not `20% off discount`. No icon that adds no meaning. An eyebrow or small label must carry real information — category, status, count, release, context. If removing the label changes nothing, remove it.

## 5. Titles and supporting text
A title identifies the thing. Keep changing values out of it when the value can change elsewhere. Body text supports understanding rather than competing with the title. Avoid heavy formatting on every line; use sentence structure and line breaks to make scanning easy.

## 6. Trust and proof
Put proof beside the claim it supports — ratings, customer metrics, real testimonials, certifications, usage numbers, concrete product evidence. Never make someone go looking elsewhere for the reassurance this decision needs.

## 7. States
- **Loading** — say what is happening when it is known: `Uploading 3 files…`, not `Loading…`.
- **Success** — confirm what completed: `Changes saved`, not `Success!`.
- **Empty** — explain why it is empty and give the next useful action. Never a bare `No data`.
- **Error** — what happened, then what to do next, in plain language. Do not expose a raw code unless the audience genuinely needs it.
- **Warning** — the real consequence, what it affects, when it happens, and the protective action. Never manufacture urgency.
- **Missing data** — a backend absence must never surface as `null`, a blank, or stray punctuation. Use a deliberate fallback.

## 8. Ethical psychology
Use a behavioural pattern only where it genuinely helps.
- **Smart defaults** — safe defaults for common low-risk choices. Never preselect consent, paid extras, or anything harmful.
- **Progress** — real progress only. Never invent steps or fake completion.
- **Reciprocity** — give something useful before asking for commitment.
- **Endowment** — preserve real work someone created before signing up. Never fabricate work to trap them.
- **Loss aversion** — explain real risk. Never invent a deadline, a scarcity, or a loss.
- **Contrast** — compare like with like, and make the difference understandable without hiding the cheaper option.

## 9. Redundancy
Remove copy that only repeats what is already visible: `Price` beside an obvious currency value, a tooltip that restates its own label, a badge that restates the paragraph under it, an eyebrow that duplicates the heading, two sections making the same claim. Do not remove a label where doing so makes the interface ambiguous or inaccessible.

## 10. Hard fails — rewrite or remove
AI self-reference; builder-facing narration; prompt residue; TODO text; lorem ipsum; fake values shown as real; raw schema or parameter names on a user surface; contradictory badges or statuses; dead actions rendered as controls; vague buttons; placeholder-only instructions; errors with no recovery; empty states with no path; fabricated urgency; deceptive preselection; hidden cost or consequence; generic filler that could describe any product.

## 11. Tone
Marketing sharp and benefit-led. Controls concise and direct. Onboarding warm and clear. Errors calm and useful. Billing and settings precise. Technical surfaces exact.

Confidence comes from specificity, not hype. Every word should help someone understand, decide, act, or recover."#;

/// Review gates, severity, and the report format. Loaded for `audit` and
/// `all`.
pub const AUDIT: &str = r#"# Audit and ship gates

For review, QA, redesign validation, and release checks. Audit the rendered product, not the source alone.

## 1. Audit the real thing
Check it in realistic conditions: mobile, tablet, and desktop; light and dark where both are supported; default, hover, focus, pressed, selected, disabled, loading, success, error, empty, and partial states; open menus, dropdowns, dialogs, sheets, and overlays; long and short content; missing data; and bright, dark, busy, and simple imagery wherever UI sits over media.

Never report a state or a width as passing if it was not actually checked.

## 2. Blockers
Release-blocking whenever they touch the primary experience: a broken primary action or flow; misleading price, status, availability, plan, or product information; an essential interaction that is inaccessible; important controls a keyboard cannot reach or operate; text or controls made unreadable by contrast or media variation; contradictory interface states; required content missing or hidden; a destructive action with no stated consequence; dead functionality presented as clickable; severe responsive failure; internal, debug, placeholder, or prompt content exposed to users; wrong brand or product identity.

## 3. Interaction
Confirm hover feedback exists where hover applies; focus is visible for keyboard users; pressed and selected are distinct where it matters; disabled controls look and behave disabled; loading prevents duplicate submits; success and error confirm what happened; menu and dropdown items have deliberate feedback; and hover-only information is also reachable by touch and keyboard.

**Hard fail — outer interaction rings.** Reject any detached outline, ring, halo, glow, or extra stroke that appears around a button, input, link, card, or control on hover, focus, focus-visible, active, or selected. Focus must remain visible through the component's own language: border colour, background or surface, text or icon, inversion, opacity, or an internal treatment. A resting border that belongs to the component is allowed; a second outer ring is not.

## 4. Hierarchy and layout
One element clearly dominates each decision area. Related information is grouped, and so are related controls. Alignment follows one grid. Repeated margins and spacing stay consistent. Whitespace groups rather than disconnects. Dividers are subtle and useful. Cards exist for a reason instead of wrapping everything. Primary actions are findable without shouting. Trust, price, status, and consequence sit near the decision they affect.

## 5. Typography and colour
Clear type hierarchy; families with distinct jobs; body text comfortable to read; labels and badges quick to scan; all-caps not used aggressively without reason; colour supporting hierarchy rather than competing with it; secondary actions not fighting the primary; semantic colours consistent product-wide; dividers and borders not visually heavy; muted text still readable.

## 6. Copy
Check against the writing half, and reject or rewrite: vague action labels, redundant labels, duplicate claims, contradictory badges or statuses, builder-facing narration, AI self-reference, prompt residue, TODOs, lorem ipsum, fake values shown as real, raw schema names on a user surface, errors without recovery, empty states with no path, fabricated urgency, and hidden cost or consequence.

## 7. Forms
Labels visible; placeholders not doing a label's job; format hints where needed; validation near the field; input surviving recoverable failure; errors that explain the fix; focus visible without an outer ring; safe defaults; required and optional fields understandable.

## 8. Assets and media
Real product and brand assets where they exist; consistent icon style; images that work inside the whole system rather than in isolation; coherent catalogue imagery; controls over images readable across content variation; product proof at a readable scale; no whole dashboard shrunk into a useless thumbnail; images with dimensions so they cause no avoidable layout shift; looping media respecting reduced motion and offering control.

## 9. Responsive
Hierarchy survives at smaller widths; layouts recompose instead of shrinking; primary actions stay reachable; menus stay usable; text does not clip or overflow; grids collapse sensibly; touch targets stay usable; no page-level horizontal scrolling; hover-dependent behaviour has a mobile equivalent.

## 10. Accessibility and performance
Semantic structure; real buttons and links; accessible names; labelled inputs; a complete keyboard path; visible focus without outer rings; readable contrast; non-colour state cues; reduced-motion support; alt text where appropriate; sensible image loading; no avoidable layout shift; no animation or effect harming the main task.

## 11. Slop signals
Flag these wherever they appear without a product reason: meaningless eyebrow text; excessive cardification; decorative gradients, glass, glow, or blobs; hover lift, scale, or shadow growth on controls; competing accent colours; inconsistent icon families; stock imagery disconnected from the product; oversized empty spacing; decorative section numbering; generic template sequencing with repeated feature blocks; visual treatments copied across unrelated surfaces.

None of these is automatically wrong. Each becomes a defect when it weakens clarity, identity, hierarchy, or coherence.

## 12. Severity — fix in this order
- **Blocker** — breaks the primary task, misleads the user, causes an essential accessibility failure, exposes internal content, or fails at a required state or width.
- **Major** — materially weakens clarity, trust, usability, consistency, responsive behaviour, or performance.
- **Minor** — polish that does not materially block the experience.

## 13. Report format
| Location | Issue | User impact | Principle | Suggested fix | Severity |
|---|---|---|---|---|---|

Close with first impression, hierarchy, interaction, copy, accessibility, responsive behaviour, performance, visual coherence, and a ship decision:
- **Pass** — no blockers, coherent, ready.
- **Needs work** — usable, but major or minor issues remain.
- **Blocked** — at least one blocker prevents a trustworthy release.

State what was actually verified and what was not."#;
