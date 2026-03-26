import React from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Search } from "lucide-react";

import type { PromptAttachment } from "../../services/prompt-assets";

interface PromptAttachmentPopupProps {
  id: string;
  isOpen: boolean;
  items: PromptAttachment[];
  onHoverIndex: (index: number) => void;
  onQueryChange: (value: string) => void;
  onSelect: (attachment: PromptAttachment) => void;
  position: { bottom: number; left: number } | null;
  query: string;
  selectedIndex: number;
}

export const PromptAttachmentPopup: React.FC<PromptAttachmentPopupProps> = ({
  id,
  isOpen,
  items,
  onHoverIndex,
  onQueryChange,
  onSelect,
  position,
  query,
  selectedIndex,
}) => {
  if (!isOpen || !position) {
    return null;
  }

  return createPortal(
    <div
      id={id}
      className="fixed z-[10000] w-80 overflow-hidden rounded-xl ring-1 ring-border shadow-xl"
      style={{
        bottom: position.bottom,
        left: position.left,
        backgroundColor: "var(--aurora-sidebar-background)",
        boxShadow: "var(--aurora-common-shadow)",
      }}
    >
      <div
        className="border-b border-border px-3 py-2"
        style={{ backgroundColor: "color-mix(in srgb, var(--aurora-sidebar-background) 74%, var(--aurora-common-secondary) 26%)" }}
      >
        <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-text-secondary">
          <span className="font-semibold">Attach Skills Or Rules</span>
          <span>{items.length}</span>
        </div>
        <label
          className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5"
          style={{
            backgroundColor: 'color-mix(in srgb, var(--aurora-sidebar-background) 82%, transparent)',
            boxShadow: `
              0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 10%, transparent),
              0 0 0 1px var(--aurora-chat-surface-border)
            `,
          }}
        >
          <Search className="h-3.5 w-3.5 text-text-disabled" />
          <input
            type="text"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search skills and rules"
            className="w-full bg-transparent text-[11px] font-medium text-text-primary outline-none placeholder:text-text-disabled"
          />
        </label>
      </div>

      {items.length === 0 ? (
        <div className="px-3 py-4 text-center text-[11px] italic text-text-disabled">
          No matching skills or rules found.
        </div>
      ) : (
        <div className="max-h-72 overflow-y-auto p-1.5">
          {items.map((item, index) => (
            <button
              key={item.key}
              onClick={() => onSelect(item)}
              onMouseEnter={() => onHoverIndex(index)}
              className={clsx(
                "mb-1 flex w-full flex-col rounded-lg px-2.5 py-2 text-left transition-colors last:mb-0",
                index === selectedIndex ? "bg-sidebar-item-selected" : "hover:bg-sidebar-item-hover"
              )}
            >
              <div className="mb-1 flex items-center gap-2">
                <span className="rounded-md bg-sidebar px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-text-secondary">
                  {item.sourceLabel}
                </span>
                <span className="rounded-md bg-accent/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent">
                  {item.type}
                </span>
              </div>
              <span className="text-[12px] font-medium text-text-primary">{item.title}</span>
              <span className="text-[10px] text-text-secondary">{item.subtitle}</span>
              <span className="mt-1 text-[10px] leading-relaxed text-text-disabled">{item.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body
  );
};
