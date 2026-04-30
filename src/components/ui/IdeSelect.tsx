import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import clsx from 'clsx';

/**
 * IdeSelect — tight enterprise-grade select / dropdown.
 *
 * Visual language is borrowed from VS Code's settings UI and JetBrains:
 *   - 28px tall trigger with 6px radius — no big rounded chrome.
 *   - 1px border, no inset glow, subtle hover/focus tint.
 *   - Dropdown panel uses 6px radius with a single soft drop shadow.
 *   - Options are 28px tall rows (not chunky cards), 4px radius highlight.
 *   - Selected option uses primary tint + simple checkmark on the right.
 *
 * Drop-in API replacement for `SettingsSelect`.
 */

export interface IdeSelectOption {
  description?: string;
  disabled?: boolean;
  label: string;
  meta?: string;
  tone?: 'danger' | 'default' | 'primary' | 'success' | 'warning';
  value: number | string;
}

interface IdeSelectProps {
  align?: 'auto' | 'end' | 'start';
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
  dropdownClassName?: string;
  maxDropdownHeight?: number;
  onChange: (value: number | string) => void;
  options: IdeSelectOption[];
  placeholder?: string;
  value: number | string;
}

interface DropdownPosition {
  left: number;
  maxHeight: number;
  top: number;
  width: number;
}

const TONE_COLOR: Record<NonNullable<IdeSelectOption['tone']>, string> = {
  default: 'var(--aurora-editor-foreground)',
  danger: 'var(--aurora-common-danger)',
  primary: 'var(--aurora-common-primary)',
  success: 'var(--aurora-common-success)',
  warning: 'var(--aurora-common-warning)',
};

