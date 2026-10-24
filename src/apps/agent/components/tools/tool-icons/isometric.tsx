/**
 * Agent Window — the Isometric tool-icon set [drawings].
 *
 * From Alvan's probe `gemini-code-1792794000032.html`, variation 01 ("3D
 * tilted text platen, slab swap & mechanical keycap"), picked 2026-10-24,
 * with three changes agreed before drawing:
 *   • Edit, Write and Delete differ at REST, not only in motion — a settled
 *     row holds still at half strength, so motion cannot be what tells them
 *     apart. Edit keeps the slab stack, Write is a card rising out of a slot
 *     (from 02), Delete is one block cracked in two.
 *   • Drawn to fill the 24 grid. The probe drew ~14×11px faces inside the
 *     slot and they read as slivers at real size.
 *   • No fixed colours. The probe painted faces #242424 / #525252 / #ededed;
 *     here every face is currentColor at one of three strengths, so the set
 *     follows the theme, light mode, contrast and the running scan.
 *
 * Construction: oblique slabs. A slab is a top face (parallelogram leaning
 * right by `sk`), a front face under it (thickness `t`) and a right side
 * face. Light comes from above: top brightest, front middle, side dimmest.
 * Motion comes from the shared vocabulary (33-tool-glyph-motion.css), not
 * from per-icon keyframes, so these marks keep the house tempo and obey
 * Appearance → Reduce motion like every other tool mark.
 */

import React from "react";

import type { ToolMark } from "./tool-icon-sets";

/** Face strengths. LIT is the probe's "crest"; DIM its base face. */
const LIT = 1;
const MID = 0.55;
const DIM = 0.3;

interface SlabSpec {
  /** Front-left corner of the top face. */
  x: number;
  y: number;
  /** Width of the top face. */
  w: number;
  /** Depth of the top face (how far it recedes, vertically). */
  d: number;
  /** Thickness of the front and side faces. */
  t: number;
  /** How far the back edge leans right. */
  sk: number;
  top?: number;
  front?: number;
  side?: number;
}

/** One oblique slab: top, front and right side, filled in currentColor. */
function slab({ x, y, w, d, t, sk, top = MID, front = DIM, side = DIM * 0.7 }: SlabSpec) {
  const back = y - d;
  return (
    <>
      <path d={`M${x} ${y}h${w}v${t}h${-w}z`} fillOpacity={front} />
      <path d={`M${x + w} ${y}L${x + w + sk} ${back}v${t}L${x + w} ${y + t}z`} fillOpacity={side} />
      <path d={`M${x} ${y}L${x + sk} ${back}h${w}L${x + w} ${y}z`} fillOpacity={top} />
    </>
  );
}

interface PlateSpec {
  /** Vertical centre of the diamond top face. */
  cy: number;
  top: number;
  left: number;
  right: number;
}

/** A diamond plate seen from above: rhombus top, two front faces under it.
 *  Spans x 3–21; half-height 2.6, thickness 1.8. */
function plate({ cy, top, left, right }: PlateSpec) {
  const h = 2.6;
  const t = 1.8;
  return (
    <>
      <path d={`M3 ${cy}L12 ${cy + h}v${t}L3 ${cy + t}z`} fillOpacity={left} />
      <path d={`M12 ${cy + h}L21 ${cy}v${t}L12 ${cy + h + t}z`} fillOpacity={right} />
      <path d={`M3 ${cy}L12 ${cy - h}L21 ${cy}L12 ${cy + h}z`} fillOpacity={top} />
    </>
  );
}

/** Fills only: AgentIcon's svg strokes every child unless told otherwise. */
function faces(children: React.ReactNode) {
  return (
    <g fill="currentColor" stroke="none">
      {children}
    </g>
  );
}

