/**
 * Agent Window — settings primitives (view).
 *
 * Purpose-built, agw-native building blocks for the settings page. NOT shared
 * with the IDE's settings (which use `--aurora-*` + Tailwind); these are pure
 * `--agw-*` token components so the settings surface matches the rest of the
 * window exactly.
 *
 *   <SettingsSection title="…" description="…" badge={<Pill/>}>
 *     <SettingsRow label="…" hint="…"><AgwSwitch .../></SettingsRow>
 *     <SettingsRow last label="…" hint="…"><AgwSegmented .../></SettingsRow>
 *   </SettingsSection>
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";

import { AgentIcon, type AgentIconName } from "../shared/AgentIcon";

// ── Section ────────────────────────────────────────────────────────────────

export const SettingsSection: React.FC<{
  title: string;
  description?: React.ReactNode;
  icon?: AgentIconName;
  badge?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, description, icon, badge, children }) => (
  <section className="agw-set-section">
    <header className="agw-set-section-head">
      <div className="agw-set-section-title-wrap">
        {icon && (
          <span className="agw-set-section-ico">
            <AgentIcon name={icon} size={17} />
          </span>
        )}
        <div style={{ minWidth: 0 }}>
          <h3 className="agw-set-section-title">{title}</h3>
          {description && <p className="agw-set-section-desc">{description}</p>}
        </div>
      </div>
      {badge && <div style={{ flexShrink: 0 }}>{badge}</div>}
    </header>
    <div className="agw-set-panel">{children}</div>
  </section>
);

// ── Row ────────────────────────────────────────────────────────────────────

export const SettingsRow: React.FC<{
  label: string;
  hint?: React.ReactNode;
  /** Last row in a panel → no bottom divider. */
  last?: boolean;
  /** Align the control to the top (for tall controls / wrapping hints). */
  alignTop?: boolean;
  children: React.ReactNode;
}> = ({ label, hint, last, alignTop, children }) => (
  <div
    className="agw-set-row"
    data-last={last || undefined}
    style={alignTop ? { alignItems: "flex-start" } : undefined}
  >
    <div className="agw-set-row-label">
      <div className="agw-set-row-label-text">{label}</div>
      {hint && <div className="agw-set-row-hint">{hint}</div>}
    </div>
    <div className="agw-set-row-control">{children}</div>
  </div>
);

/** A free-form block inside a panel (custom layouts that aren't label/control). */
export const SettingsBlock: React.FC<{
  last?: boolean;
  children: React.ReactNode;
}> = ({ last, children }) => (
  <div className="agw-set-block" data-last={last || undefined}>
    {children}
  </div>
);

// ── Switch ─────────────────────────────────────────────────────────────────

export type SwitchTone = "accent" | "success" | "danger";

export const AgwSwitch: React.FC<{
  checked: boolean;
  onChange: (next: boolean) => void;
  tone?: SwitchTone;
  disabled?: boolean;
  ariaLabel: string;
}> = ({ checked, onChange, tone = "accent", disabled, ariaLabel }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={ariaLabel}
    disabled={disabled}
    onClick={() => !disabled && onChange(!checked)}
    className="agw-switch"
    data-on={checked || undefined}
    data-tone={tone}
    data-disabled={disabled || undefined}
  >
    <span className="agw-switch-knob" />
  </button>
);

// ── Segmented control (e.g. Auto / Ask / Deny) ──────────────────────────────

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  tone?: "success" | "warning" | "danger" | "neutral";
}

export function AgwSegmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: SegmentOption<T>[];
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="agw-seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          className="agw-seg-btn"
          data-active={value === opt.value || undefined}
          data-tone={opt.tone ?? "neutral"}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ── Select (portal dropdown; no native <select>) ─────────────────────────────

export interface SelectOption {
  value: string;
  label: string;
  /** Secondary text shown to the right of the label inside the menu. */
  meta?: string;
}

interface MenuRect {
  left: number;
  width: number;
  maxHeight: number;
  up: boolean;
  top?: number;
  bottom?: number;
}

/**
 * The window's dropdown. Portalled to `.agw-root` so a menu opened from a
 * scrolling settings pane is never clipped by it, and flipped above the
 * trigger when there isn't room below.
 *
 * Lifted out of `TeamSettings`, which owned the only copy — Speech needs the
 * same control, and two hand-rolled dropdowns in one settings surface is how
 * they drift apart.
 */