export const IdeSelect: React.FC<IdeSelectProps> = ({
  align = 'auto',
  ariaLabel,
  className,
  disabled = false,
  dropdownClassName,
  maxDropdownHeight = 320,
  onChange,
  options,
  placeholder = 'Select an option',
  value,
}) => {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [position, setPosition] = useState<DropdownPosition | null>(null);
  const selectId = useId();

  const selectedOption = useMemo(
    () => options.find((option) => String(option.value) === String(value)),
    [options, value],
  );

  const activeToneColor = TONE_COLOR[selectedOption?.tone || 'default'];

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const margin = 12;
    const gap = 4;

    const dropdownWidth = Math.max(rect.width, 180);
    const desiredLeft = align === 'end' ? rect.right - dropdownWidth : rect.left;
    const left = Math.min(
      Math.max(margin, desiredLeft),
      viewportWidth - dropdownWidth - margin,
    );

    const spaceBelow = viewportHeight - rect.bottom - gap - margin;
    const spaceAbove = rect.top - gap - margin;
    const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(
      120,
      Math.min(maxDropdownHeight, openUp ? spaceAbove : spaceBelow),
    );
    const top = openUp
      ? Math.max(margin, rect.top - maxHeight - gap)
      : Math.min(viewportHeight - margin - maxHeight, rect.bottom + gap);

    setPosition({ left, maxHeight, top, width: dropdownWidth });
  }, [align, maxDropdownHeight]);

  useEffect(() => {
    if (!isOpen) return;

    updatePosition();

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        dropdownRef.current?.contains(target)
      ) {
        return;
      }
      setIsOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const enabledOptions = options.filter((option) => !option.disabled);
      if (enabledOptions.length === 0) {
        if (event.key === 'Escape') {
          setIsOpen(false);
          triggerRef.current?.focus();
        }
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        setIsOpen(false);
        triggerRef.current?.focus();
        return;
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlightedIndex((current) => {
          const currentEnabledIndex = enabledOptions.findIndex(
            (option) => String(option.value) === String(options[current]?.value),
          );
          const nextEnabledIndex =
            event.key === 'ArrowDown'
              ? (currentEnabledIndex + 1 + enabledOptions.length) % enabledOptions.length
              : (currentEnabledIndex - 1 + enabledOptions.length) % enabledOptions.length;
          return options.findIndex(
            (option) =>
              String(option.value) === String(enabledOptions[nextEnabledIndex]?.value),
          );
        });
        return;
      }

      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const candidate = options[highlightedIndex];
        if (candidate && !candidate.disabled) {
          onChange(candidate.value);
          setIsOpen(false);
          triggerRef.current?.focus();
        }
      }
    };

    const handleWindowUpdate = () => updatePosition();

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleWindowUpdate);
    window.addEventListener('scroll', handleWindowUpdate, true);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleWindowUpdate);
      window.removeEventListener('scroll', handleWindowUpdate, true);
    };
  }, [highlightedIndex, isOpen, onChange, options, updatePosition]);

  const handleToggle = () => {
    if (disabled) return;
    setIsOpen((current) => {
      const nextOpen = !current;
      if (nextOpen) {
        const selectedIndex = options.findIndex(
          (option) => String(option.value) === String(value) && !option.disabled,
        );
        const fallbackIndex = options.findIndex((option) => !option.disabled);
        setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : fallbackIndex);
      }
      return nextOpen;
    });
  };

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const selectedIndex = options.findIndex(
        (option) => String(option.value) === String(value) && !option.disabled,
      );
      const fallbackIndex = options.findIndex((option) => !option.disabled);
      setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : fallbackIndex);
      setIsOpen(true);
    }
  };

  const triggerBg = isOpen
    ? 'color-mix(in srgb, var(--aurora-common-primary) 8%, var(--aurora-common-secondary) 92%)'
    : isHovered
      ? 'color-mix(in srgb, var(--aurora-common-primary) 4%, var(--aurora-common-secondary) 96%)'
      : 'color-mix(in srgb, var(--aurora-common-secondary) 76%, var(--aurora-title-bar-background) 24%)';

  const triggerBorder = isOpen
    ? 'color-mix(in srgb, var(--aurora-common-primary) 50%, transparent)'
    : isHovered
      ? 'color-mix(in srgb, var(--aurora-common-border) 90%, transparent)'
      : 'color-mix(in srgb, var(--aurora-common-border) 70%, transparent)';

  const dropdown =
    isOpen && position
      ? createPortal(
          <div
            ref={dropdownRef}
            id={`${selectId}-dropdown`}
            className={clsx(
              'fixed z-[11000] overflow-hidden animate-in fade-in zoom-in-95 duration-100',
              dropdownClassName,
            )}
            style={{
              top: position.top,
              left: position.left,
              width: position.width,
              backgroundColor:
                'color-mix(in srgb, var(--aurora-sidebar-background) 92%, var(--aurora-editor-background) 8%)',
              border:
                '1px solid color-mix(in srgb, var(--aurora-common-border) 78%, transparent)',
              borderRadius: 6,
              boxShadow:
                '0 8px 24px color-mix(in srgb, var(--aurora-common-shadow) 32%, transparent)',
            }}
          >
            <div
              className="max-h-full overflow-y-auto py-1 scrollbar-thin"
              style={{ maxHeight: position.maxHeight, scrollbarGutter: 'stable' }}
            >
              {options.map((option, index) => {
                const isSelected = String(option.value) === String(value);
                const isHighlighted = index === highlightedIndex;
                const toneColor = TONE_COLOR[option.tone || 'default'];
                const hasSubInfo = option.description || option.meta;

                return (
                  <button
                    key={String(option.value)}
                    type="button"
                    disabled={option.disabled}
                    onClick={() => {
                      if (option.disabled) return;
                      onChange(option.value);
                      setIsOpen(false);
                      triggerRef.current?.focus();
                    }}
                    onMouseEnter={() => !option.disabled && setHighlightedIndex(index)}
                    className={clsx(
                      'mx-1 flex w-[calc(100%-8px)] items-start justify-between gap-2 px-2 py-1.5 text-left transition-colors',
                      option.disabled && 'cursor-not-allowed opacity-50',
                    )}
                    style={{
                      borderRadius: 4,
                      backgroundColor: option.disabled
                        ? 'transparent'
                        : isSelected
                          ? 'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)'
                          : isHighlighted
                            ? 'color-mix(in srgb, var(--aurora-editor-foreground) 8%, transparent)'
                            : 'transparent',
                    }}
                  >
                    <div className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span
                        className={clsx('truncate text-[11.5px]', isSelected ? 'font-semibold' : 'font-medium')}
                        style={{ color: isSelected ? toneColor : 'var(--aurora-editor-foreground)' }}
                      >
                        {option.label}
                      </span>
                      {option.meta && (
                        <span className="shrink-0 text-[10px] font-mono text-text-disabled">
                          {option.meta}
                        </span>
                      )}
                    </div>
                    {isSelected ? (
                      <Check
                        className="mt-[2px] h-3 w-3 shrink-0"
                        style={{ color: toneColor }}
                      />
                    ) : (
                      <span className="h-3 w-3 shrink-0" />
                    )}
                    {hasSubInfo && option.description && (
                      <span className="basis-full text-[10px] leading-snug text-text-secondary">
                        {option.description}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        onClick={handleToggle}
        onKeyDown={handleTriggerKeyDown}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        disabled={disabled}
        className={clsx(
          'inline-flex h-7 min-w-0 items-center justify-between gap-1.5 px-2.5 text-left text-[11.5px] font-medium transition-colors',
          'focus:outline-none disabled:cursor-not-allowed disabled:opacity-55',
          className,
        )}
        style={{
          backgroundColor: triggerBg,
          border: `1px solid ${triggerBorder}`,
          borderRadius: 6,
          color: selectedOption ? activeToneColor : 'var(--aurora-text-disabled)',
        }}
      >
        <span className="truncate">{selectedOption?.label || placeholder}</span>
        <ChevronDown
          className={clsx(
            'h-3 w-3 shrink-0 transition-transform duration-150',
            isOpen && 'rotate-180',
          )}
          style={{ color: 'var(--aurora-text-secondary, var(--aurora-editor-foreground))' }}
        />
      </button>
      {dropdown}
    </>
  );
};
