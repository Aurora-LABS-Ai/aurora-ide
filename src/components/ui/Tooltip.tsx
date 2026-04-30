/**
 * THEME ARCHITECTURE NOTICE:
 *
 * Theme-aware tooltip component matching the enterprise aesthetic used by
 * MenuBarMenu / ContextMenu / IdeSelect. Replaces the browser-native
 * `title=""` tooltip (which renders with the OS chrome and ignores theme).
 *
 *   • 6px radius, 1px theme-aware border, dual soft drop shadows
 *   • 11px text, 6px×9px padding, single line by default
 *   • Portal-rendered → never clipped by parent overflow:hidden
 *   • Hover delay (default 400ms) before showing, instant hide
 *   • Auto-flips above ↔ below if the preferred placement would clip
 *   • No arrow (cleaner IDE feel — matches Cursor / VS Code)
 *
 * Usage:
 *   <Tooltip label="Copy message">
 *     <button>...</button>
 *   </Tooltip>
 *
 * If you need richer markup, pass a ReactNode to `label`. To disable on a
 * per-instance basis (e.g. while a click animation is running), pass
 * `label={null}` or omit the wrapper entirely.
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

type TooltipPlacement = "top" | "bottom" | "left" | "right";

interface TooltipProps {
  /** Tooltip content. If null/undefined the tooltip is disabled. */
  label: React.ReactNode | null | undefined;
  /** The element to attach the tooltip to. Must be a single ReactElement. */
  children: React.ReactElement;
  /** Preferred placement (auto-flips on top/bottom if it would clip). */
  placement?: TooltipPlacement;
  /** Delay before showing on hover. Default 400ms. */
  delay?: number;
  /** Distance in px between trigger and tooltip. Default 6. */
  offset?: number;
  /** Optional className applied to the floating panel for one-off tweaks. */
  panelClassName?: string;
}

interface TooltipPosition {
  left: number;
  top: number;
  placed: boolean;
  placement: TooltipPlacement;
}

export const Tooltip: React.FC<TooltipProps> = ({
  label,
  children,
  placement = "top",
  delay = 400,
  offset = 6,
  panelClassName,
}) => {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<TooltipPosition>({
    left: 0,
    top: 0,
    placed: false,
    placement,
  });

  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);

  const isDisabled =
    label === null || label === undefined || label === false || label === "";

  const show = useCallback(() => {
    if (isDisabled) return;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setOpen(true);
    }, delay);
  }, [delay, isDisabled]);

  const hide = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setOpen(false);
    setPosition((prev) => ({ ...prev, placed: false }));
  }, []);

  // Measure + clamp + auto-flip BEFORE the browser paints the tooltip,
  // otherwise the user sees one frame at (0, 0) before it lands.
  useLayoutEffect(() => {
    if (!open || !panelRef.current || !triggerRef.current) return;

    const trigger = triggerRef.current.getBoundingClientRect();
    const panel = panelRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 6;

    let resolved: TooltipPlacement = placement;

    // Auto-flip top↔bottom if the preferred side would clip.
    if (placement === "top" && trigger.top - panel.height - offset < margin) {
      resolved = "bottom";
    } else if (
      placement === "bottom" &&
      trigger.bottom + panel.height + offset > vh - margin
    ) {
      resolved = "top";
    }

    let left = 0;
    let top = 0;

    if (resolved === "top" || resolved === "bottom") {
      left = trigger.left + trigger.width / 2 - panel.width / 2;
      top =
        resolved === "top"
          ? trigger.top - panel.height - offset
          : trigger.bottom + offset;
    } else {
      top = trigger.top + trigger.height / 2 - panel.height / 2;
      left =
        resolved === "left"
          ? trigger.left - panel.width - offset
          : trigger.right + offset;
    }

    // Clamp horizontally / vertically so the tooltip stays in the viewport.
    if (left + panel.width > vw - margin) left = vw - panel.width - margin;
    if (left < margin) left = margin;
    if (top + panel.height > vh - margin) top = vh - panel.height - margin;
    if (top < margin) top = margin;

    setPosition({ left, top, placed: true, placement: resolved });
  }, [open, label, placement, offset]);

  // Hide on any scroll/resize/escape — feels right and avoids stale positions.
  useEffect(() => {
    if (!open) return;
    const handleHide = () => hide();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("scroll", handleHide, true);
    window.addEventListener("resize", handleHide);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("scroll", handleHide, true);
      window.removeEventListener("resize", handleHide);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open, hide]);

  // Cleanup timer on unmount.
  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    [],
  );

  // Compose handlers with anything the child already had.
  const child = React.Children.only(children);
  const childProps = child.props as Record<string, unknown>;

  const composedChild = React.cloneElement(child, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      // Forward ref if the child had one.
      const childRef = (
        child as unknown as { ref?: React.Ref<HTMLElement> }
      ).ref;
      if (typeof childRef === "function") childRef(node);
      else if (childRef && typeof childRef === "object")
        (childRef as React.MutableRefObject<HTMLElement | null>).current = node;
    },
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      (childProps.onMouseEnter as ((e: React.MouseEvent) => void) | undefined)?.(
        e,
      );
      show();
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      (childProps.onMouseLeave as ((e: React.MouseEvent) => void) | undefined)?.(
        e,
      );
      hide();
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      (childProps.onFocus as ((e: React.FocusEvent) => void) | undefined)?.(e);
      show();
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      (childProps.onBlur as ((e: React.FocusEvent) => void) | undefined)?.(e);
      hide();
    },
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      // Hide immediately on click so the tooltip doesn't linger over the
      // result of the click (e.g. "Copied!" feedback).
      hide();
      (childProps.onClick as ((e: React.MouseEvent) => void) | undefined)?.(e);
    },
  } as React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement> });

  if (isDisabled) return composedChild;

  return (
    <>
      {composedChild}
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="tooltip"
            className={`fixed z-[10000] pointer-events-none select-none whitespace-nowrap text-[11px] font-medium leading-none px-2 py-1.5 ${
              panelClassName ?? ""
            }`}
            style={{
              left: position.left,
              top: position.top,
              backgroundColor: "var(--aurora-sidebar-background)",
              color: "var(--aurora-common-text-primary)",
              border:
                "1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)",
              borderRadius: 6,
              boxShadow:
                "0 6px 18px color-mix(in srgb, var(--aurora-common-shadow) 45%, transparent), 0 2px 5px color-mix(in srgb, var(--aurora-common-shadow) 30%, transparent)",
              opacity: position.placed ? 1 : 0,
              transform: position.placed
                ? "translateY(0) scale(1)"
                : "translateY(2px) scale(0.97)",
              transition:
                "opacity 110ms ease-out, transform 110ms ease-out",
              letterSpacing: "0.01em",
            }}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
};

Tooltip.displayName = "Tooltip";
