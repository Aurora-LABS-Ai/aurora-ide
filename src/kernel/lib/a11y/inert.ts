/**
 * `inert` as a spreadable prop, for a subtree that is collapsed but still
 * mounted.
 *
 * The pattern this exists for: a panel is hidden by animating its width or
 * height to 0 while keeping its children mounted, so reopening is instant and
 * the children keep their own state. Visually it is gone; to the browser it is
 * a zero-sized box full of perfectly focusable buttons.
 *
 * `aria-hidden` is the reflex reach here and it is the wrong tool twice over:
 *
 *   1. It hides the subtree from assistive technology but leaves every control
 *      in the TAB ORDER, so keyboard users tab into a panel they cannot see.
 *   2. If focus is already inside when it is applied, Chromium refuses it and
 *      logs "Blocked aria-hidden on an element because its descendant retained
 *      focus" — the hiding silently does not happen at all.
 *
 * `inert` removes the subtree from the tab order AND the accessibility tree,
 * and moves focus out rather than blocking. It is one attribute that means what
 * `aria-hidden` is usually reached for.
 *
 * The empty string is deliberate: `inert` is a boolean attribute, and `""` is
 * the form React 18 forwards as a bare attribute. React 18's JSX types have no
 * `inert` (React 19 added it), and framer-motion's `HTMLMotionProps` does not
 * carry it either, which is why this returns a typed object to spread instead
 * of being written inline at each call site with its own cast.
 */
export function inertWhen(inactive: boolean): { inert?: "" } {
  return inactive ? { inert: "" } : {};
}
