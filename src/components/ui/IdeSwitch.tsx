import React, { useCallback } from 'react';
import clsx from 'clsx';

/**
 * IdeSwitch — tight enterprise-grade toggle.
 *
 * Visual language is borrowed from VS Code, JetBrains, GitHub, and Linear:
 *   - Compact pill (16-18px tall) — no big chunky controls.
 *   - No icons inside the track — never X/Check decoration.
 *   - Solid accent fill when on, neutral muted fill when off.
 *   - Minimal thumb shadow — no glow, no color-shift.
 *   - 1px border, 100ms transition, square-ish but pill rounded.
 *
 * Drop-in API replacement for `TogglePill`.
 */

export type IdeSwitchSize = 'sm' | 'md';
export type IdeSwitchVariant = 'primary' | 'success' | 'danger' | 'warning';

export interface IdeSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
  size?: IdeSwitchSize;
  variant?: IdeSwitchVariant;
  className?: string;
}

interface SizeTokens {
  root: string;
  thumb: string;
  thumbOff: string;
  thumbOn: string;
}

const SIZE_TOKENS: Record<IdeSwitchSize, SizeTokens> = {
  sm: {
    root: 'h-4 w-7', // 16 × 28
    thumb: 'h-3 w-3', // 12 × 12
    thumbOff: 'translate-x-[1px]',
    thumbOn: 'translate-x-[13px]',
  },
  md: {
    root: 'h-[18px] w-8', // 18 × 32
    thumb: 'h-3.5 w-3.5', // 14 × 14
    thumbOff: 'translate-x-[1px]',
    thumbOn: 'translate-x-[15px]',
  },
};

const VARIANT_ACCENT: Record<IdeSwitchVariant, string> = {
  primary: 'var(--aurora-common-primary)',
  success: 'var(--aurora-common-success)',
  danger: 'var(--aurora-common-danger)',
  warning: 'var(--aurora-common-warning)',
};

export const IdeSwitch: React.FC<IdeSwitchProps> = ({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
  size = 'md',
  variant = 'primary',
  className,
}) => {
  const handleClick = useCallback(() => {
    if (disabled) return;
    onChange(!checked);
  }, [disabled, onChange, checked]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onChange(!checked);
      }
    },
    [disabled, onChange, checked],
  );

  const tokens = SIZE_TOKENS[size];
  const accent = VARIANT_ACCENT[variant];

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={clsx(
        'relative inline-flex shrink-0 items-center rounded-full transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-offset-1',
        tokens.root,
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
      style={{
        backgroundColor: checked
          ? accent
          : 'color-mix(in srgb, var(--aurora-editor-foreground) 18%, transparent)',
        border: `1px solid ${
          checked
            ? `color-mix(in srgb, ${accent} 60%, var(--aurora-common-shadow) 40%)`
            : 'color-mix(in srgb, var(--aurora-common-border) 65%, transparent)'
        }`,
        boxShadow:
          'inset 0 1px 1px color-mix(in srgb, var(--aurora-common-shadow) 12%, transparent)',
      }}
    >
      <span
        aria-hidden="true"
        className={clsx(
          'pointer-events-none absolute top-1/2 -translate-y-1/2 rounded-full transition-transform duration-150',
          tokens.thumb,
          checked ? tokens.thumbOn : tokens.thumbOff,
        )}
        style={{
          backgroundColor: checked
            ? 'var(--aurora-common-primary-foreground)'
            : 'color-mix(in srgb, var(--aurora-editor-foreground) 78%, transparent)',
          boxShadow:
            '0 1px 2px color-mix(in srgb, var(--aurora-common-shadow) 38%, transparent)',
        }}
      />
    </button>
  );
};
