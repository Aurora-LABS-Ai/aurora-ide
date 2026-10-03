import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";

import { AgentIcon, type AgentIconName } from "./AgentIcon";

export interface AgentSelectOption {
  value: string;
  label: string;
  meta?: string;
  /**
   * A heading drawn above this option when it differs from the previous
   * option's — options sharing a group must be adjacent.
   */
  group?: string;
  /** A small icon-and-word mark beside the label, e.g. a pencil and "Edits". */
  mark?: { icon: AgentIconName; label: string };
}

interface MenuRect {
  left: number;
  width: number;
  maxHeight: number;
  up: boolean;
  top?: number;
  bottom?: number;
}

interface AgentSelectProps {
  value: string;
  options: AgentSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  minMenuWidth?: number;
  /** An icon in the trigger before the selected label. */
  leadingIcon?: AgentIconName;
}

const ROW_HEIGHT = 34;
const GROUP_HEIGHT = 26;

export const AgentSelect: React.FC<AgentSelectProps> = ({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className,
  minMenuWidth = 0,
  leadingIcon,
}) => {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [rect, setRect] = useState<MenuRect | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();

  const attachRoot = useCallback((element: HTMLDivElement | null) => {
    if (element) {
      setPortalTarget((element.closest(".agw-root") as HTMLElement) ?? document.body);
    }
  }, []);

  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[selectedIndex] ?? options[0];

  const place = useCallback(() => {
    const trigger = triggerRef.current?.getBoundingClientRect();
    if (!trigger) return;

    const gap = 6;
    const margin = 12;
    const groups = options.filter(
      (option, index) => option.group && option.group !== options[index - 1]?.group,
    ).length;
    // Past 300px the list scrolls inside the popover.
    const estimatedHeight = Math.min(300, options.length * ROW_HEIGHT + groups * GROUP_HEIGHT + 10);
    const below = window.innerHeight - trigger.bottom - gap;
    const above = trigger.top - gap;
    const up = below < estimatedHeight && above > below;
    const width = Math.min(
      Math.max(trigger.width, minMenuWidth),
      Math.max(0, window.innerWidth - margin * 2),
    );
    const left = Math.min(
      Math.max(margin, trigger.left),
      Math.max(margin, window.innerWidth - width - margin),
    );
    const available = up ? above : below;

    setRect({
      left,
      ...(up
        ? { bottom: window.innerHeight - trigger.top + gap }
        : { top: trigger.bottom + gap }),
      width,
      maxHeight: Math.max(80, Math.min(estimatedHeight, available - margin)),
      up,
    });
  }, [minMenuWidth, options]);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const show = useCallback(
    (index = selectedIndex) => {
      if (disabled || options.length === 0) return;
      place();
      setActiveIndex(index);
      setOpen(true);
    },
    [disabled, options.length, place, selectedIndex],
  );

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [close, open, place]);

  const focusOption = (index: number) => {
    const next = (index + options.length) % options.length;
    setActiveIndex(next);
    optionRefs.current[next]?.focus();
  };

  return (
    <div ref={attachRoot} className={`agw-csel${className ? ` ${className}` : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className="agw-csel-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        data-open={open || undefined}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          show(event.key === "ArrowDown" ? selectedIndex : Math.max(0, selectedIndex - 1));
        }}
      >
        {leadingIcon && <AgentIcon name={leadingIcon} size={14} style={{ flexShrink: 0 }} />}
        <span className="agw-csel-label">{selected?.label}</span>
        <AgentIcon
          name="chevron-down"
          size={13}
          style={{
            flexShrink: 0,
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform 0.16s ease",
          }}
        />
      </button>

      {portalTarget &&
        createPortal(
          <AnimatePresence>
            {open && rect && (
              <motion.div
                ref={menuRef}
                id={listboxId}
                role="listbox"
                aria-label={ariaLabel}
                className="agw-menu agw-csel-popover agw-scroll"
                initial={{ opacity: 0, scale: 0.97, y: rect.up ? 6 : -6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97, y: rect.up ? 6 : -6 }}
                transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                style={{
                  position: "fixed",
                  left: rect.left,
                  ...(rect.up ? { bottom: rect.bottom } : { top: rect.top }),
                  width: rect.width,
                  maxHeight: rect.maxHeight,
                  transformOrigin: rect.up ? "bottom left" : "top left",
                  zIndex: 1000,
                }}
              >
                {options.map((option, index) => (
                  <React.Fragment key={option.value || "__default__"}>
                  {option.group && option.group !== options[index - 1]?.group && (
                    <div className="agw-csel-group" role="presentation" aria-hidden="true">
                      {option.group}
                    </div>
                  )}
                  <button
                    title={option.group ? `${option.label} · ${option.group}` : undefined}
                    ref={(element) => {
                      optionRefs.current[index] = element;
                    }}
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    className="agw-csel-item"
                    data-active={option.value === value || undefined}
                    tabIndex={index === activeIndex ? 0 : -1}
                    onFocus={() => setActiveIndex(index)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        focusOption(index + 1);
                      } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        focusOption(index - 1);
                      } else if (event.key === "Home") {
                        event.preventDefault();
                        focusOption(0);
                      } else if (event.key === "End") {
                        event.preventDefault();
                        focusOption(options.length - 1);
                      } else if (event.key === "Tab") {
                        close();
                      }
                    }}
                    onClick={() => {
                      onChange(option.value);
                      close(true);
                    }}
                  >
                    <span className="agw-csel-item-label">{option.label}</span>
                    {option.mark && (
                      <span className="agw-csel-mark">
                        <AgentIcon name={option.mark.icon} size={12} />
                        {option.mark.label}
                      </span>
                    )}
                    {option.meta && <span className="agw-csel-meta">{option.meta}</span>}
                    {option.value === value && <AgentIcon name="check" size={13} />}
                  </button>
                  </React.Fragment>
                ))}
              </motion.div>
            )}
          </AnimatePresence>,
          portalTarget,
        )}
    </div>
  );
};
