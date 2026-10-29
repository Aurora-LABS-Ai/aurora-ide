//! The surface doctrine payload.
//!
//! Adapted from `surface-philosophy` (SKILL.md plus its six references:
//! foundation, web, desktop, mobile, writing, audit) for an agent that builds
//! real product surfaces: Aurora's own panels and whatever the user asks it to
//! build, which regularly includes web pages, desktop apps and phone apps.
//!
//! Rewritten 2026-10-29 from the full source. What was kept is what changes
//! the agent's output: the shared behaviour contract, the numbers (alpha
//! steps, elevation, motion curves and durations, the control ladder, target
//! sizes, contrast), and the rules an agent breaks by default. What was left
//! out is guidance a model already follows unprompted, or that only makes sense
//! to a human designer with a design tool open.
//!
//! ## How it is split
//!
//! The source skill is a router: a core, a shared foundation, one file per
//! platform, and a writing and an audit file. This tool IS that router.
//! [`CORE`] prepends every answer, because classification and the authority
//! order are what make the rest usable. [`PATTERNS`] is the foundation. The
//! platform files ([`WEB`], [`DESKTOP`], [`MOBILE`]) are added by the
//! `platform` argument, and [`SEARCH`] rides with any of them because filters
//! and catalogs behave the same everywhere. See `mod.rs` for the routing.
//!
//! Content lives in Rust consts so it is compiled into the binary: it cannot be
//! edited, deleted, or toggled off the way a user skill can, and it is never
//! listed in the skills catalogue.
//!
//! The short always-on half is NOT here. It lives beside the prompt builder in
//! `src/apps/agent/services/skills/surface-doctrine.ts` (mirrored byte for byte
//! in `agent_runtime/turn_build/prompts/surface-doctrine.md`).

/// Classification, authority order, the rules, how to judge, and the ship
/// standard. Prepended to every topic.
pub const CORE: &str = r#"# Surface doctrine

A surface is the visible, verbal, and interactive expression of a product. Design for the real product, real content, real states, and the whole journey, never for one attractive screenshot.

**One product behaves one way everywhere.** A button gives the same feedback in a web page, a web app, a desktop window, and a phone app: the same states, in the same order, with the same words and the same tokens. Only what the hardware forces changes between platforms: size and density, pointer or finger (hover exists or it does not), keyboard availability, and navigation shape.

## Classify before designing
Name these before touching a file. If a request mixes surfaces or jobs, treat them separately.
- **Audience:** who actually uses or evaluates this.
- **Platform and surface:** web page (read to be persuaded or informed), desktop app UI (work done with pointer and keyboard: Tauri, Electron, web apps, dashboards, editors, admin panels), or mobile app UI (used with a thumb); and which screen, state, or flow.
- **Job:** persuade, orient, explain, compare, confirm, warn, recover, or unblock.
- **Primary outcome** and the one **primary action** that advances it.
- **Required evidence:** what the user must see to trust the claim or make the decision.
- **Connected decisions:** which choices affect each other and must stay comparable.
- **Constraints:** existing tokens, components, brand, content, platform, and technical limits.

## Authority order
When rules compete, the higher one wins:
1. Existing product and repository reality: its tokens, components, conventions.
2. Explicit user or brand requirements.
3. Accessibility, clarity, coherence, and truthful behaviour.
4. The surface's job and audience.
5. Defaults in this doctrine.
6. Decorative treatment.

A default here never justifies overwriting a working product system. If the project has tokens, map onto them; never invent a parallel set. Inside Aurora's own agent window the system is the `--agw-*` custom properties.

## The rules
1. **Strategy before styling.** Understand the user problem, content, and flow before choosing a visual treatment.
2. **Design the system, not one screen.** Components must survive long and short copy, missing data, bright and dark media, loading, errors, and every supported size.
3. **One dominant element per area.** Related information and related controls stay close.
4. **Design for retrieval.** People scan for a specific answer, object, status, or action. Make it findable before anything has to be read in full.
5. **Make decisions easier, not screens emptier.** Keep interdependent choices together and show real consequences. Hiding relevant information is not simplification.
6. **Restraint is the default.** Motion, gradients, glass, shadow, cards, badges, icons, and colour are added only when they carry meaning, hierarchy, feedback, or identity.
7. **No outer interaction rings.** Never draw a detached outline, ring, halo, glow, or extra stroke outside a control on hover, focus, focus-visible, active, or selected. Keyboard focus is still mandatory and clearly visible, built from the component itself: its highlight layer, fill, own border colour, text or icon change, or inversion. One edge signal at most, never two stacked strokes.
8. **Every action gives feedback.** Default, hover, focus, pressed, selected, disabled, loading, success, error, empty, and partial states, wherever they apply.
9. **Stay coherent.** One name per concept, repeated facts that agree, deliberate missing-data states, no dead controls, no contradictory messages.
10. **Accessibility and performance are design requirements,** decided with the surface, not added after polish.
11. **Psychology must help the user.** Defaults, urgency, progress, and comparison only when honest.
12. **Identity is specific to the product's world.** Assets, type, colour, language, and proof make the audience believable. A generic template stack, stock icon set, or default kit look is not identity.
13. **Take structure from references, never their palette.** A dark reference does not make a light product dark. Borrow layout, sizes, and behaviour; take colour, type, and depth from the product's own tokens.
14. **Never state behaviour the product does not have,** and never build against mock data and call it done. A fallback that hides a failure is a failure.

