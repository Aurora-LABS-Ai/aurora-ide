import clsx from 'clsx';
import React, { useCallback } from 'react';

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

const variantClasses: Record<ToggleVariant, { activeBg: string; activeText: string; focusRing: string }> = {
  primary: {
    activeBg: 'bg-primary',
    activeText: 'text-primary-foreground',
    focusRing: 'focus-visible:ring-primary/40',
  },
  success: {
    activeBg: 'bg-success',
    activeText: 'text-success-foreground',
    focusRing: 'focus-visible:ring-success/40',
  },
  warning: {
    activeBg: 'bg-warning',
    activeText: 'text-warning-foreground',
    focusRing: 'focus-visible:ring-warning/40',
  },
  checkpoint: {
    activeBg: 'bg-checkpoint',
    activeText: 'text-checkpoint-foreground',
    focusRing: 'focus-visible:ring-checkpoint/40',
  },
};

const sizeClasses: Record<ToggleSize, { root: string; text: string }> = {
  sm: {
    root: 'h-5 w-[52px] rounded-md',
    text: 'text-[9px] leading-none',
  },
  md: {
    root: 'h-6 w-[64px] rounded-lg',
    text: 'text-[10px] leading-none',
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
        'relative inline-grid grid-cols-2 items-center justify-items-center border border-border bg-input transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-0',
        s.root,
        v.focusRing,
        disabled && 'opacity-60 cursor-not-allowed',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          'absolute top-0.5 left-0.5 h-[calc(100%-4px)] w-[calc(50%-2px)] rounded-[inherit] shadow-sm transition-transform duration-150',
          v.activeBg,
          checked ? 'translate-x-[calc(100%+0px)]' : 'translate-x-0',
        )}
      />
      <span
        className={clsx(
          'z-10 select-none font-medium tracking-wide',
          s.text,
          checked ? 'text-text-secondary' : v.activeText,
        )}
      >
        {labelOff}
      </span>
      <span
        className={clsx(
          'z-10 select-none font-medium tracking-wide',
          s.text,
          checked ? v.activeText : 'text-text-secondary',
        )}
      >
        {labelOn}
      </span>
    </button>
  );
};

