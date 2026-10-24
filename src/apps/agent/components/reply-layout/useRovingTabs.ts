/**
 * Agent Window — one choice open at a time, the tab pattern every
 * interactive reply part shares (flow steps, timeline dates, compare
 * aspects) [view].
 *
 * Roving tabindex: only the open tab is in the Tab order; ← → move and wrap,
 * Home and End jump. Parts keep arriving while a reply streams, so a choice
 * past the end falls back to the last one rather than opening nothing. The
 * choice is view state only — never saved, never sent.
 */

import type React from "react";
import { useId, useRef, useState } from "react";

export function useRovingTabs(count: number, initial = 0) {
  const [chosen, setChosen] = useState(initial);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const baseId = useId();
  const open = Math.max(0, Math.min(chosen, count - 1));

  const select = (i: number, focus = false) => {
    setChosen(i);
    if (focus) tabs.current[i]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const last = count - 1;
    const next =
      event.key === "ArrowRight" ? (open === last ? 0 : open + 1)
      : event.key === "ArrowLeft" ? (open === 0 ? last : open - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    select(next, true);
  };

  const tab = (i: number) => ({
    ref: (el: HTMLButtonElement | null) => {
      tabs.current[i] = el;
    },
    type: "button" as const,
    role: "tab" as const,
    id: `${baseId}-tab-${i}`,
    "aria-selected": i === open,
    "aria-controls": `${baseId}-panel`,
    tabIndex: i === open ? 0 : -1,
    onClick: () => select(i),
  });

  const panel = {
    role: "tabpanel" as const,
    id: `${baseId}-panel`,
    "aria-labelledby": `${baseId}-tab-${open}`,
  };

  return { open, select, onKeyDown, tab, panel };
}