export const ISOMETRIC_MARKS: Partial<Record<ToolMark, React.ReactNode>> = {
  // file_read — a tilted text platen; its lines light in turn while a light
  // bar sweeps over them.
  "file-read": faces(
    <>
      {slab({ x: 2.5, y: 17, w: 14.5, d: 10, t: 2.2, sk: 4.5, top: DIM, front: MID, side: DIM })}
      <path d="M8.6 9.4h8.4l-.6 1.4H8z" data-part="flow" />
      <path d="M7.4 12.2h6.6l-.6 1.4H6.8z" data-part="flow" />
      <path d="M6.2 15h8.6l-.6 1.4H5.6z" data-part="flow" />
      <path d="M6.4 18.4h12.6l3-3.4v1.6l-3 3.2H6.4z" fillOpacity={LIT} data-part="lens" />
    </>,
  ),

  // file_edit — a stack of three slabs; the bright middle one slides out
  // and back, the probe's slab swap.
  "file-edit": faces(
    <>
      {slab({ x: 3, y: 7.5, w: 13, d: 3.5, t: 1.8, sk: 4.5 })}
      <g data-part="travel">
        {slab({ x: 3, y: 13.5, w: 13, d: 3.5, t: 1.8, sk: 4.5, top: LIT, front: MID, side: DIM })}
      </g>
      {slab({ x: 3, y: 19.5, w: 13, d: 3.5, t: 1.8, sk: 4.5 })}
    </>,
  ),

  // file_write — a fresh card with text rising out of a slot (the probe's
  // 02 extruder, drawn in 01's slabs).
  "file-write": faces(
    <>
      <g data-part="travel-y">
        <path d="M8.5 2.5h10l-1.6 13.5h-10z" fillOpacity={MID} />
        <path d="M10 5.5h6.4l-.2 1.6H9.8z" fillOpacity={LIT} />
        <path d="M9.6 9h6.4l-.2 1.6H9.4z" fillOpacity={LIT} />
        <path d="M9.2 12.5h4.4l-.2 1.6H9z" fillOpacity={LIT} />
      </g>
      {slab({ x: 2.5, y: 18.5, w: 15, d: 3.5, t: 2.2, sk: 4, top: DIM, front: MID, side: DIM })}
    </>,
  ),

  // delete_path — one block cracked down the middle; the right half pulls
  // away along the fault.
  "file-delete": faces(
    <>
      <path d="M3.5 9.5h5.6l1.4 4.2-1.8 5.8H3.5z" fillOpacity={MID} />
      <path d="M3.5 9.5 7.5 5.5h5.2l-3.6 4z" fillOpacity={LIT} />
      {/* The resting gap lives on the OUTER group: the running animation sets
          CSS `transform` on the part, which would replace an SVG transform
          attribute on the same element and close the crack mid-run. */}
      <g transform="translate(1.6 -1.2)">
        <g data-part="travel">
          <path d="M9.1 9.5h6.9v10H8.7l1.8-5.8z" fillOpacity={MID} />
          <path d="M9.1 9.5l3.6-4H20l-4 4z" fillOpacity={LIT} />
          <path d="M16 9.5l4-4v10l-4 4z" fillOpacity={DIM} />
        </g>
      </g>
    </>,
  ),

  // grep — a spotlight cone over a floor; the lit spot pulses where it lands.
  search: faces(
    <>
      {slab({ x: 2.5, y: 18, w: 15, d: 4, t: 1.8, sk: 4, top: DIM, front: MID, side: DIM })}
      <path d="M12.5 2.5 17.6 15.8H7.4z" fillOpacity={DIM} />
      <path d="M12.5 2.5 15 15.8h-5z" fillOpacity={MID} />
      <ellipse cx="12.5" cy="16" rx="4.4" ry="1.5" fillOpacity={LIT} data-part="pulse" />
    </>,
  ),

  // shell_execute / shell_spawn — a mechanical keycap marked >_ ; the key
  // presses and the caret blinks.
  terminal: (
    <>
      {faces(<rect x="2.5" y="13" width="19" height="8" rx="2.5" fillOpacity={DIM * 0.8} />)}
      <g data-part="travel-y">
        {faces(
          <>
            <rect x="4" y="7" width="16" height="11" rx="2.5" fillOpacity={DIM} />
            <rect x="4" y="3.5" width="16" height="11.5" rx="2.5" fillOpacity={MID} />
          </>,
        )}
        <path d="m8 7 3 2.3L8 11.6" fill="none" stroke="currentColor" strokeWidth={2} />
        <path d="M12.5 11.6h3.5" fill="none" stroke="currentColor" strokeWidth={2} data-part="caret" />
      </g>
    </>
  ),

  // browser_* — two gimbal rings around a hub, turning on crossed axes.
  browser: (
    <>
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeOpacity={MID} data-part="turn" />
      <ellipse
        cx="12"
        cy="12"
        rx="8.5"
        ry="3.4"
        transform="rotate(-25 12 12)"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        data-part="turn-b"
      />
      {faces(<circle cx="12" cy="12" r="2.4" fillOpacity={LIT} />)}
    </>
  ),

  // Grouped-runs header — three diamond plates, the top one lit. Plates are
  // spaced, not overlapped: faces are translucent currentColor, so an overlap
  // would add up into a brighter patch that reads as a fourth shape. Distinct
  // from Edit at rest: diamonds, lit on top, against Edit's oblique slabs lit
  // in the middle. Each plate is a flow part for a header that ever runs live.
  // It is drawn at 13px in subtle text, so the lower plates sit above the
  // usual DIM: at DIM the bottom plate vanished in a 13px render.
  layers: faces(
    <>
      <g data-part="flow">{plate({ cy: 18.2, top: 0.45, left: DIM, right: DIM * 0.7 })}</g>
      <g data-part="flow">{plate({ cy: 11.4, top: 0.7, left: 0.4, right: 0.28 })}</g>
      <g data-part="flow">{plate({ cy: 4.6, top: LIT, left: MID, right: DIM })}</g>
    </>,
  ),

  // TaskCreate / TaskUpdate / TaskList — three stepped blocks lighting in
  // sequence, lowest first.
  checklist: faces(
    <>
      <g data-part="flow">{slab({ x: 2.5, y: 15, w: 4.5, d: 2, t: 5.5, sk: 2, top: LIT, front: MID, side: DIM })}</g>
      <g data-part="flow">{slab({ x: 9, y: 10.5, w: 4.5, d: 2, t: 10, sk: 2, top: LIT, front: MID, side: DIM })}</g>
      <g data-part="flow">{slab({ x: 15.5, y: 6, w: 4.5, d: 2, t: 14.5, sk: 2, top: LIT, front: MID, side: DIM })}</g>
    </>,
  ),
};
