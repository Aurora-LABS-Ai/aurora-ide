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
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4, transition: { duration: 0.1 } }}
          transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
          className="fixed z-[10000] w-80 overflow-hidden"
          style={{
            bottom: position.bottom,
            left: position.left,
            backgroundColor:
              "color-mix(in srgb, var(--aurora-sidebar-background) 96%, var(--aurora-chat-surface) 4%)",
            border:
              "1px solid color-mix(in srgb, var(--aurora-common-border) 65%, transparent)",
            borderRadius: 10,
            boxShadow:
              "0 12px 28px color-mix(in srgb, var(--aurora-common-shadow) 22%, transparent)",
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-2"
            style={{
              borderBottom:
                "1px solid color-mix(in srgb, var(--aurora-common-border) 40%, transparent)",
              backgroundColor:
                "color-mix(in srgb, var(--aurora-title-bar-background) 35%, transparent)",
            }}
          >
            <div>
              <p
                className="text-[10px] font-semibold uppercase tracking-[0.14em]"
                style={{
                  color:
                    "var(--aurora-text-disabled, var(--aurora-editor-foreground))",
                }}
              >
                Attach
              </p>
              <p className="mt-0.5 text-[12px] font-semibold text-text-primary">
                Skills & Rules
              </p>
            </div>
            <span
              className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium"
              style={{
                backgroundColor:
                  "color-mix(in srgb, var(--aurora-common-primary) 12%, transparent)",
                color: "var(--aurora-common-primary)",
                border:
                  "1px solid color-mix(in srgb, var(--aurora-common-primary) 28%, transparent)",
                borderRadius: 4,
              }}
            >
              {items.length}
            </span>
          </div>

          {/* Search */}
          <div className="px-3 py-2">
            <label className="relative block">
              <Search
                size={12}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
                style={{
                  color:
                    "var(--aurora-text-disabled, var(--aurora-editor-foreground))",
                }}
              />
              <input
                type="text"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder="Search skills and rules…"
                className="h-7 w-full pl-7 pr-2 text-[12px] text-text-primary outline-none transition-colors placeholder:text-text-disabled"
                style={{
                  backgroundColor:
                    "color-mix(in srgb, var(--aurora-editor-background) 65%, var(--aurora-sidebar-background) 35%)",
                  border:
                    "1px solid color-mix(in srgb, var(--aurora-common-border) 55%, transparent)",
                  borderRadius: 6,
                }}
                onFocus={(event) => {
                  event.currentTarget.style.borderColor =
                    "color-mix(in srgb, var(--aurora-common-primary) 50%, transparent)";
                }}
                onBlur={(event) => {
                  event.currentTarget.style.borderColor =
                    "color-mix(in srgb, var(--aurora-common-border) 55%, transparent)";
                }}
              />
            </label>
          </div>

          {items.length === 0 ? (
            <div
              className="px-3 py-5 text-center text-[11.5px]"
              style={{
                color:
                  "var(--aurora-text-secondary, var(--aurora-editor-foreground))",
              }}
            >
              No matching skills or rules.
            </div>
          ) : (
            <div className="max-h-72 overflow-y-auto px-1.5 pb-1.5 scrollbar-thin">
              {items.map((item, index) => {
                const isActive = index === selectedIndex;
                return (
                  <button
                    key={item.key}
                    onClick={() => onSelect(item)}
                    onMouseEnter={() => onHoverIndex(index)}
                    className={clsx(
                      "flex w-full flex-col px-2 py-1.5 text-left transition-colors",
                    )}
                    style={{
                      borderRadius: 5,
                      backgroundColor: isActive
                        ? "color-mix(in srgb, var(--aurora-common-primary) 12%, transparent)"
                        : "transparent",
                      color: isActive
                        ? "var(--aurora-common-primary)"
                        : "var(--aurora-editor-foreground)",
                    }}
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className="font-mono text-[8.5px] font-semibold uppercase tracking-[0.1em]"
                        style={{
                          backgroundColor: isActive
                            ? "color-mix(in srgb, var(--aurora-common-primary) 22%, transparent)"
                            : "color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)",
                          color: "var(--aurora-common-primary)",
                          padding: "0 5px",
                          borderRadius: 3,
                          height: 14,
                          display: "inline-flex",
                          alignItems: "center",
                        }}
                      >
                        {item.type}
                      </span>
                      <span
                        className="truncate text-[12px] font-semibold"
                        style={{
                          color: isActive
                            ? "var(--aurora-common-primary)"
                            : "var(--aurora-editor-foreground)",
                        }}
                      >
                        {item.title}
                      </span>
                      <span
                        className="ml-auto truncate text-[10px] font-medium"
                        style={{
                          color:
                            "var(--aurora-text-disabled, var(--aurora-editor-foreground))",
                          opacity: 0.7,
                        }}
                      >
                        {item.sourceLabel}
                      </span>
                    </div>
                    {item.subtitle && (
                      <span
                        className="mt-0.5 truncate text-[10.5px]"
                        style={{
                          color:
                            "var(--aurora-text-secondary, var(--aurora-editor-foreground))",
                        }}
                      >
                        {item.subtitle}
                      </span>
                    )}
                    {item.description && (
                      <span
                        className="mt-0.5 line-clamp-1 text-[10px] leading-snug"
                        style={{
                          color:
                            "var(--aurora-text-disabled, var(--aurora-editor-foreground))",
                          opacity: 0.85,
                        }}
                      >
                        {item.description}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
};