## Judge like a senior designer
- **Simpler-looking is not easier.** One page per filter looks clean and costs seven taps, hides earlier choices, and breaks decisions that depend on each other. Judge by how easy the decision is, not how empty the screen is.
- **Say what is read first.** If you cannot name the first, second, and third thing on a card, the user cannot either. One element leads, one carries weight, the rest steps back.
- **The first view does not need to hold everything.** Everybody scrolls. Shrinking images and text to cram more above the fold is a junior instinct.
- **Show the consequence before the commitment:** `Show 41 homes`, a count on each option, the total next to the button.
- **Design for real data:** long names, missing values, zero results, the first-time user with nothing yet, any uploaded photo.
- **When no default suits everyone, give the choice** (cards or list) and remember it.
- **Match the control to the intent:** visible options for a small known set, a slider to explore, a field for an exact value, a stepper only to nudge a value you already have.
- **Add a detail only when you can name the decision it helps.** The most informed version is also the busiest.
- **Copying a screen gets you that screen.** Extract why a reference works before using it.

## Decision order
Objective → audience and platform → content architecture → hierarchy → connected decisions, interaction model, and states → tokens and brand expression → responsive and accessibility → performance → decorative polish. Never reverse it.

## Workflow
1. **Inspect** the relevant files, existing tokens and components, neighbouring screens, and the rendered UI when you can.
2. **Classify** using the list above.
3. **Build real behaviour** with real content and existing components, not a visual shell.
4. **Verify the rendered result** with real data, at the sizes the platform supports, in every relevant state including transient ones, in light and dark when both exist, and with the keyboard. Look at shared components and at least three real screens side by side: design faults usually live in the tokens and shared components, not in one screen.
5. **Report truthfully:** what changed, what was verified, and what was not.

## Ship standard
A finished surface feels intentional because its strategy, content, hierarchy, interaction, and identity agree. It shows no builder shortcuts, placeholder thinking, copied visual habits, or decoration without a product reason.

Never state that a rule was followed, a state was covered, or a size was checked unless it actually was."#;

/// The shared foundation: behaviour contract, tokens, colour, type, shape,
/// state, focus, motion, accessibility, dark. Loaded for `build`, `redesign`,
/// `audit`, and `all`.
pub const PATTERNS: &str = r#"# Building the surface

The foundation every platform shares. These are defaults for a project without its own system; an existing token set always wins, and the job is then to map onto it consistently.

## 1. One behaviour contract
| Component | Behaviour that never changes between platforms |
|---|---|
| Button | rest → hover (pointer only) → pressed → loading (label kept, or replaced by a spinner at the same width; repeat presses blocked) → success or error stated in place. Disabled looks and behaves disabled. |
| Text field | visible label; placeholder only as an example; focus shown on the field itself; validation next to the field after the user leaves it; input kept after an error |
| Toggle, checkbox, radio | the change is instant and visible; nothing else confirms it |
| Menu, select, sheet | opens from its trigger; one highlight for pointer and keyboard; Esc or swipe closes; focus returns to the trigger |
| Save, add, follow | confirmed by the control changing (filled icon, new label, new count), not by a separate toast |
| Error message | what happened and what to do next, worded by the real cause, never blaming the user for the product's fault |
| Empty state | why it is empty and one way forward |

What platforms may change: size and density (desktop controls 24–28px with 12–14px text; phones 44–48px targets with 16–17px text; web pages between), input method (hover only with a pointer; on touch the pressed state carries feedback), navigation shape (sidebar, tab bar, page navigation), and the container for a secondary task (popover on desktop, bottom sheet on a phone, same content inside). The same feature in two front ends prints the same numbers in the same format, uses the same words, and confirms the same way.

## 2. Tokens before values
- Every colour, size, radius, shadow, duration, and curve comes from a named token. No one-off literals in components.
- Three layers, each reading only the one below: raw ramps (`gray-0…1000`, status hues) → theme inputs and derived values → semantic tokens components read (`text`, `text-secondary`, `surface`, `surface-elevated`, `border`, `ring`).
- Components never read raw ramps. A variant grid such as `{background|text|border}-{primary|secondary|danger|success|warning|info}-{solid|soft|outline|ghost}[-hover|-active]` means a new component almost never needs a new token.

## 3. Colour
**Derive, don't hand-pick.** A theme can come from four inputs: `surface`, `ink`, `accent`, and `contrast`. Two operations do most of the work: ink at low alpha for borders, hovers, secondary text, and icons (it adapts to whatever is underneath), and an opaque mix of surface toward ink, white, or black for anything content scrolls under (sidebar, panels, menus).

**Hierarchy comes from alpha, not new greys.**
| Role | Light | Dark |
|---|---|---|
| Text secondary / tertiary | ink 65% / ~50% | ink 65% / ~50% |
| Border subtle / default / strong | ink 5% / 8% / 12% | ink 4% / 8% / 16% |
| Row or ghost hover | ink ~5% | ink ~8% |
| Row or ghost pressed | ink ~12% | ink ~16% |

Reference dark stack: window `#181818`, sidebar `#141414`, panel `#232323`, menu `#2d2d2d`, text `#dfdfdf` (one step off white). Light: window `#ffffff`, sidebar `#f6f6f6`, text `#1a1c1f`.

- **Dark sinks, light lifts.** In dark themes recessed areas move toward black and raised ones toward ink; light inverts this.
- **One accent.** Focus, links, selection, and accent fills derive from it. Status hues never mark focus.
- **Semantic colours keep one meaning** everywhere (danger, success, warning, info, diff added and removed), and colour is never the only carrier of state.
- **Quiet defaults leave room for emphasis.** In repeated rows, chips, and values, keep the ordinary state restrained so the exceptional one stands out.
- **Text on an accent fill:** pick black or white by luminance (threshold ≈ 0.18) and check the arithmetic. A mid-value accent (orange, yellow, light green) usually needs dark text, and as type on a light background it usually fails, so it needs a darker `accent-ink`. Recheck whenever the brand colour changes.
- **One job per token.** A token serving two purposes breaks the day one of them changes. Split it.
- Translucent floating surfaces sit at ~96% opacity. Anything content scrolls under stays opaque.

