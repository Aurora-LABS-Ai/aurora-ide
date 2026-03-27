import React from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { motion, AnimatePresence } from "framer-motion";
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
  if (!position) {
    return null;
  }

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          id={id}
          initial={{ opacity: 0, y: 10, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.99 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          className="fixed z-[10000] w-80 overflow-hidden rounded-2xl"
          style={{
            bottom: position.bottom,
            left: position.left,
            background:
              "linear-gradient(180deg, color-mix(in srgb, var(--aurora-sidebar-background) 88%, var(--aurora-common-secondary) 12%) 0%, color-mix(in srgb, var(--aurora-sidebar-background) 94%, transparent) 100%)",
            border:
              "1px solid color-mix(in srgb, var(--aurora-common-border) 72%, transparent)",
            boxShadow: `
              0 18px 40px color-mix(in srgb, var(--aurora-common-shadow) 28%, transparent),
              0 6px 16px color-mix(in srgb, var(--aurora-common-shadow) 16%, transparent),
              inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 8%, transparent)
            `,
            backdropFilter: "blur(16px)",
          }}
        >
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-14"
            style={{
              background:
                "linear-gradient(180deg, color-mix(in srgb, var(--aurora-common-primary-foreground) 8%, transparent) 0%, transparent 100%)",
              opacity: 0.9,
            }}
          />
          <div
            className="relative border-b px-3 py-2.5"
            style={{
              borderColor:
                "color-mix(in srgb, var(--aurora-common-border) 70%, transparent)",
              background:
                "color-mix(in srgb, var(--aurora-sidebar-background) 74%, var(--aurora-common-secondary) 26%)",
            }}
          >
            <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-text-secondary">
              <span className="font-semibold">Attach Skills Or Rules</span>
              <span
                className="rounded-md px-1.5 py-0.5 text-[9px] font-semibold"
                style={{
                  background:
                    "color-mix(in srgb, var(--aurora-chat-surface) 82%, transparent)",
                  border:
                    "1px solid color-mix(in srgb, var(--aurora-common-border) 60%, transparent)",
                }}
              >
                {items.length}
              </span>
            </div>
            <label
              className="flex items-center gap-2 rounded-xl px-2.5 py-2 transition-colors"
              style={{
                background:
                  "color-mix(in srgb, var(--aurora-sidebar-background) 82%, transparent)",
                border:
                  "1px solid color-mix(in srgb, var(--aurora-common-border) 68%, transparent)",
                boxShadow: `
                  0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 10%, transparent),
                  inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 5%, transparent)
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
            <div className="px-3 py-5 text-center text-[11px] italic text-text-disabled">
              No matching skills or rules found.
            </div>
          ) : (
            <div className="max-h-72 overflow-y-auto p-1.5 scrollbar-thin">
              {items.map((item, index) => (
                <button
                  key={item.key}
                  onClick={() => onSelect(item)}
                  onMouseEnter={() => onHoverIndex(index)}
                  className={clsx(
                    "mb-1 flex w-full flex-col rounded-xl px-2.5 py-2.5 text-left transition-all duration-150 last:mb-0",
                    index === selectedIndex
                      ? "bg-sidebar-item-selected"
                      : "hover:bg-sidebar-item-hover",
                  )}
                  style={{
                    border:
                      index === selectedIndex
                        ? "1px solid color-mix(in srgb, var(--aurora-common-primary) 24%, transparent)"
                        : "1px solid transparent",
                    boxShadow:
                      index === selectedIndex
                        ? "inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 6%, transparent)"
                        : "none",
                  }}
                >
                  <div className="mb-1 flex items-center gap-2">
                    <span
                      className="rounded-lg px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-text-secondary"
                      style={{
                        background:
                          "color-mix(in srgb, var(--aurora-sidebar-background) 78%, transparent)",
                        border:
                          "1px solid color-mix(in srgb, var(--aurora-common-border) 58%, transparent)",
                      }}
                    >
                      {item.sourceLabel}
                    </span>
                    <span className="rounded-lg bg-accent/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent">
                      {item.type}
                    </span>
                  </div>
                  <span className="text-[12px] font-medium text-text-primary">
                    {item.title}
                  </span>
                  <span className="text-[10px] text-text-secondary">
                    {item.subtitle}
                  </span>
                  <span className="mt-1 text-[10px] leading-relaxed text-text-disabled">
                    {item.description}
                  </span>
                </button>
              ))}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
};
