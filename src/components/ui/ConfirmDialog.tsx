/**
 * THEME ARCHITECTURE NOTICE:
 *
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 * Use theme tokens via CSS variables (`var(--aurora-...)`) and Tailwind
 * semantic classes (`bg-sidebar`, `text-text-primary`, etc.).
 * See: DOCS/theme-dev.md
 */

import React, { useEffect, useRef } from "react";
import {
  AlertTriangle,
  AlertOctagon,
  Info,
  X,
  type LucideIcon,
} from "lucide-react";

export type ConfirmVariant = "danger" | "warning" | "info";

interface ConfirmDialogProps {
  isOpen: boolean;
  /** Visual+semantic intent. Drives icon tint and the confirm-button color. */
  variant?: ConfirmVariant;
  /** Modal heading (e.g. "Delete file", "Microphone access"). */
  title: string;
  /** Body copy — one short sentence, two at most. */
  description?: React.ReactNode;
  /** Optional inset card with a label + value (e.g. "File to delete: …"). */
  details?: {
    label: string;
    value: React.ReactNode;
  } | null;
  /** Override the auto-selected variant icon. */
  icon?: LucideIcon;
  /** Optional extra content slot rendered above the action row. */
  children?: React.ReactNode;

  /** Confirm-button label. Defaults to a variant-appropriate verb. */
  confirmLabel?: string;
  /** Cancel-button label. */
  cancelLabel?: string;
  /** Hide the cancel button (rare — e.g. fatal-error acknowledgement). */
  hideCancel?: boolean;
  /** Disable the confirm button (e.g. while waiting for a precondition). */
  confirmDisabled?: boolean;

  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * IDE-native confirmation modal.
 *
 * Replaces the previous bespoke `DeleteConfirmDialog` styling (rounded-2xl,
 * shadow-2xl, big colored icon plate) with a tighter, JetBrains/VS-Code-style
 * geometry: 1px border, low-elevation shadow, rounded-md, smaller icon plate
 * sized to match the chip badges used across the rest of the UI.
 *
 * Keyboard:
 *   - Esc → cancel
 *   - Enter → confirm (when the confirm button is enabled)
 *   - Focus is moved to the confirm button on mount so users on keyboard-only
 *     workflows can hit Enter immediately.
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  variant = "danger",
  title,
  description,
  details = null,
  icon,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  hideCancel = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}) => {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  // Auto-focus confirm; wire global Esc/Enter handlers while open.
  useEffect(() => {
    if (!isOpen) return;
    confirmRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter" && !confirmDisabled) {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onCancel, onConfirm, confirmDisabled]);

  if (!isOpen) return null;

  const ResolvedIcon: LucideIcon =
    icon ??
    (variant === "danger"
      ? AlertOctagon
      : variant === "warning"
        ? AlertTriangle
        : Info);

  // Variant tokens — kept inline so a future palette change only touches
  // one place. All values resolve to theme CSS variables.
  const variantClasses: Record<
    ConfirmVariant,
    {
      iconText: string;
      iconBg: string;
      iconRing: string;
      confirmBg: string;
      confirmText: string;
      confirmHoverBg: string;
    }
  > = {
    danger: {
      iconText: "text-danger",
      iconBg: "bg-danger/10",
      iconRing: "ring-1 ring-danger/25",
      confirmBg: "bg-danger",
      confirmText: "text-danger-foreground",
      confirmHoverBg: "hover:bg-danger/85",
    },
    warning: {
      iconText: "text-warning",
      iconBg: "bg-warning/10",
      iconRing: "ring-1 ring-warning/25",
      confirmBg: "bg-warning",
      confirmText: "text-warning-foreground",
      confirmHoverBg: "hover:bg-warning/85",
    },
    info: {
      iconText: "text-primary",
      iconBg: "bg-primary/10",
      iconRing: "ring-1 ring-primary/25",
      confirmBg: "bg-primary",
      confirmText: "text-primary-foreground",
      confirmHoverBg: "hover:bg-primary/85",
    },
  };
  const v = variantClasses[variant];

  const resolvedConfirmLabel =
    confirmLabel ??
    (variant === "danger" ? "Delete" : variant === "warning" ? "Continue" : "Allow");

  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/55"
      onClick={onCancel}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="aurora-confirm-title"
        className="w-[420px] max-w-[calc(100vw-32px)] overflow-hidden rounded-md border border-border bg-sidebar shadow-[0_8px_24px_rgba(0,0,0,0.35)] animate-in fade-in zoom-in-95 duration-100"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 px-4 pt-4 pb-3">
          <div
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${v.iconBg} ${v.iconRing}`}
          >
            <ResolvedIcon className={`h-4 w-4 ${v.iconText}`} strokeWidth={2} />
          </div>

          <div className="min-w-0 flex-1 pt-0.5">
            <h3
              id="aurora-confirm-title"
              className="text-[13px] font-semibold text-text-primary tracking-tight"
            >
              {title}
            </h3>
            {description && (
              <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">
                {description}
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={onCancel}
            className="-mr-1 -mt-1 p-1 rounded text-text-disabled hover:text-text-primary hover:bg-input/70 transition-colors shrink-0"
            aria-label="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Optional details strip — sized identically to the explorer chips. */}
        {details && (
          <div className="mx-4 mb-3 rounded border border-border bg-input/40 px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-text-disabled">
              {details.label}
            </p>
            <p className="mt-0.5 truncate text-[12px] font-medium text-text-primary">
              {details.value}
            </p>
          </div>
        )}

        {/* Optional slot — used by SpeechInputButton for "remember choice". */}
        {children && <div className="mx-4 mb-3">{children}</div>}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 border-t border-border bg-titlebar/60 px-4 py-2.5">
          {!hideCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:text-text-primary bg-input/60 hover:bg-input border border-border transition-colors"
            >
              {cancelLabel}
            </button>
          )}
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled}
            className={`rounded px-3 py-1.5 text-[12px] font-semibold ${v.confirmBg} ${v.confirmText} ${v.confirmHoverBg} disabled:opacity-50 disabled:cursor-not-allowed transition-colors`}
          >
            {resolvedConfirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDialog;
