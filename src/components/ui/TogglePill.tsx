import clsx from 'clsx';
import React, { useCallback } from 'react';
import { Check, X } from 'lucide-react';

type ToggleVariant = 'primary' | 'success' | 'warning' | 'checkpoint';
type ToggleSize = 'sm' | 'md';

export type TogglePillProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
  variant?: ToggleVariant;
  size?: ToggleSize;
  className?: string;
  labelOn?: string;
  labelOff?: string;
};

const variantClasses: Record<ToggleVariant, { accent: string; focusRing: string }> = {
  primary: {
    accent: 'var(--aurora-common-primary)',
    focusRing: 'focus-visible:ring-primary/40',
  },
  success: {
    accent: 'var(--aurora-common-success)',
    focusRing: 'focus-visible:ring-success/40',
  },
  warning: {
    accent: 'var(--aurora-common-warning)',
    focusRing: 'focus-visible:ring-warning/40',
  },
  checkpoint: {
    accent: 'var(--aurora-common-primary)',
    focusRing: 'focus-visible:ring-checkpoint/40',
  },
};

const sizeClasses: Record<ToggleSize, { icon: string; root: string; thumb: string; thumbTranslate: string }> = {
  sm: {
    icon: 'h-2.5 w-2.5',
    root: 'h-6 w-11 rounded-full',
    thumb: 'h-4.5 w-4.5',
    thumbTranslate: 'translate-x-[18px]',
  },
  md: {
    icon: 'h-3 w-3',
    root: 'h-7 w-[52px] rounded-full',
    thumb: 'h-5 w-5',
    thumbTranslate: 'translate-x-[23px]',
  },
};

export const TogglePill: React.FC<TogglePillProps> = ({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
  variant = 'primary',
  size = 'sm',
  className,
  labelOn = 'ON',
  labelOff = 'OFF',
}) => {
  const onToggle = useCallback(() => {
    if (disabled) return;
    onChange(!checked);
  }, [checked, disabled, onChange]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onChange(!checked);
    }
  }, [checked, disabled, onChange]);

  const v = variantClasses[variant];
  const s = sizeClasses[size];

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onToggle}
      onKeyDown={onKeyDown}
      className={clsx(
        'relative inline-flex items-center border transition-all duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-0',
        s.root,
        v.focusRing,
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
      style={{
        backgroundColor: checked
          ? `color-mix(in srgb, ${v.accent} 18%, var(--aurora-common-secondary))`
          : 'color-mix(in srgb, var(--aurora-common-secondary) 82%, var(--aurora-common-muted) 18%)',
        borderColor: checked
          ? `color-mix(in srgb, ${v.accent} 30%, transparent)`
          : 'color-mix(in srgb, var(--aurora-common-border) 72%, transparent)',
        boxShadow: checked
          ? `
              inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 8%, transparent),
              inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 14%, transparent)
            `
          : `
              inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 5%, transparent),
              inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 12%, transparent)
            `,
      }}
    >
      <span className="pointer-events-none absolute inset-0 flex items-center justify-between px-2">
        <X
          aria-hidden="true"
          className={clsx(s.icon, 'transition-opacity', checked ? 'opacity-0 text-text-disabled' : 'opacity-90 text-danger')}
        />
        <Check
          aria-hidden="true"
          className={clsx(s.icon, 'transition-opacity', checked ? 'opacity-75 text-primary' : 'opacity-0 text-text-disabled')}
        />
      </span>
      <span
        aria-hidden="true"
        className={clsx(
          'absolute left-[3px] top-[3px] rounded-full transition-transform duration-200',
          s.thumb,
          checked ? s.thumbTranslate : 'translate-x-0',
        )}
        style={{
          backgroundColor: checked
            ? `color-mix(in srgb, ${v.accent} 84%, white 16%)`
            : 'color-mix(in srgb, var(--aurora-common-primary-foreground) 90%, transparent)',
          boxShadow: `
            0 6px 14px color-mix(in srgb, var(--aurora-common-shadow) 18%, transparent),
            inset 0 1px 0 color-mix(in srgb, white 38%, transparent),
            inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 12%, transparent)
          `,
        }}
      />
      <span className="sr-only">{checked ? labelOn : labelOff}</span>
    </button>
  );
};
