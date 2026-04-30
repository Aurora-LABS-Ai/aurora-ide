import React from 'react';
import clsx from 'clsx';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import {
  settingsSectionPanelStyle,
  settingsRowDividerColor,
  settingsControlButtonStyle,
  settingsPrimaryActionStyle,
  settingsDangerActionStyle,
} from './settings-shared';

/**
 * Shared layout primitives for the enterprise-grade Settings UI.
 *
 * Every Settings tab is composed from these building blocks:
 *
 *   <Section title="..." description="..." badge={<StatusPill>...}>
 *     <FormRow label="..." hint="...">         ← divider below
 *       <IdeSelect ... />
 *     </FormRow>
 *     <FormRow label="..." hint="...">
 *       <IdeSwitch ... />
 *     </FormRow>
 *     <FormRowLast label="..." hint="...">     ← no divider, sits flush to bottom
 *       <ActionButton ... />
 *     </FormRowLast>
 *   </Section>
 *
 * Visual rules:
 *   - 6-8px radii everywhere
 *   - 1px borders, no glow shadows
 *   - Hairline dividers between rows (38% common-border opacity)
 *   - Uppercase tracked-wide section headers (11px / 0.16em)
 *   - Right-aligned controls, max-width-58% labels on the left
 */

// ---------------------------------------------------------------------------
// Section — the root container for a related group of settings.
// ---------------------------------------------------------------------------

interface SectionProps {
  title: string;
  description?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export const Section: React.FC<SectionProps> = ({
  title,
  description,
  badge,
  children,
  className,
}) => (
  <section className={clsx('space-y-2.5', className)}>
    <header className="flex items-end justify-between gap-3 pb-2">
      <div className="min-w-0">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary">
          {title}
        </h3>
        {description && (
          <p className="mt-1 text-[11.5px] leading-snug text-text-disabled">{description}</p>
        )}
      </div>
      {badge && <div className="shrink-0">{badge}</div>}
    </header>
    <div className="overflow-hidden" style={settingsSectionPanelStyle}>
      {children}
    </div>
  </section>
);

// ---------------------------------------------------------------------------
// FormRow / FormRowLast — single label-and-control row.
// FormRowLast renders without a bottom divider; use it for the final row in
// a Section so the divider doesn't fight the panel's own border.
// ---------------------------------------------------------------------------

interface FormRowProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
  align?: 'center' | 'top';
  className?: string;
}

const formRowBaseClass = 'flex justify-between gap-4 px-4 py-3.5';

export const FormRow: React.FC<FormRowProps> = ({
  label,
  hint,
  children,
  align = 'center',
  className,
}) => (
  <div
    className={clsx(
      formRowBaseClass,
      align === 'center' ? 'items-center' : 'items-start',
      className,
    )}
    style={{ borderBottom: `1px solid ${settingsRowDividerColor}` }}
  >
    <div className="min-w-0 max-w-[58%]">
      <p className="text-[12.5px] font-medium leading-snug text-text-primary">{label}</p>
      {hint && <p className="mt-1 text-[11px] leading-snug text-text-secondary">{hint}</p>}
    </div>
    <div className="flex shrink-0 items-center justify-end">{children}</div>
  </div>
);

export const FormRowLast: React.FC<FormRowProps> = ({
  label,
  hint,
  children,
  align = 'center',
  className,
}) => (
  <div
    className={clsx(
      formRowBaseClass,
      align === 'center' ? 'items-center' : 'items-start',
      className,
    )}
  >
    <div className="min-w-0 max-w-[58%]">
      <p className="text-[12.5px] font-medium leading-snug text-text-primary">{label}</p>
      {hint && <p className="mt-1 text-[11px] leading-snug text-text-secondary">{hint}</p>}
    </div>
    <div className="flex shrink-0 items-center justify-end">{children}</div>
  </div>
);

/**
 * FormBlock — a free-form row that doesn't follow the label/control split.
 * Use this when you need a custom layout inside a Section (e.g. a richer
 * item like CLI Integration, with status pill + button + code block).
 */
interface FormBlockProps {
  children: React.ReactNode;
  divided?: boolean;
  className?: string;
}

export const FormBlock: React.FC<FormBlockProps> = ({
  children,
  divided = true,
  className,
}) => (
  <div
    className={clsx('px-4 py-3.5', className)}
    style={divided ? { borderBottom: `1px solid ${settingsRowDividerColor}` } : undefined}
  >
    {children}
  </div>
);

// ---------------------------------------------------------------------------
// StatusPill — tight rectangular badge with colored dot prefix.
// ---------------------------------------------------------------------------

export type PillVariant = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

interface PillTokens {
  fg: string;
  bg: string;
  border: string;
}

