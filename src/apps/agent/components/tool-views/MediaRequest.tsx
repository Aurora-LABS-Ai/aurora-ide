/**
 * Agent Window — what a picture or video was ASKED for, under its tool card.
 *
 * `generate_image` and `generate_video` used to fall through to the generic
 * argument chips: `model: grok-imagine-image-quality`, `op: generate`,
 * `prompt: Candid iPhone front camera selfie of a y`, `title: APIKEY-FAN
 * grok-imagine-image-quality te`. Four monospace boxes, each cut at forty
 * characters. The prompt — the one thing worth reading — was the one most
 * damaged by the cut, and `op` said nothing the card title had not.
 *
 * Here the prompt is prose, as it was written, clamped to three lines with a
 * way to read the rest. The facts that decide what came back (model, the
 * provider that answered, the size) are one quiet line under it
 * (`media-request.ts`). The title is not repeated: it is on the card's row.
 */

import React, { useLayoutEffect, useRef, useState } from "react";

export const MediaRequest: React.FC<{
  prompt: string;
  facts: string[];
}> = ({ prompt, facts }) => {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const promptRef = useRef<HTMLParagraphElement>(null);

  // Whether the clamp hid anything is a fact about the rendered lines, not the
  // character count: a short prompt with three line breaks overflows, a long
  // single line in a wide pane may not. A measurement of layout has to run
  // after layout, so this effect is the right home for it.
  useLayoutEffect(() => {
    const node = promptRef.current;
    if (!node || expanded) return;
    setOverflows(node.scrollHeight > node.clientHeight + 1);
  }, [prompt, expanded]);

  if (!prompt && facts.length === 0) return null;

  return (
    <div className="agw-media-request">
      {prompt && (
        <p
          ref={promptRef}
          className="agw-media-prompt"
          data-clamped={expanded ? undefined : ""}
        >
          {prompt}
        </p>
      )}
      {prompt && (overflows || expanded) && (
        <button
          type="button"
          className="agw-media-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show less" : "Show full prompt"}
        </button>
      )}
      {facts.length > 0 && (
        <div className="agw-media-facts">
          {facts.map((fact, index) => (
            <React.Fragment key={`${fact}-${index}`}>
              {index > 0 && <span aria-hidden>·</span>}
              <span>{fact}</span>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
};
