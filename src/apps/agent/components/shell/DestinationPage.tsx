/**
 * Agent Window — the frame a rail destination renders in.
 *
 * The same two-layer shell the conversation uses: the frame's gutter shows
 * the rail paint, and the content sits on the recessed rounded sheet. A page
 * opened from the icon rail must look like it belongs to the same window as
 * the transcript, and reusing the shell's own classes is how that is
 * guaranteed rather than approximated.
 */

import React from "react";

export const DestinationPage: React.FC<{
  /** Names the region for assistive tech; the page draws its own heading. */
  title: string;
  children: React.ReactNode;
}> = ({ title, children }) => (
  <div className="agw-center-frame">
    <section className="agw-center-sheet agw-page" aria-label={title}>
      {children}
    </section>
  </div>
);