export const PILL_TOKENS: Record<PillVariant, PillTokens> = {
  success: {
    fg: 'var(--aurora-common-success)',
    bg: 'color-mix(in srgb, var(--aurora-common-success) 14%, transparent)',
    border: 'color-mix(in srgb, var(--aurora-common-success) 32%, transparent)',
  },
  warning: {
    fg: 'var(--aurora-common-warning)',
    bg: 'color-mix(in srgb, var(--aurora-common-warning) 14%, transparent)',
    border: 'color-mix(in srgb, var(--aurora-common-warning) 32%, transparent)',
  },
  danger: {
    fg: 'var(--aurora-common-danger)',
    bg: 'color-mix(in srgb, var(--aurora-common-danger) 14%, transparent)',
    border: 'color-mix(in srgb, var(--aurora-common-danger) 32%, transparent)',
  },
  neutral: {
    fg: 'var(--aurora-editor-foreground)',
    bg: 'color-mix(in srgb, var(--aurora-editor-foreground) 8%, transparent)',
    border: 'color-mix(in srgb, var(--aurora-common-border) 60%, transparent)',
  },
  info: {
    fg: 'var(--aurora-common-primary)',
    bg: 'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)',
    border: 'color-mix(in srgb, var(--aurora-common-primary) 32%, transparent)',
  },
};

interface StatusPillProps {
  variant: PillVariant;
  children: React.ReactNode;
  dot?: boolean;
  className?: string;
}

export const StatusPill: React.FC<StatusPillProps> = ({
  variant,
  children,
  dot = true,
  className,
}) => {
  const tokens = PILL_TOKENS[variant];
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]',
        className,
      )}
      style={{
        color: tokens.fg,
        backgroundColor: tokens.bg,
        border: `1px solid ${tokens.border}`,
        borderRadius: 4,
      }}
    >
      {dot && (
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: tokens.fg }}
        />
      )}
      {children}
    </span>
  );
};

// ---------------------------------------------------------------------------
// ActionButton — primary/secondary/danger button at 28px tall, 6px radius.
// ---------------------------------------------------------------------------

export type ActionButtonVariant = 'primary' | 'secondary' | 'danger';

interface ActionButtonProps {
  variant?: ActionButtonVariant;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  loading?: boolean;
  children: React.ReactNode;
  type?: 'button' | 'submit' | 'reset';
  className?: string;
  icon?: React.ReactNode;
  title?: string;
}

const VARIANT_STYLE: Record<ActionButtonVariant, React.CSSProperties> = {
  primary: settingsPrimaryActionStyle,
  secondary: settingsControlButtonStyle,
  danger: settingsDangerActionStyle,
};

const VARIANT_TEXT: Record<ActionButtonVariant, string> = {
  primary: 'var(--aurora-common-primary-foreground)',
  secondary: 'var(--aurora-editor-foreground)',
  danger: 'var(--aurora-common-danger)',
};

export const ActionButton: React.FC<ActionButtonProps> = ({
  variant = 'secondary',
  onClick,
  disabled,
  loading,
  children,
  type = 'button',
  className,
  icon,
  title,
}) => (
  <button
    type={type}
    onClick={onClick}
    disabled={disabled || loading}
    title={title}
    className={clsx(
      'inline-flex h-7 items-center gap-1.5 px-3 text-[11.5px] font-semibold tracking-tight transition-colors disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    style={{
      ...VARIANT_STYLE[variant],
      color: VARIANT_TEXT[variant],
    }}
  >
    {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : icon}
    {children}
  </button>
);

// ---------------------------------------------------------------------------
// IconButton — icon-only square button at 28px (good for delete/edit actions).
// ---------------------------------------------------------------------------

interface IconButtonProps {
  variant?: ActionButtonVariant;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  ariaLabel: string;
  title?: string;
  className?: string;
  children: React.ReactNode;
}