export const AgwSelect: React.FC<{
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  /** Trigger width. Defaults to the row control's natural width. */
  width?: number;
}> = ({ value, options, onChange, ariaLabel, disabled, width }) => {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<MenuRect | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // `.agw-settings` FIRST, `.agw-root` only as the fallback: settings declares
  // its own (one step smaller) type scale, so a menu portaled straight to the
  // root would render a step larger than the row that opened it. Neither
  // element establishes a containing block, so `position: fixed` inside still
  // resolves against the viewport either way.
  const attachRoot = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    setPortalTarget(
      (el.closest(".agw-settings") as HTMLElement | null) ??
        (el.closest(".agw-root") as HTMLElement | null) ??
        document.body,
    );
  }, []);

  const place = useCallback(() => {
    const t = triggerRef.current?.getBoundingClientRect();
    if (!t) return;
    const GAP = 6;
    const MARGIN = 12;
    const est = Math.min(300, options.length * 34 + 10);
    const below = window.innerHeight - t.bottom - GAP;
    const above = t.top - GAP;
    const openUp = below < est && above > below;
    if (openUp) {
      setRect({
        left: t.left,
        bottom: window.innerHeight - t.top + GAP,
        width: t.width,
        maxHeight: Math.min(est, above - MARGIN),
        up: true,
      });
    } else {
      setRect({
        left: t.left,
        top: t.bottom + GAP,
        width: t.width,
        maxHeight: Math.min(est, below - MARGIN),
        up: false,
      });
    }
  }, [options.length]);

  const toggle = useCallback(() => {
    if (disabled) return;
    setOpen((prev) => {
      if (!prev) place();
      return !prev;
    });
  }, [disabled, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onReflow = () => place();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open, place]);

  const selected = options.find((o) => o.value === value) ?? options[0];

  return (
    <div className="agw-agent-modelsel" ref={attachRoot} style={width ? { width } : undefined}>
      <button
        ref={triggerRef}
        type="button"
        className="agw-csel-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-open={open || undefined}
        disabled={disabled}
        onClick={toggle}
      >
        <span className="agw-agent-modelsel-label">{selected?.label}</span>
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
                role="listbox"
                className="agw-menu agw-scroll"
                initial={{ opacity: 0, scale: 0.97, y: rect.up ? 6 : -6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97, y: rect.up ? 6 : -6 }}
                transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                style={{
                  position: "fixed",
                  left: rect.left,
                  ...(rect.up ? { bottom: rect.bottom } : { top: rect.top }),
                  width: rect.width,
                  transformOrigin: rect.up ? "bottom left" : "top left",
                  zIndex: 1000,
                  maxHeight: rect.maxHeight,
                  overflowY: "auto",
                  scrollbarGutter: "stable",
                  padding: 5,
                }}
              >
                {options.map((o) => (
                  <button
                    key={o.value || "__default__"}
                    type="button"
                    role="option"
                    aria-selected={o.value === value}
                    className="agw-csel-item"
                    data-active={o.value === value || undefined}
                    onClick={() => {
                      onChange(o.value);
                      setOpen(false);
                    }}
                  >
                    <span className="agw-agent-modelsel-itemlabel">{o.label}</span>
                    {o.meta && <span className="agw-agent-modelsel-meta">{o.meta}</span>}
                    {o.value === value && <AgentIcon name="check" size={13} />}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>,
          portalTarget,
        )}
    </div>
  );
};

// ── Pill / badge ─────────────────────────────────────────────────────────────

export type PillTone = "success" | "warning" | "danger" | "neutral" | "info";

export const AgwPill: React.FC<{
  tone: PillTone;
  children: React.ReactNode;
  dot?: boolean;
}> = ({ tone, children, dot = true }) => (
  <span className="agw-set-pill" data-tone={tone}>
    {dot && <span className="agw-set-pill-dot" />}
    {children}
  </span>
);

// ── Button ───────────────────────────────────────────────────────────────────

export const AgwButton: React.FC<{
  variant?: "primary" | "secondary" | "danger" | "success";
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  icon?: AgentIconName;
  type?: "button" | "submit";
  children: React.ReactNode;
}> = ({ variant = "secondary", onClick, disabled, icon, type = "button", children }) => (
  <button
    type={type}
    onClick={onClick}
    disabled={disabled}
    className="agw-set-btn"
    data-variant={variant}
  >
    {icon && <AgentIcon name={icon} size={13} />}
    {children}
  </button>
);

// ── Text input ───────────────────────────────────────────────────────────────

export const AgwTextInput = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...rest }, ref) => (
  <input
    ref={ref}
    {...rest}
    className={["agw-set-input", className].filter(Boolean).join(" ")}
    spellCheck={false}
    autoCorrect="off"
    autoCapitalize="off"
  />
));
AgwTextInput.displayName = "AgwTextInput";
