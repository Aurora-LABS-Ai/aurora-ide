/**
 * Agent Window — shared primitives barrel.
 *
 * Reusable, presentation-only building blocks with no feature logic. Today this
 * is the bespoke icon system; future low-level primitives (badges, kbd, etc.)
 * live here too so feature components import from one place.
 */

export { AgentIcon } from "./AgentIcon";
export type { AgentIconName } from "./AgentIcon";
export { AgentSelect } from "./AgentSelect";
export type { AgentSelectOption } from "./AgentSelect";
export { ScrollingLabel } from "./ScrollingLabel";