## 4. Typography
- Each family has one job and the boundaries never blur: UI, optional display, mono for code, optional long-form content.
- Size, weight, line height, and colour come before another family.
- Variable fonts allow in-between weights (430, 510, 590) for fine hierarchy in dense UI instead of jumping 400 → 600. Check the font really has them: on a static face such as Segoe UI, 510 falls through to semibold.
- **Light on dark reads heavier.** On dark, display and label weights step down one notch; body stays.
- Large display text tightens tracking; small uppercase labels and very light weights loosen slightly.
- Sentence case by default. All-caps only for short labels with extra tracking, never for primary actions without a brand reason.
- Body line height ~1.5; headings 1.0–1.3.

## 5. Spacing, radius, elevation
**Spacing:** base unit 4px, scale `4 8 12 16 24 32 48 64 96 128`. Group with whitespace before adding a container. Repeated gaps stay identical.

**Radius:** one scale, ideally multiplied by one `corner-radius-scale`: `2 4 6 8 10 12 16 20 24 full`. **Nested radius rule:** inner radius = outer radius − the padding between them, so a 16px menu with 4px padding gets 12px rows and corners stay concentric. Pill shapes widen side padding about 1.33×.

**Elevation:** geometry plus a neutral black alpha, never tinted.
| Level | Geometry | Light α | Dark α |
|---|---|---|---|
| 100 | `0 1px 2px -1px` | .08 | .20 |
| 200 | `0 2px 4px -1px` | .08 | .20 |
| 300 | `0 4px 8px -2px` | .10 | .36 |
| 400 | `0 8px 16px -4px` | .12 | .30 |

- In dark mode raise the alpha, not the size.
- Floating surfaces add a 0.5px hairline in the border colour (their own resting edge, not an interaction ring); in dark mode also `inset 0 0 0 1px` subtle border so the edge reads.
- **No glow in the control's own colour.** If you can see the button's colour where the button is not, the shadow is wrong. Keep shadows short, dark, and neutral.
- **Give filled shapes an edge, not a glow:** a 1px rim (white ~35% along the top, black ~12% along the bottom) over a slight vertical fill reads as a material.

## 6. State model
- Express state as data or ARIA attributes (`data-state`, `data-highlighted`, `data-selected`, `data-disabled`, `aria-expanded`, `aria-invalid`) and style from those; the same attribute drives colour and motion.
- **One highlight for pointer and keyboard.** Hover and arrow keys set the same highlighted state and draw the same thing. A resting pointer plus arrow keys must never light two rows.
- Draw interactive fills on a background layer (`::before`) so the fill can fade or settle on its own; labels transition only colour and opacity.
- Disabled: ~50% opacity, `not-allowed` cursor, no hover or press styles, still announced as disabled.
- An open trigger keeps a partial highlight (~60%); selected keeps 100%. An inline action inside a highlighted row dims the row highlight (~40%) while hovered.

## 7. Focus, hover, press
**Focus: no outer rings.** Forbidden on any control in any state: an outline, ring, halo, glow, or stroke drawn outside the component's box, including `outline-offset` above 0 and spread box-shadows. Required: a clearly visible `:focus-visible` state from the component itself, with at most one edge signal plus a surface or text change.
| Component | Focus treatment |
|---|---|
| Rows, menu items, ghost buttons, segmented options | the hover highlight layer appears, text steps up |
| Inputs, selects, text areas | the existing border takes the ring colour, plus a faint fill tint |
| Solid and outlined buttons, chips | the component's own border (transparent at rest if needed) takes the ring colour, or the fill changes |
| Checkbox, radio, switch | border colour plus fill or thumb change |

