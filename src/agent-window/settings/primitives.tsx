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

import React from "react";

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