export const IconButton: React.FC<IconButtonProps> = ({
  variant = 'secondary',
  onClick,
  disabled,
  ariaLabel,
  title,
  className,
  children,
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={ariaLabel}
    title={title}
    className={clsx(
      'inline-flex h-7 w-7 shrink-0 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    style={{
      ...VARIANT_STYLE[variant],
      color: VARIANT_TEXT[variant],
    }}
  >
    {children}
  </button>
);

// ---------------------------------------------------------------------------
// KeyValue — label/value pair for diagnostic / read-only summaries.
// ---------------------------------------------------------------------------

interface KeyValueProps {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  truncate?: boolean;
  className?: string;
}

export const KeyValue: React.FC<KeyValueProps> = ({
  label,
  value,
  mono,
  truncate,
  className,
}) => (
  <div className={clsx('flex items-baseline gap-2', className)}>
    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-disabled">
      {label}
    </span>
    <span
      className={clsx(
        'min-w-0 text-[11.5px] text-text-primary',
        mono && 'font-mono',
        truncate && 'truncate',
      )}
    >
      {value}
    </span>
  </div>
);

// ---------------------------------------------------------------------------
// IntegrationBanner — inline status strip rendered inside a Section panel.
// Used for Install/Uninstall feedback in System Integrations sections.
// ---------------------------------------------------------------------------

export type BannerStatus = 'idle' | 'installing' | 'uninstalling' | 'success' | 'error';

interface IntegrationBannerProps {
  status: BannerStatus;
  message: string;
}

export const IntegrationBanner: React.FC<IntegrationBannerProps> = ({ status, message }) => {
  if (!message) return null;
  const variant: PillVariant =
    status === 'success' ? 'success' : status === 'error' ? 'danger' : 'info';
  const tokens = PILL_TOKENS[variant];
  const Icon =
    status === 'success'
      ? CheckCircle2
      : status === 'error'
        ? AlertCircle
        : Loader2;
  return (
    <div
      className="flex items-start gap-2 px-4 py-3 text-[11.5px]"
      style={{
        backgroundColor: tokens.bg,
        borderTop: `1px solid ${tokens.border}`,
        color: tokens.fg,
      }}
    >
      <Icon
        className={clsx(
          'mt-0.5 h-3.5 w-3.5 shrink-0',
          (status === 'installing' || status === 'uninstalling') && 'animate-spin',
        )}
      />
      <span style={{ color: 'var(--aurora-editor-foreground)' }}>{message}</span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// FieldLabel — small uppercase label, used inside FormBlock for sub-fields.
// ---------------------------------------------------------------------------

interface FieldLabelProps {
  children: React.ReactNode;
  className?: string;
}

export const FieldLabel: React.FC<FieldLabelProps> = ({ children, className }) => (
  <p
    className={clsx(
      'text-[10px] font-semibold uppercase tracking-[0.16em] text-text-disabled',
      className,
    )}
  >
    {children}
  </p>
);

// ---------------------------------------------------------------------------
// IdeTextInput / IdeTextArea — tight 28px text inputs that match IdeSelect.
// ---------------------------------------------------------------------------

interface IdeTextInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  containerClassName?: string;
}

export const IdeTextInput = React.forwardRef<HTMLInputElement, IdeTextInputProps>(
  ({ className, containerClassName: _containerClassName, ...rest }, ref) => (
    <input
      ref={ref}
      {...rest}
      className={clsx(
        'h-7 w-full px-2.5 text-[11.5px] font-medium text-text-primary',
        'placeholder:text-text-disabled focus:outline-none transition-colors',
        className,
      )}
      style={{
        backgroundColor:
          'color-mix(in srgb, var(--aurora-editor-background) 65%, var(--aurora-common-secondary) 35%)',
        border: '1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)',
        borderRadius: 6,
        ...rest.style,
      }}
    />
  ),
);
IdeTextInput.displayName = 'IdeTextInput';

interface IdeTextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  rows?: number;
}

export const IdeTextArea = React.forwardRef<HTMLTextAreaElement, IdeTextAreaProps>(
  ({ className, ...rest }, ref) => (
    <textarea
      ref={ref}
      {...rest}
      className={clsx(
        'w-full px-2.5 py-2 text-[11.5px] font-medium leading-relaxed text-text-primary',
        'placeholder:text-text-disabled focus:outline-none transition-colors resize-y',
        className,
      )}
      style={{
        backgroundColor:
          'color-mix(in srgb, var(--aurora-editor-background) 65%, var(--aurora-common-secondary) 35%)',
        border: '1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)',
        borderRadius: 6,
        ...rest.style,
      }}
    />
  ),
);
IdeTextArea.displayName = 'IdeTextArea';

// ---------------------------------------------------------------------------
// IdeSlider — tight 4px-tall range slider with mono % readout.
// Pass `formatValue` to format the readout (e.g. percent, px, etc).
// ---------------------------------------------------------------------------

interface IdeSliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  formatValue?: (value: number) => string;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
  trackWidth?: number;
}

export const IdeSlider: React.FC<IdeSliderProps> = ({
  value,
  min,
  max,
  step = 1,
  onChange,
  formatValue,
  ariaLabel,
  className,
  disabled,
  trackWidth = 176,
}) => {
  const display = formatValue
    ? formatValue(value)
    : `${Math.round(((value - min) / (max - min)) * 100)}%`;
  return (
    <div className={clsx('flex items-center gap-3', className)}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onChange(Number(event.target.value))}
        className={clsx(
          'h-1 cursor-pointer appearance-none rounded-full bg-input-border transition-opacity',
          '[&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none',
          '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary',
          '[&::-webkit-slider-thumb]:cursor-pointer',
          disabled && 'opacity-50',
        )}
        style={{ width: trackWidth }}
      />
      <span
        className="inline-flex h-6 min-w-[52px] items-center justify-center px-2 text-[11px] font-mono font-semibold tabular-nums text-text-primary"
        style={settingsControlButtonStyle}
      >
        {display}
      </span>
    </div>
  );
};
