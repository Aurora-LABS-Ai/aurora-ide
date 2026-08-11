/**
 * Font stack picker — the Appearance → Typography font control.
 *
 * An editable combobox: the input holds the FULL CSS stack (any custom stack
 * can still be typed or pasted, exactly as before), and the chevron opens a
 * dropdown of real choices — the faces bundled with Aurora plus every family
 * installed on this machine, each row previewed in its own face. Picking a
 * family writes `"Family", <canonical fallbacks>` so a chosen font never
 * loses the chain that keeps missing glyphs and missing installs rendering.
 *
 * The installed list comes from `listSystemFontFamilies()` — DirectWrite
 * names scanned ONCE by Rust and cached in the settings store, so only the
 * very first open on a machine pays the scan. The menu's footer offers a
 * rescan for fonts installed since.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";

import { AgentIcon } from "../shared/AgentIcon";
import { listSystemFontFamilies } from "@/kernel/services/system-fonts";
import { primaryFamily, quoteFamily, stackWithPrimary } from "@/kernel/lib/fonts/stacks";

interface MenuRect {
  left: number;
  width: number;
  maxHeight: number;
  up: boolean;
  top?: number;
  bottom?: number;
}

interface FontOption {
  family: string;
  bundled: boolean;
}

const MENU_EST_HEIGHT = 320;

export const FontStackPicker: React.FC<{
  /** The token's current value — a full CSS font-family stack. */
  value: string;
  /** Canonical fallback tail appended after a picked family. */
  baseStack: string;
  /** Families that ship with Aurora — always offered, listed first. */
  bundled: string[];
  onChange: (stack: string) => void;
  ariaLabel: string;
  width?: number;
}> = ({ value, baseStack, bundled, onChange, ariaLabel, width = 280 }) => {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<MenuRect | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [installed, setInstalled] = useState<string[] | null>(null);
  const [scanState, setScanState] = useState<"idle" | "loading" | "error">("idle");
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const highlightRef = useRef<HTMLButtonElement>(null);

  // Same portal rule as AgwSelect: `.agw-settings` first (it runs its own,
  // one-step-smaller type scale), `.agw-root` as the fallback.
  const attachRoot = useCallback((el: HTMLDivElement | null) => {
    (wrapRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    if (!el) return;
    setPortalTarget(
      (el.closest(".agw-settings") as HTMLElement | null) ??
        (el.closest(".agw-root") as HTMLElement | null) ??
        document.body,
    );
  }, []);

  const load = useCallback((refresh: boolean) => {
    setScanState("loading");
    listSystemFontFamilies(refresh)
      .then((families) => {
        setInstalled(families);
        setScanState("idle");
      })
      .catch(() => setScanState("error"));
  }, []);

  const place = useCallback(() => {
    const t = wrapRef.current?.getBoundingClientRect();
    if (!t) return;
    const GAP = 6;
    const MARGIN = 12;
    const below = window.innerHeight - t.bottom - GAP;
    const above = t.top - GAP;
    const openUp = below < MENU_EST_HEIGHT && above > below;
    if (openUp) {
      setRect({
        left: t.left,
        bottom: window.innerHeight - t.top + GAP,
        width: t.width,
        maxHeight: Math.min(MENU_EST_HEIGHT, above - MARGIN),
        up: true,
      });
    } else {
      setRect({
        left: t.left,
        top: t.bottom + GAP,
        width: t.width,
        maxHeight: Math.min(MENU_EST_HEIGHT, below - MARGIN),
        up: false,
      });
    }
  }, []);

  const openMenu = useCallback(() => {
    place();
    setQuery("");
    setHighlight(0);
    setOpen(true);
    if (installed === null && scanState !== "loading") load(false);
  }, [place, installed, scanState, load]);

  const toggle = useCallback(() => {
    if (open) setOpen(false);
    else openMenu();
  }, [open, openMenu]);

  // Dismissal + reflow, mirroring AgwSelect.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onReflow = () => place();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open, place]);

  // Focus the search as soon as the menu opens — a several-hundred-row list
  // is used by typing, not scrolling.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    highlightRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const current = primaryFamily(value);

  const options = useMemo<FontOption[]>(() => {
    const bundledLower = new Set(bundled.map((f) => f.toLowerCase()));
    const q = query.trim().toLowerCase();
    const match = (family: string) => !q || family.toLowerCase().includes(q);
    const bundledRows = bundled.filter(match).map((family) => ({ family, bundled: true }));
    const installedRows = (installed ?? [])
      .filter((family) => !bundledLower.has(family.toLowerCase()))
      .filter(match)
      .map((family) => ({ family, bundled: false }));
    return [...bundledRows, ...installedRows];
  }, [bundled, installed, query]);

  const pick = useCallback(
    (family: string) => {
      onChange(stackWithPrimary(family, baseStack));
      setOpen(false);
    },
    [onChange, baseStack],
  );

  const onSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, options.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const opt = options[highlight];
        if (opt) pick(opt.family);
      }
    },
    [options, highlight, pick],
  );

  const showBundledHeader = options.some((o) => o.bundled);
  const firstInstalledIndex = options.findIndex((o) => !o.bundled);

  return (
    <div className="agw-fontpick" ref={attachRoot} style={{ width }}>
      <input
        className="agw-set-input agw-fontpick-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            openMenu();
          }
        }}
        spellCheck={false}
        style={{ fontFamily: value }}
        aria-label={ariaLabel}
      />
      <button
        type="button"
        className="agw-fontpick-btn"
        aria-label={`Choose ${ariaLabel.toLowerCase()} from installed fonts`}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-open={open || undefined}
        onClick={toggle}
      >
        <AgentIcon
          name="chevron-down"
          size={13}
          style={{
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform 0.16s ease",
          }}
        />
      </button>

      {portalTarget &&
        createPortal(
          <AnimatePresence>
            {open && rect && (
              <motion.div
                ref={menuRef}
                role="listbox"
                aria-label={`${ariaLabel} choices`}
                className="agw-menu agw-fontpick-menu"
                initial={{ opacity: 0, scale: 0.97, y: rect.up ? 6 : -6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97, y: rect.up ? 6 : -6 }}
                transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                style={{
                  position: "fixed",
                  left: rect.left,
                  ...(rect.up ? { bottom: rect.bottom } : { top: rect.top }),
                  width: Math.max(rect.width, 260),
                  transformOrigin: rect.up ? "bottom left" : "top left",
                  zIndex: 1000,
                  maxHeight: rect.maxHeight,
                }}
              >
                <div className="agw-fontpick-search">
                  <input
                    ref={searchRef}
                    className="agw-set-input"
                    placeholder="Search fonts…"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setHighlight(0);
                    }}
                    onKeyDown={onSearchKeyDown}
                    spellCheck={false}
                    aria-label="Search fonts"
                  />
                </div>

                <div className="agw-fontpick-list agw-scroll">
                  {showBundledHeader && (
                    <div className="agw-fontpick-group">Bundled with Aurora</div>
                  )}
                  {options.map((opt, i) => {
                    const active = opt.family.toLowerCase() === current.toLowerCase();
                    return (
                      <React.Fragment key={opt.family}>
                        {i === firstInstalledIndex && (
                          <div className="agw-fontpick-group">Installed on this device</div>
                        )}
                        <button
                          type="button"
                          role="option"
                          aria-selected={active}
                          ref={i === highlight ? highlightRef : undefined}
                          className="agw-csel-item"
                          data-active={active || undefined}
                          data-highlight={i === highlight || undefined}
                          onMouseMove={() => setHighlight(i)}
                          onClick={() => pick(opt.family)}
                        >
                          <span
                            className="agw-csel-item-label"
                            style={{ fontFamily: `${quoteFamily(opt.family)}, ${baseStack}` }}
                          >
                            {opt.family}
                          </span>
                          {active && <AgentIcon name="check" size={13} />}
                        </button>
                      </React.Fragment>
                    );
                  })}

                  {scanState === "loading" && installed === null && (
                    <div className="agw-fontpick-note">Scanning installed fonts…</div>
                  )}
                  {scanState === "error" && (
                    <div className="agw-fontpick-note" data-tone="error">
                      Couldn't read this device's fonts.
                      <button type="button" className="agw-fontpick-retry" onClick={() => load(false)}>
                        Try again
                      </button>
                    </div>
                  )}
                  {scanState === "idle" && options.length === 0 && (
                    <div className="agw-fontpick-note">
                      {query.trim()
                        ? `No font matches "${query.trim()}".`
                        : "No fonts found on this device."}
                    </div>
                  )}
                </div>

                <div className="agw-fontpick-foot">
                  <button
                    type="button"
                    className="agw-fontpick-rescan"
                    disabled={scanState === "loading"}
                    onClick={() => load(true)}
                  >
                    {scanState === "loading" && installed !== null
                      ? "Rescanning…"
                      : "Rescan installed fonts"}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          portalTarget,
        )}
    </div>
  );
};
