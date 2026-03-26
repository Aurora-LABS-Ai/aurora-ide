import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import clsx from 'clsx';

export interface SettingsSelectOption {
  description?: string;
  disabled?: boolean;
  label: string;
  meta?: string;
  tone?: 'danger' | 'default' | 'primary' | 'success' | 'warning';
  value: number | string;
}

interface SettingsSelectProps {
  align?: 'auto' | 'end' | 'start';
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
  dropdownClassName?: string;
  maxDropdownHeight?: number;
  onChange: (value: number | string) => void;
  options: SettingsSelectOption[];
  placeholder?: string;
  value: number | string;
}

interface DropdownPosition {
  left: number;
  maxHeight: number;
  top: number;
  width: number;
}

const toneMap: Record<NonNullable<SettingsSelectOption['tone']>, string> = {
  default: 'text-text-primary',
  danger: 'text-danger',
  primary: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
};

export const SettingsSelect: React.FC<SettingsSelectProps> = ({
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
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [position, setPosition] = useState<DropdownPosition | null>(null);
  const selectId = useId();

  const selectedOption = useMemo(
    () => options.find((option) => String(option.value) === String(value)),
    [options, value],
  );

  const activeTone = selectedOption?.tone || 'default';

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const margin = 12;
    const gap = 8;

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

    setPosition({
      left,
      maxHeight,
      top,
      width: dropdownWidth,
    });
  }, [align, maxDropdownHeight]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    updatePosition();

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || dropdownRef.current?.contains(target)) {
        return;
      }
      setIsOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isOpen) {
        return;
      }

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
          const nextEnabledIndex = event.key === 'ArrowDown'
            ? (currentEnabledIndex + 1 + enabledOptions.length) % enabledOptions.length
            : (currentEnabledIndex - 1 + enabledOptions.length) % enabledOptions.length;
          return options.findIndex(
            (option) => String(option.value) === String(enabledOptions[nextEnabledIndex]?.value),
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
    if (disabled) {
      return;
    }
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
    if (disabled) {
      return;
    }

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

  const dropdown = isOpen && position
    ? createPortal(
        <div
          ref={dropdownRef}
          id={`${selectId}-dropdown`}
          className={clsx(
            'fixed z-[11000] overflow-hidden rounded-[18px] border animate-in fade-in zoom-in-95 duration-150',
            dropdownClassName,
          )}
          style={{
            top: position.top,
            left: position.left,
            width: position.width,
            backgroundColor: 'color-mix(in srgb, var(--aurora-sidebar-background) 88%, var(--aurora-editor-background) 12%)',
            borderColor: 'color-mix(in srgb, var(--aurora-common-border) 72%, transparent)',
            boxShadow: `
              0 18px 48px color-mix(in srgb, var(--aurora-common-shadow) 24%, transparent),
              inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 7%, transparent),
              inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 12%, transparent)
            `,
            backdropFilter: 'blur(14px)',
          }}
        >
          <div
            className="max-h-full overflow-y-auto p-1.5 scrollbar-thin"
            style={{ maxHeight: position.maxHeight, scrollbarGutter: 'stable' }}
          >
            {options.map((option, index) => {
              const isSelected = String(option.value) === String(value);
              const isHighlighted = index === highlightedIndex;
              const toneClass = toneMap[option.tone || 'default'];

              return (
                <button
                  key={String(option.value)}
                  type="button"
                  disabled={option.disabled}
                  onClick={() => {
                    if (option.disabled) {
                      return;
                    }
                    onChange(option.value);
                    setIsOpen(false);
                    triggerRef.current?.focus();
                  }}
                  onMouseEnter={() => !option.disabled && setHighlightedIndex(index)}
                  className={clsx(
                    'flex w-full items-start justify-between gap-3 rounded-[14px] px-3 py-2 text-left transition-colors',
                    option.disabled && 'cursor-not-allowed opacity-45',
                    !option.disabled && (isHighlighted || isSelected)
                      ? 'bg-primary/10'
                      : 'hover:bg-input/40',
                  )}
                >
                  <div className="min-w-0">
                    <div className={clsx('text-xs font-medium', isSelected ? toneClass : 'text-text-primary')}>
                      {option.label}
                    </div>
                    {(option.description || option.meta) && (
                      <div className="mt-0.5 flex items-center gap-2">
                        {option.description && (
                          <span className="text-[10px] leading-relaxed text-text-secondary">{option.description}</span>
                        )}
                        {option.meta && (
                          <span className="text-[10px] font-mono text-text-disabled">{option.meta}</span>
                        )}
                      </div>
                    )}
                  </div>
                  {isSelected && (
                    <Check className={clsx('mt-0.5 h-3.5 w-3.5 shrink-0', toneClass)} />
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
        disabled={disabled}
        className={clsx(
          'flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-xs font-medium transition-colors focus:outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-55',
          className,
        )}
        style={{
          backgroundColor: 'color-mix(in srgb, var(--aurora-common-secondary) 82%, var(--aurora-common-muted) 18%)',
          border: '1px solid color-mix(in srgb, var(--aurora-common-border) 82%, transparent)',
          boxShadow: `
            inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 6%, transparent),
            inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 10%, transparent)
          `,
        }}
      >
        <span className={clsx('truncate', selectedOption ? toneMap[activeTone] : 'text-text-disabled')}>
          {selectedOption?.label || placeholder}
        </span>
        <ChevronDown
          className={clsx('h-3.5 w-3.5 shrink-0 text-text-disabled transition-transform', isOpen && 'rotate-180')}
        />
      </button>
      {dropdown}
    </>
  );
};