- **Never stack two strokes.** An inset shadow beside a coloured border renders as a heavy ring hugging the box. Swapping a halo for a thicker stroke is not a fix.
- The `ring` token is the focus colour and nothing else. The focused state differs from the unfocused one by at least 3:1 in the changed pixels, and is never hidden by sticky headers or overlays.
- `:focus-visible` only; a pointer press clears it.
- Component libraries ship outer rings by default (shadcn's `focus-visible:ring-*`, invalid-state halos). Strip them from every primitive on adoption and from every component added later.
- Judge 1px edges at 2–3× scale on a cropped element; a 1× screenshot cannot show whether a fix worked.

**Hover:** colour, fill, or opacity, ~150ms. The control never lifts, jumps, grows a shadow, or scales up; at most its background layer settles from `scale(.98)` to `1`. Hover never holds information touch or keyboard users cannot reach. Gate hover styles with `@media (hover: hover)`.

**Press:** switch the fill to its `-active` token, optionally with the background layer at `.98`. If the whole control shrinks, scale by width so wide rows barely move (≤80px .96, ≤150px .97, ≤220px .98, >600px .995, else .985). Off by default in desktop apps.

## 8. Motion
Motion explains change, location, hierarchy, or feedback. It is short, decelerating, and mostly invisible.
| Curve | Value | Use |
|---|---|---|
| `ease-enter` | `cubic-bezier(.19, 1, .22, 1)` | anything appearing |
| `ease-exit` | `cubic-bezier(.8, 0, .4, 1)` | anything leaving |
| `ease-move` | `cubic-bezier(.65, 0, .35, 1)` | relocation, switch thumbs |
| `ease-enter-snappy` | `cubic-bezier(.23, 1, .32, 1)` | short reveals, cross-fades, value glides |
| `ease` | | hover colour and opacity |

Durations: 150ms basic, 200ms cross-fades, 300ms larger reveals, up to 600ms only for modal-scale entrances.
- **Exits are shorter than entrances,** about half to two-thirds (menu 150 → 100, popover 350 → 200, modal 600 → 300). Define each pair together.
- Floating surfaces grow from their trigger (`transform-origin` on the anchor side); a typical enter is `scale(.95) → 1` plus fade. Origins and staggers flip when a surface opens upward.
- **Interrupted transitions continue from where they are;** they never restart.
- **No first-paint animation.** Render once with transitions off, then enable them. Nothing slides in from zero height on load.
- Staggers are tiny (16–60ms); distances are a few pixels.
- **Things that must look like one movement come from one number.** Two animations with the same duration and curve still drift a frame apart; drive them from one progress value.
- Reduced motion is part of every component: `prefers-reduced-motion: reduce` sets durations to 0, and the still state must still communicate.
- Looping media longer than 5 seconds needs a pause control; decorative media is `aria-hidden`.
- A spinner animates only while work is really happening. A small repeated motion vocabulary beats a collection of tricks.
- Every transient state (a loading cover, a sheet mid-open) is a real screen: check it while it is up.

## 9. Accessibility numbers
- Text contrast ≥ 4.5:1; large text (≥24px, or ≥18.7px bold) ≥ 3:1; component boundaries and state indicators ≥ 3:1.
- Pointer targets ≥ 24×24px, or spaced so a 24px circle fits. Touch-first surfaces 44px.
- Real `<button>`, `<a>`, `<input>`, labelled controls, landmarks, headings in order.
- A full keyboard path in visual order; Esc closes the topmost layer; focus returns to the trigger.
- A visual control that cannot carry semantics (custom slider, canvas) is paired with a visually hidden real control that takes focus and announces value through a polite live region.
- Alt text for meaningful images, empty alt for decorative ones. Reserve space for media and async content so nothing shifts.

## 10. Dark surfaces
Dark is designed, not inverted. Build depth from surface steps, not glow. Pick one base between pure black and ~`#181818` and step from it. Borders on dark may carry a faint cool tint when the brand allows. Do not make every control glow. Glass, grain, or texture are optional materials applied as a system (the same on the primary button and the popovers), never one-off."#;

/// What a page changes. Added for `platform: "web"`.
pub const WEB: &str = r#"# Web pages

Pages people read to be persuaded or informed: marketing, product, pricing, docs, portfolio, storefront.

## 1. Archetype
Pick one and do not mix them casually; existing brand direction wins.
- **Systematic SaaS:** precise, product-led, restrained, evidence-heavy.
- **Dark technical SaaS:** near-black surfaces, live product and code proof.
- **Cinematic brand:** photography-led, atmospheric.
- **Playful editorial:** authored illustration, expressive composition, controlled per-section colour.
- **Premium commerce:** product reality, strong imagery, clear buying facts, trust signals.
- **Calm-tech:** quiet interface, little visual noise.
- **Dark portfolio:** atmosphere first, strong display type, no conversion push.
- **Art-object:** experimental rendering, only when the accessibility and SEO cost is accepted.

The common premium grammar (pill eyebrow, two-line headline, CTA pair, floating nav, big-number stats) is table stakes. Identity comes from assets, type pairing, and specific proof. Take one reference per problem (hero, proof, navigation, pricing), extract the structural idea, reduce it to a wireframe, then apply the product's own identity.

## 2. Structure
- **Hero:** optional one-line announcement bar ending in a link → an eyebrow only if it carries real news or category → one headline → one or two lines of subcopy → primary action plus at most one secondary → real product proof. A short true risk reducer under the primary action helps (`No credit card required`).
- A headline can carry hierarchy with colour alone: one phrase at full ink, the rest at secondary ink, same size.
- **Navigation:** the primary action stays visible at every width, including when links collapse into a menu.
- **Section rhythm:** one vertical padding value for every section (for example 96px desktop, 64px mobile).
- An audience shift can be a theme shift (a dark developer band inside a light site). Use one rule and repeat it.
- Hero, three feature cards, logo strip, testimonials, pricing, FAQ, in that order with identical blocks, reads as a template.

## 3. Proof
- Proof sits next to the claim: customer metric lines with the customer's name in bold, real logos, ratings by the product identity, certifications by the decision.
- Stats only from real numbers with context (`459 of 1,557`, not `459`).
- Never shrink a whole dashboard to prove it exists. Use focused crops, one meaningful interaction, or a live rebuild in HTML at readable scale. A screenshot in a browser frame is fine; a stock photo of a laptop is not.
- Legal text can be quiet but never buried. A dismissed offer collapses to a small recoverable tab.

## 4. Assets and imagery
- Choose assets before decorative styling; photography direction or a custom object set is what a template cannot copy.
- **An image either identifies or sells.** A 56px thumbnail only says something is there; when imagery is the reason to visit (food, products, places), give it the space.
- **Text off the picture** in repeated cards: names, prices, and numbers under the image so every card reads the same whatever was uploaded. At most one action (save) on the photo.
- UI over media stays readable on dark, bright, busy, and simple images: put it on a stable surface.
- Gradients are jewellery, not paint: a hairline strip, a contained glow behind one CTA, never a background wash by default.
- One icon family, weight, and style. Stock icon sets read as default; real logos when they exist.
- On dark pages, display and labels go one weight lighter; a primary button may invert on hover (a fill change, allowed).

## 5. Commerce
- Product identity, price, and trust are findable early. The price comes from the backend, never computed on the client.
- Price block: price, then the old price struck with the saving, then the price after what the shopper already has, in the benefit colour with a details link.
- Delivery as a promise with dates under the price. A purchase problem in one sentence with its fix inline, right above the actions. Bad news sits next to its reassurance.
- One filled buy action; quantity and buy read as one decision group. Sticky buy bar when people decide after reading further. Recommendations go below the content the page exists for.
- Social proof only from real counts. Stock as a range unless scarcity is real.
- Product card: only save on the photo; status as a small pill under the photo; read order status → title → variant → price (old price struck on the same line) → one line per fact that applies. Not every tile needs a button. Colour is semantic and sparing: benefit and problem, everything else secondary.

## 6. Responsive
- Check at 390, 768, 1024, 1440, and the largest supported width. Recompose, never shrink: two columns become one direction, body text ≥ 16px on phones.
- The primary action is reachable at every width; touch targets ≥ 44px on touch; hover-only content has a tap and focus equivalent.
- No page-level horizontal scroll. Reserve the scrollbar gutter (`scrollbar-gutter: stable`) so navigation does not shift the page.

## 7. Motion on pages
- Section media plays only while visible, `muted playsinline`, with a matched poster and a pause control past 5 seconds.
- Marquees: duration scales with content, pause on hover and focus, edge fade mask, `aria-hidden` or a static alternative.
- Entrance reveals are a few pixels of rise plus fade, once, and off under reduced motion."#;

/// What a pointer, a keyboard, and a large window change. Added for
/// `platform: "desktop"`.
pub const DESKTOP: &str = r#"# Desktop app UI

Surfaces used to get work done with a pointer and keyboard: desktop apps (Tauri, Electron, native), web apps, dashboards, editors, admin panels, tool panes. Denser than a website, and nothing is decorated.

## 1. Density
| Role | Size / line height | Weight |
|---|---|---|
| Meta, badges | 11px / 1.33 | 400–590 |
| Menus, dense rows | 12px / 1.43 | 400 |
| Control labels | 13px / 18px | 510 |
| Tooltip | 13px | 430 |
| Body, editor, composer | 14px / 1.5 | 400 |
| Emphasis | 16px | 510–600 |
| Headings sm / md / lg / page | 18 / 20 / 24 / 28px | 600, tight tracking |

Use the OS UI font by default (`-apple-system, "Segoe UI", system-ui`), let users override it, and keep a separate mono.

## 2. One control size ladder
Buttons, inputs, selects, and segmented controls share it, so anything in a row lines up.
| Size | Height | Side padding | Font | Icon | Radius |
|---|---|---|---|---|---|
| 2xs | 22 | 6 | 12 | 14 | 6 |
| xs | 24 | 8 | 14 | 16 | 6 |
| sm | 26 | 8 | 14 | 16 | 6 |
| **md (default)** | **28** | **10** | **14** | **18** | **6** |
| lg | 32 | 12 | 16 | 18 | 8 |
| xl | 36 | 12 | 14 | 18 | 8 |
| 2xl | 40 | 14 | 14 | 18 | 10 |

- Icon-only buttons are square. Icons beside a label pull 1–2px toward the edge so the label looks centred.
- **Optical alignment:** a ghost button at the start or end of a row shifts outward by its own padding so its label lines up with the text above it.
- Visuals can be 20–28px, but the hit area is never below 24×24px.

## 3. App shell
- Title bar ~44px; toolbars 46px, 36px compact, 40px for panes. Drag regions on empty chrome only; every button inside is no-drag.
- Sidebar resizable, default ~275px, clamped between 240px and `min(520px, 100vw − 320px)`, recessed, separated by a hairline or surface step, not a heavy border. Side panes min ~200px, max ~60% of the window.
- Reading column for chat or documents: max ~800px, gutters 16–20px.
- Window controls, title bar height, and font rendering differ on Windows and macOS; test on what ships. Back and close stay pinned and never scroll away.
- Surfaces (dark reference): window `#181818`, sidebar `#141414`, panel `#232323`, editor `#282828`, menu `#2d2d2d` opaque with a 0.5px hairline and shadow 400, popover at 96% opacity, tooltip inverted on light and raised grey on dark.

## 4. Menus and tooltips
- Menu: radius 16px, padding 4px, min width `min(300px, available)`, scrolls inside, collision-aware placement. Rows 12px text, padding 5×8px, icon gap 6px, radius 12px.
- **Desktop menus open instantly,** like native ones. Animate only purpose-built pickers.
- Highlight: one `::before` pill shared by hover and keyboard, settling `scale(.98 → 1)` over 150ms.
- Keyboard: arrows move, typeahead jumps, Enter or Space selects, Esc closes, → opens a submenu, ← closes it, focus returns to the trigger.
- Danger rows come last in the danger colour. Disabled rows 50% with no highlight. A row with a description line is ≥ 44px tall.
- Tooltip: 2px from the trigger, 13px at 430, padding 5×12px. It names the control or adds the shortcut, never repeats the visible label, never holds information needed to use the control. A control that needs a tooltip to be understood needs a label.

## 5. Floating surfaces
| Surface | Enter | Exit |
|---|---|---|
| Menu | instant (or 150ms) | instant (or 100ms) |
| Select list | 300ms `ease-enter` | 200ms `ease-exit` |
| Popover | 350ms | 200ms |
| Important picker | 320ms `ease-enter-snappy` after 30ms | short |
| Modal | 600ms, rise 20px + fade | 300ms |
| Backdrop | 600ms | 400ms; dim .3 light, .5 dark |

- Modals: centred, ~450px wide for confirmations, focus trapped, Esc closes, focus returns. In a narrow window a modal becomes a bottom sheet.
- An invalid action shakes the dialog (400ms) instead of closing it or doing nothing.
- A view switch inside a panel morphs the panel height (320ms) while rows cross-fade with tiny staggers.

## 6. Controls
- **Buttons:** solid (one primary per area), soft, outline, ghost. The fill lives on `::before`; labels only change colour and opacity. Selected toggles keep the fill at 100%, open triggers at 60%. No press shrink by default.
- **Inputs and selects:** same height as a button of the same size. Placeholder in tertiary ink, never a label. Focus: the border takes the ring colour plus a faint fill tint. Invalid: the border takes the danger colour with the message next to the field, never a halo.
- **Segmented control:** option radius = track radius − track padding; the selected option is a raised thumb; unselected ones are secondary ink.
- **Switch:** track colour 175ms linear after 50ms; the thumb travels 250ms on `ease-move`. Checkbox 18px, radius 4px. In menus, indicators sit at the end of the row.
- **Sliders: preview, then commit.** Dragging, hovering, or scrolling changes a preview; only release, Enter, or click commits; cancel restores. A press becomes a drag after ~4px. Combine settings that are really one axis (model plus effort as one control) instead of two dropdowns.

## 7. Lists, trees, data
- Rows are the unit. Group with alignment, dividers, and column edges before cards. No cards inside cards.
- File trees: folders first, then names in locale order; load only expanded folders; keep the old entries on screen while refreshing, never blank or flicker; remember expanded folders, selection, scroll, and filter.
- Tables: sticky header, right-aligned tabular numbers, row hover, keyboard selection.
- Loading: skeletons in the real layout's shape, or keep the previous data with a subtle progress cue. A spinner alone only for actions under a second.
- Mark figures as updating the moment an input changes. A stale total next to an enabled action is a bug.
- Streaming text keeps stop and copy available while it arrives.

## 8. Keyboard and checks
- Every action reachable by keyboard, frequent ones with shortcuts shown in menus and tooltips. Tab follows visual order; arrow keys inside composite widgets, Tab between them. Focus is never lost after a dialog closes or an item is deleted.
- Check at the minimum supported window size, ~1280–1440 wide, and a large monitor; light, dark, and high contrast when supported; 125–150% OS scaling; the main flow by keyboard only."#;

/// What a small screen and a finger change. Added for `platform: "mobile"`.
pub const MOBILE: &str = r#"# Mobile app UI

Surfaces used with a thumb: native and cross-platform apps (Flutter, React Native, SwiftUI, Compose) and phone-first web apps.

## 1. Bigger, not smaller
The instinct is to shrink the desktop design. That is wrong: iOS body text is 17pt, macOS 13pt.
- Body 16–17, secondary 14–15, captions ≥ 12, nothing below 12.
- Touch targets ≥ 44pt (iOS) / 48dp (Android), including the padding around a small icon.
- System text scaling to at least 200% without clipping.
- Where a desktop dashboard showed five things, a phone screen has room for about one. Cut content before shrinking anything.

## 2. Navigation
- **Bottom tab bar, three to five destinations** (three or four is better). The active tab gets a filled pill behind icon and label; resting tabs have no container. An expanding active item hugs its content; the rest share the remaining space. The pill position, widths, label reveal, and colour run from one animation value.
- The app's main action can break out as its own round button (create, or search for a shop).
- Too many destinations for a bar: the home page becomes the sidebar, recent items as a row on top, destinations as a list with counts on the right, a large search at the bottom.
- Top bar actions are contextual per screen; there is no single fixed top bar.
- Quick return: scrolling down collapses the header and hides the tab bar; a small pull up brings them back.
- A detail screen belongs to the tab it was reached from.

## 3. Layout and building blocks
- **One direction per section:** stack vertically or scroll horizontally, never both. A horizontal row signals more by letting the next card bleed off the edge.
- An app is cards, text and links, images, and inputs. **Never nest a card in a card;** inside one card group with whitespace and hairlines. A page of white cards on grey reads as a kit. Identity the user earned (a tier, a profile) belongs on the surface, not in one more card.
- **One screen does one thing.** Home is the exception. No recent or suggested strip above the thing the screen exists for.

## 4. Sheets, gestures, changing actions
- **Bottom sheets keep people in context** for pickers, sort, filter, share, sign-in prompts, confirmations: title, optional search, the options, and close and confirm (or nothing when picking applies at once). Drag down or tap the scrim to dismiss; the chrome behind gives way. Show confirmations inside the sheet on the row that changed. A centred dialog only for a decision that must interrupt.
- **Every gesture also has a visible control.** Swipe back slides the new screen over with ~35% parallax. Long press is the right-click: dim the rest, scale the item slightly, show its actions next to it, destructive last in the danger colour. Pull to refresh where data changes.
- **Actions come and go:** an editor hides the tab bar and brings its own actions; a detail screen swaps the tab bar for a bottom action bar; after adding to the cart the buy bar becomes the quantity stepper and `Go to cart` in the same place.

## 5. Empty, feedback, accounts, forms
- First use: one full-screen state pointing at the main action, at most one dismissible tip, never an empty card per section. Empty list: one sentence and one way forward. One shared empty-state component.
- Confirm in place: the heart fills, the count changes, the label states the new state.
- A signed-out action opens a sign-in sheet over the page, then completes the interrupted action and returns to the same place with filters and scroll intact. Guest choices carry into the account.
- Sign-up: email and name first, password as its own step with the rule shown before typing, errors announced and focus on the first invalid field.
- Forms: fields grouped in one surface with hairlines, not boxed inputs on grey; the whole row is the target; the right keyboard type per field, autofill hints, a sensible return key; prefill what the app knows. Peers (delivery, payment, address) use one pattern. The total sits next to the action that commits to it.

## 6. Platform and checks
- Respect safe areas. Follow platform conventions: back behaviour, sheet grabbers, haptics on commit, system share sheet and date pickers.
- Name every control in the accessibility tree and check the tree, not only the pixels.
- Keep 60/120fps: animate transform and opacity, size images to their display size.
- Verify on a device or emulator against the live API, at ~360dp and ~430dp (and a tablet if supported), at 200% text, light and dark. Tap the edges of controls, not only the middle."#;

/// Search, filters, sort, and catalogs. Added with any platform, because they
/// behave the same everywhere.
pub const SEARCH: &str = r#"# Search, filters, and catalogs

The same on every platform. A filter is how people discover what they want, and requirements are softer than they sound: three bedrooms becomes two if three leaves nothing.

- **Results header:** a count with context (`640 places`), and Filter, Sort, and the most useful facet chips always visible above the results. `Filter (2)` counts active filters; an applied facet becomes its own chip that opens straight on that facet.
- **One filter surface over the results** (a sheet on a phone, a side panel or popover on desktop), all filters in one scroll. Never one page per filter.
- **The apply button states the outcome:** `Show 41 homes`, updating live, `Searching…` while it counts. Never a bare `Apply`, never an invented count.
- **Per-option counts** against all other active filters. A zero option stays visible and disabled with its zero.
- **Match control to intent:** visible options for a small set; a slider with min and max fields for ranges; search inside a long facet, Popular first then A–Z.
- **Labels match behaviour:** `3+` means at least three; `Exactly 3` and `2–4` are different.
- `Clear all` always reachable; closing without applying discards the draft.
- **Sort** applies on tap and closes: no Apply, no toast. Confirmation is the active chip and the new count. Sort by what the buyer pays when delivery varies.
- **Search input:** the placeholder says what search really covers. Suggestions bold what they add and keep the typed part regular. Zero results: acknowledge the query, a correction only if the backend supplies one, and a way out.
- Offer a layout switch (large cards or a compact list) when there is no right default for everyone."#;

/// Copy, states, ethical psychology, tone. Loaded for `writing`, `redesign`,
/// and `all`.
pub const WRITING: &str = r#"# Surface writing

Every word a user sees, on every platform the product runs on.

## 1. The rules
- Write to the person using the product, never to the builder or the prompt.
- The most useful meaning first; written for scanning.
- One name per concept, everywhere.
- Specific. Copy that could describe any competitor says nothing.
- Cut words that repeat what the interface already shows.
- **Never state behaviour the product does not have.**
- **Don't narrate the business's rules.** `You can review it from the order once it is delivered` is policy narration: show the action where and when it is available, or say nothing.
- **Never invent content:** no made-up headlines, counts, labels, or urgency. Show what the data says, and design the state for when it says nothing.
- Don't fix structural confusion with more copy; check grouping, placement, and signifiers first.
- Localizable: no text in images, no sentences built from fragments, room for 30–40% longer translations.

## 2. By surface
- **Marketing:** the user's outcome first, evidence beside each claim, one next step, no feature dump in the hero.
- **Product UI:** direct task language, short stable labels, no landing-page voice, no explaining what a control already makes obvious.
- **Pricing and billing:** what changes between options, billing period, recurring cost, renewal and cancellation, the consequence of each choice. No hidden fees, false scarcity, or misleading savings.
- **Onboarding:** ask only for what is needed now, with one sentence saying what it does for the user. Real progress. Work kept through sign-up.
- **Forms:** visible labels, optional fields marked, rules shown before typing (`At least 8 characters, with a number or symbol`), validation beside the field, input kept after errors.
- **Settings:** what each choice changes, when it takes effect, how to undo it. Destructive actions confirmed specifically: `Delete 3 projects`, not `Are you sure?`.

## 3. Actions
- Start with a verb and name the result: `Save changes`, `Add to cart`, `Show 41 results`, `Download report`.
- Avoid `OK`, `Submit`, `Yes`, `Apply`, and `Continue` when the next step is not obvious.
- Put a reliable count in the action; never invent one.
- A toggle's label states the current state: `Added to Watchlist`.
- Links that leave the app say so. No all-caps primary actions.

## 4. Labels, numbers, titles
- A badge says one thing: `20% off`, not `20% off discount`. An eyebrow carries real information or goes.
- Numbers have context: `459 of 1,557`, `More than 10 available`.
- One format per value type (currency, decimals, dates, times, zones) across every front end.
- A moved feature is announced once where it used to be, dismissible.
- Titles identify the thing; changing values stay out of them. A search placeholder says what search covers, and only that.
- Proof beside the claim or decision it supports, from real counts only.

## 5. States
| State | Say | Instead of |
|---|---|---|
| Loading | what is happening: `Uploading 3 files…` | `Loading…` |
| Success | what completed: `Changes saved`, or show it in place and say nothing | `Success!` |
| Empty | why it is empty and the next useful action | `No data` |
| No results | the query, a correction if available, a way out | `Nothing found` |
| Error | what happened and what to do next | a raw code |
| Warning | the consequence, what it affects, when, and the protective action | manufactured urgency |
| Missing data | a deliberate fallback | `null`, a blank, a stray dash |

**Errors are worded by their real cause.** A network failure, a server failure, a validation problem, and the product's own crash are different messages. Don't tell people to check their connection when the product's address is wrong, and don't tell them to retry something that will fail the same way. Raw codes only where the audience needs them, and then beside plain words. Empty and error states are calm and specific; `Oops!` is a casual app's voice.

## 6. Redundancy
Remove copy that only repeats visible context: `Price` beside an obvious price, a tooltip repeating its label, a badge restating the paragraph below, an eyebrow duplicating the heading, a subtitle every card would repeat (say it once at the section). Keep a label whose removal would make the interface ambiguous or inaccessible.

## 7. Ethical psychology
- **Defaults:** safe ones for common low-risk choices. Never preselect consent, paid extras, or harmful actions.
- **Progress:** real only. No invented steps or fake completion.
- **Reciprocity:** give value before asking for commitment.
- **Endowment:** keep work made before sign-up; never fabricate work to trap people.
- **Loss and scarcity:** real risk only. No invented deadlines, counts, or losses.
- **Contrast:** compare like with like, without hiding cheaper options.

## 8. Hard fails
Rewrite or remove: AI self-reference, builder-facing narration, prompt residue, TODO text, lorem ipsum, fake values shown as real, invented headlines or counts, raw schema or field names, contradictory badges or statuses, dead actions drawn as controls, vague buttons, placeholder-only instructions, errors without recovery, errors that blame the wrong cause, empty states with no path, fabricated urgency, deceptive preselection, hidden cost or consequence, claims about behaviour the product does not have, and generic filler that fits any product.

## 9. Tone
Marketing sharp and benefit-led. Controls concise. Onboarding warm and clear. Errors calm and useful. Billing and settings precise. Technical surfaces exact. Confidence comes from specifics, not hype. Every word helps the user understand, decide, act, or recover."#;

/// Review gates, severity, and the report format. Loaded for `audit` and
/// `all`.
pub const AUDIT: &str = r#"# Audit and ship gates

For review, QA, redesign validation, and release checks. The rules live in the build, platform, and writing sections; this says how to check them and how to report.

## 1. How to audit
- **Audit the rendered product,** not the source alone, against real data, never mock data.
- **Look at shared components and at least three real screens side by side** before judging one. Most faults live in tokens and shared components (a grey selected state, a pill used as every button) and repeat everywhere.
- Check at the sizes the platform supports, light and dark when both exist, 200% text on mobile, 125–150% OS scaling on desktop.
- Walk every relevant state: default, hover, keyboard focus, pressed, selected, disabled, loading, success, error, empty, no results, partial, long and short content, missing data, bright and dark media. Capture transient states while they are up.
- Judge 1px edges and focus at 2–3× scale on a cropped element. Check the accessibility tree, not only pixels. Click the edges of controls, not only the middle.
- Across platforms: the same feature gives the same feedback in the same order, with the same words, number formats, and tokens. A divergence is a defect unless the hardware forces it.

## 2. Blockers
Release-blocking when they touch the primary experience: a broken primary action or flow; misleading price, status, availability, plan, or count; an essential interaction unreachable by keyboard or screen reader; keyboard focus invisible, or shown as outer interaction rings; unreadable text or controls; contradictory states, or a stale figure beside an enabled commit action; required content hidden or missing; dead controls presented as clickable; a destructive action without a clear consequence; severe responsive failure; internal, debug, placeholder, mock, or prompt content shown to users; a claim about behaviour the product does not have; wrong brand or product identity.

## 3. What to check
| Area | Check |
|---|---|
| Behaviour | every component follows the shared behaviour contract |
| Focus | visible on every element, one edge signal at most, nothing outside the box, ≥ 3:1 change |
| Hover and press | colour or fill only, no lift or glow; touch has an equivalent |
| Colour | alpha hierarchy, one accent, semantic colours consistent, contrast arithmetic checked |
| Type | one job per family, platform-appropriate sizes, nothing shrunk to fit |
| Spacing and shape | one scale, one radius family, nested radius rule, even section rhythm |
| Elevation | neutral shadows, no coloured glow, edges on filled shapes |
| Motion | exits shorter than entrances, no first-paint animation, reduced motion per component, pause on long loops |
| Hierarchy | one dominant element per area; first, second, and third read can be named |
| Decisions | connected choices together, consequences shown before commit, controls match intent |
| Copy | against the writing hard-fail list |

## 4. Slop signals
Flag these when they appear without a product reason; each becomes a defect when it weakens clarity, identity, or coherence:
- meaningless eyebrows; decorative section numbering
- everything in a card; cards inside cards; a page of identical white cards
- pills for every button, chip, and label; a button on every tile
- grey or charcoal as the selected colour everywhere
- peers (delivery, payment, address) drawn three different ways; unavailable options owning the top of the screen; the total far from its button
- decorative gradients, glass, glow, or blobs; coloured glow under bright buttons
- hover lift, scale-up, or shadow growth on controls
- competing accents; mixed icon families; the stock icon set every app uses
- a dark palette copied from a dark reference into a light product
- invented copy over real images; content shrunk to fit above the fold
- generic template sequencing with repeated feature blocks
- two entry points with different names that lead to the same place

## 5. Severity
- **Blocker:** breaks the primary task, misleads, fails essential accessibility, exposes internal content, or fails at a required state or size.
- **Major:** materially weakens clarity, trust, usability, consistency, responsiveness, or performance.
- **Minor:** polish that does not block the experience.

Fix in that order.

## 6. Report format
| Location | Issue | User impact | Rule | Suggested fix | Severity |
|---|---|---|---|---|---|

Then conclude with first impression, hierarchy, interaction, copy, accessibility, responsiveness, performance, visual coherence, cross-platform consistency where relevant, and the ship decision:
- **Pass:** no blockers; coherent and ready.
- **Needs work:** usable, but major or minor issues remain.
- **Blocked:** at least one blocker.

State what was verified, at which sizes and states, and what was not checked."#;
