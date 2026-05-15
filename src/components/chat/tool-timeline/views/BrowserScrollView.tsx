import React from "react";
import { ArrowDown, ArrowUp, ChevronsDown, ChevronsUp, Target } from "lucide-react";
import type { BrowserScrollResult } from "../types";

interface BrowserScrollViewProps {
  result: BrowserScrollResult;
}

/**
 * Visible feedback for `browser_scroll`. The Rust tool returns the
 * before/after scroll position plus viewport metadata; we turn that
 * into a single-line summary the user can glance at and a thin
 * progress bar showing how far into the document we are.
 */
export const BrowserScrollView: React.FC<BrowserScrollViewProps> = ({
  result,
}) => {
  const after = result.after;
  const viewport = result.viewport;
  const documentHeight = viewport?.documentHeight ?? 0;
  const scrollY = after?.y ?? 0;
  const viewportHeight = viewport?.height ?? 0;
  // % of the document above the viewport bottom — gives a clean
  // "you are here" indicator without claiming spurious precision.
  const progress =
    documentHeight > viewportHeight
      ? Math.min(
          100,
          Math.max(
            0,
            ((scrollY + viewportHeight) / documentHeight) * 100,
          ),
        )
      : 100;

  const dir = result.direction;
  const isSelector = result.mode === "to_selector";
  let Icon = ArrowDown;
  let label = "Scrolled";
  if (isSelector) {
    Icon = Target;
    label = `Scrolled to ${result.selector}`;
  } else if (dir === "up") {
    Icon = ArrowUp;
    label = `Scrolled up ${Math.abs(result.deltaY ?? 0)}px`;
  } else if (dir === "down") {
    Icon = ArrowDown;
    label = `Scrolled down ${Math.abs(result.deltaY ?? 0)}px`;
  } else if (dir === "top") {
    Icon = ChevronsUp;
    label = "Scrolled to top";
  } else if (dir === "bottom") {
    Icon = ChevronsDown;
    label = "Scrolled to bottom";
  }

  return (
    <div className="mt-1 rounded-md border border-border/50 bg-code-block">
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon size={13} className="text-text-primary shrink-0" />
        <span className="text-[11px] font-medium text-text-primary">
          {label}
        </span>
        <span className="ml-auto flex items-center gap-3 text-[10px] font-mono text-text-disabled">
          <span>{Math.round(scrollY)}px</span>
          {documentHeight > 0 && (
            <span>of {Math.round(documentHeight)}px</span>
          )}
          {result.atTop && (
            <span className="rounded bg-input/60 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-text-secondary">
              top
            </span>
          )}
          {result.atBottom && (
            <span className="rounded bg-input/60 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-text-secondary">
              bottom
            </span>
          )}
        </span>
      </div>
      <div className="h-[3px] w-full bg-input/40">
        <div
          className="h-full bg-primary/60 transition-all"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
};
