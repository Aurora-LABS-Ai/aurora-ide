/**
 * Agent Window — "these steps are being redrawn, not arriving" [context].
 *
 * A tool step that mounts while its turn streams plays its entrance: its
 * height opens from 0 and its content slides in (`ToolStep`, Transcript →
 * "Smooth tool arrival"). That is right for a call that just came in, and
 * wrong for a step that is only being drawn again in a new place. Opening a
 * running work card mounts every older step of the stretch at once; each one
 * played its entrance, so the panel opened with dozens of rows growing from
 * nothing at the same time, measured its height while they were still closed,
 * and jumped when they finished (Alvan, 2026-10-16).
 *
 * The owner of such a redraw sets `current` to true just before the render
 * that mounts the steps and back to false once that render has committed.
 * Steps read it once, when they mount. A ref and not a value, so flipping it
 * re-renders nothing.
 */

import { createContext } from "react";

export const ArrivalHoldContext = createContext<{ readonly current: boolean }>({ current: false });
