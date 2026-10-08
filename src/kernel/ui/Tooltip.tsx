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

/** Hand `node` to a ref of either kind, as React itself would. */
function assignRef<T>(ref: React.Ref<T> | undefined, node: T | null): void {
  if (typeof ref === "function") ref(node);
  else if (ref && typeof ref === "object") (ref as React.MutableRefObject<T | null>).current = node;
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

  // The element the tooltip is anchored to. State, not a ref: it is set by
  // the ref callback built during render below, and a callback that wrote a
  // `useRef` there is a ref touched from render as far as React can tell.
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Pointer or focus is on the trigger. The open delay is an effect on this
  // rather than a timer kept in a ref: the handlers below are handed to
  // `cloneElement` while rendering, and a handler that touched a ref there is
  // one React cannot prove safe.
  const [wanted, setWanted] = useState(false);

  const isDisabled =
    label === null || label === undefined || label === false || label === "";

  useEffect(() => {
    if (!wanted || isDisabled) return;
    const timer = window.setTimeout(() => setOpen(true), delay);
    // Leaving before the delay, or unmounting, cancels it.
    return () => window.clearTimeout(timer);
  }, [wanted, delay, isDisabled]);

  const show = useCallback(() => {
    if (!isDisabled) setWanted(true);
  }, [isDisabled]);

  const hide = useCallback(() => {
    setWanted(false);
    setOpen(false);
  }, []);

  // Measure + clamp + auto-flip BEFORE the browser paints the tooltip,
  // otherwise the user sees one frame at (0, 0) before it lands. The result
  // is written onto the panel directly: it is only ever its style, and state
  // for it cost a second render. Measuring has already computed the hidden
  // starting style, so the change below still runs the fade-in transition.
  useLayoutEffect(() => {
    const panelEl = panelRef.current;
    if (!open || !panelEl || !trigger) return;

    const anchor = trigger.getBoundingClientRect();
    const panel = panelEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 6;

    let resolved: TooltipPlacement = placement;

    // Auto-flip top↔bottom if the preferred side would clip.
    if (placement === "top" && anchor.top - panel.height - offset < margin) {
      resolved = "bottom";
    } else if (
      placement === "bottom" &&
      anchor.bottom + panel.height + offset > vh - margin
    ) {
      resolved = "top";
    }

    let left = 0;
    let top = 0;

    if (resolved === "top" || resolved === "bottom") {
      left = anchor.left + anchor.width / 2 - panel.width / 2;
      top =
        resolved === "top"
          ? anchor.top - panel.height - offset
          : anchor.bottom + offset;
    } else {
      top = anchor.top + anchor.height / 2 - panel.height / 2;
      left =
        resolved === "left"
          ? anchor.left - panel.width - offset
          : anchor.right + offset;
    }

    // Clamp horizontally / vertically so the tooltip stays in the viewport.
    if (left + panel.width > vw - margin) left = vw - panel.width - margin;
    if (left < margin) left = margin;
    if (top + panel.height > vh - margin) top = vh - panel.height - margin;
    if (top < margin) top = margin;

    panelEl.style.left = `${left}px`;
    panelEl.style.top = `${top}px`;
    panelEl.style.opacity = "1";
    panelEl.style.transform = "translateY(0) scale(1)";
  }, [open, label, placement, offset, trigger]);

  // Hide on resize / Escape. Previously we also hid on any capture-
  // phase scroll, but in an IDE shell that fires constantly during
  // agent streaming / editor scrolling / terminal output — every
  // tooltip vanished within a frame of being shown. The mouse leaving
  // the trigger is the primary dismissal signal; resize covers the
  // genuine "anchor moved" case.
  useEffect(() => {
    if (!open) return;
    const handleHide = () => hide();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("resize", handleHide);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("resize", handleHide);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open, hide]);

  // Compose handlers with anything the child already had.
  const child = React.Children.only(children);
  const childProps = child.props as Record<string, unknown>;
  // The child's own ref (React 18 keeps it on the element), forwarded to.
  const childRef = (child as unknown as { ref?: React.Ref<HTMLElement> }).ref;

  // Stable per child ref, so React does not detach and re-attach the trigger
  // (and set its state twice) on every render.
  const attachTrigger = useCallback(
    (node: HTMLElement | null) => {
      setTrigger(node);
      assignRef(childRef, node);
    },
    [childRef],
  );

  const composedChild = React.cloneElement(child, {
    ref: attachTrigger,
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
              // Placed and revealed by the layout effect before paint.
              left: 0,
              top: 0,
              backgroundColor: "var(--aurora-sidebar-background)",
              color: "var(--aurora-common-text-primary)",
              border:
                "1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)",
              borderRadius: 6,
              boxShadow:
                "0 6px 18px color-mix(in srgb, var(--aurora-common-shadow) 45%, transparent), 0 2px 5px color-mix(in srgb, var(--aurora-common-shadow) 30%, transparent)",
              opacity: 0,
              transform: "translateY(2px) scale(0.97)",
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
