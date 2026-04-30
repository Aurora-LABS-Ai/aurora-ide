import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Box, Check, ChevronDown, Search, Settings } from "lucide-react";
import { createPortal } from "react-dom";
import clsx from "clsx";

type DropdownPlacement = "above" | "below";

interface ModelOption {
  providerId: string;
  providerName: string;
  model: string;
  label: string;
}

interface ModelSelectorProps {
  availableModels: ModelOption[];
  currentModelLabel: string;
  onOpenSettings: () => void;
  onSelectModel: (providerId: string, model: string) => void;
  selectedModel: string;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  availableModels,
  currentModelLabel,
  onOpenSettings,
  onSelectModel,
  selectedModel,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isHovered, setIsHovered] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({
    top: 0,
    left: 0,
    width: 320,
    placement: "above" as DropdownPlacement,
  });

  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Group filtered models by provider for an enterprise-style listing.
  const groupedFiltered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const matches = !query
      ? availableModels
      : availableModels.filter(({ label, model, providerName }) =>
          [label, model, providerName].some((value) =>
            value.toLowerCase().includes(query),
          ),
        );

    const map = new Map<string, ModelOption[]>();
    for (const option of matches) {
      const existing = map.get(option.providerId) ?? [];
      existing.push(option);
      map.set(option.providerId, existing);
    }
    return Array.from(map.entries());
  }, [availableModels, searchQuery]);

  const totalFilteredCount = useMemo(
    () => groupedFiltered.reduce((sum, [, list]) => sum + list.length, 0),
    [groupedFiltered],
  );

  const getProviderMonogram = useCallback((providerName: string) => {
    return providerName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || "")
      .join("");
  }, []);

  const updateDropdownPosition = useCallback(() => {
    if (!buttonRef.current) return;

    const rect = buttonRef.current.getBoundingClientRect();
    const viewportPadding = 12;
    const dropdownWidth = Math.min(360, window.innerWidth - viewportPadding * 2);
    const fallbackDropdownHeight = Math.min(
      Math.max(totalFilteredCount * 38 + 110, 160),
      440,
    );
    const dropdownHeight =
      dropdownRef.current?.getBoundingClientRect().height ??
      fallbackDropdownHeight;
    const overlap = 6;

    const left = Math.min(
      Math.max(rect.left, viewportPadding),
      window.innerWidth - dropdownWidth - viewportPadding,
    );

    const preferredTop = rect.top - dropdownHeight - overlap;
    const placement: DropdownPlacement =
      preferredTop >= viewportPadding ? "above" : "below";

    const top =
      placement === "above"
        ? Math.max(viewportPadding, preferredTop)
        : Math.min(
            rect.bottom + overlap,
            window.innerHeight - dropdownHeight - viewportPadding,
          );

    setDropdownPosition({ top, left, width: dropdownWidth, placement });
  }, [totalFilteredCount]);

  useLayoutEffect(() => {
    if (!isOpen) return;

    updateDropdownPosition();

    const handleWindowChange = () => {
      updateDropdownPosition();
    };

    window.addEventListener("resize", handleWindowChange);
    window.addEventListener("scroll", handleWindowChange, true);

    return () => {
      window.removeEventListener("resize", handleWindowChange);
      window.removeEventListener("scroll", handleWindowChange, true);
    };
  }, [isOpen, updateDropdownPosition]);

  useEffect(() => {
    if (!isOpen || availableModels.length === 0) return;

    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [isOpen, availableModels.length]);

  useEffect(() => {
    if (!isOpen) {
      const timer = window.setTimeout(() => {
        setSearchQuery("");
      }, 120);
      return () => window.clearTimeout(timer);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (wrapperRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setIsOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  const handleToggle = () => {
    if (isOpen) {
      setIsOpen(false);
      return;
    }

    updateDropdownPosition();
    setIsOpen(true);
  };

  const handleSelectModel = (providerId: string, model: string) => {
    onSelectModel(providerId, model);
    setIsOpen(false);
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Trigger button styling — compact pill that still reads as "chat", but
  // thinned to enterprise weight (no inset gradient stack, no heavy shadow).
  // ──────────────────────────────────────────────────────────────────────────
  const triggerStyle: React.CSSProperties = {
    backgroundColor: isOpen
      ? "color-mix(in srgb, var(--aurora-common-primary) 12%, var(--aurora-chat-surface) 88%)"
      : isHovered
        ? "color-mix(in srgb, var(--aurora-common-primary) 6%, var(--aurora-chat-surface) 94%)"
        : "color-mix(in srgb, var(--aurora-chat-surface) 92%, transparent)",
    border: `1px solid ${
      isOpen
        ? "color-mix(in srgb, var(--aurora-common-primary) 35%, transparent)"
        : "color-mix(in srgb, var(--aurora-chat-surface-border) 80%, transparent)"
    }`,
    borderRadius: 7,
    transition: "background-color 140ms ease, border-color 140ms ease",
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Dropdown panel — tightened to IdeSelect aesthetic. Single 1px border,
  // soft drop shadow, no backdrop blur, no glow gradient.
  // ──────────────────────────────────────────────────────────────────────────
  const dropdownPanelStyle: React.CSSProperties = {
    top: dropdownPosition.top,
    left: dropdownPosition.left,
    width: dropdownPosition.width,
    backgroundColor:
      "color-mix(in srgb, var(--aurora-sidebar-background) 96%, var(--aurora-chat-surface) 4%)",
    border: "1px solid color-mix(in srgb, var(--aurora-common-border) 65%, transparent)",
    borderRadius: 10,
    boxShadow:
      "0 12px 28px color-mix(in srgb, var(--aurora-common-shadow) 22%, transparent)",
    transformOrigin:
      dropdownPosition.placement === "above" ? "bottom left" : "top left",
  };

  const dropdown = (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={dropdownRef}
          initial={{
            opacity: 0,
            y: dropdownPosition.placement === "above" ? 4 : -4,
          }}
          animate={{ opacity: 1, y: 0 }}
          exit={{
            opacity: 0,
            y: dropdownPosition.placement === "above" ? 4 : -4,
            transition: { duration: 0.1, ease: [0.4, 0, 1, 1] },
          }}
          transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
          id="model-selector-dropdown"
          className="fixed z-[10000] overflow-hidden"
          style={dropdownPanelStyle}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between gap-2 px-3 pt-2.5"
            style={{
              borderBottom:
                "1px solid color-mix(in srgb, var(--aurora-common-border) 40%, transparent)",
              paddingBottom: 10,
              backgroundColor:
                "color-mix(in srgb, var(--aurora-title-bar-background) 35%, transparent)",
            }}
          >
            <div>
              <p
                className="text-[10px] font-semibold uppercase tracking-[0.14em]"
                style={{ color: "var(--aurora-text-disabled, var(--aurora-editor-foreground))" }}
              >
                Model
              </p>
              <p className="mt-0.5 text-[12px] font-semibold text-text-primary">
                Select a model
              </p>
            </div>
            <span
              className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium"
              style={{
                backgroundColor:
                  "color-mix(in srgb, var(--aurora-common-primary) 12%, transparent)",
                color: "var(--aurora-common-primary)",
                border:
                  "1px solid color-mix(in srgb, var(--aurora-common-primary) 28%, transparent)",
                borderRadius: 4,
              }}
            >
              {availableModels.length}
            </span>
          </div>

          {/* Search */}
          {availableModels.length > 0 && (
            <div className="px-3 py-2">
              <label className="relative block">
                <Search
                  size={12}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-disabled"
                />
                <input
                  ref={searchInputRef}
                  autoFocus
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search models or providers…"
                  className="h-7 w-full pl-7 pr-2 text-[12px] text-text-primary outline-none transition-colors placeholder:text-text-disabled"
                  style={{
                    backgroundColor:
                      "color-mix(in srgb, var(--aurora-editor-background) 65%, var(--aurora-sidebar-background) 35%)",
                    border:
                      "1px solid color-mix(in srgb, var(--aurora-common-border) 55%, transparent)",
                    borderRadius: 6,
                  }}
                  onFocus={(event) => {
                    event.currentTarget.style.borderColor =
                      "color-mix(in srgb, var(--aurora-common-primary) 50%, transparent)";
                  }}
                  onBlur={(event) => {
                    event.currentTarget.style.borderColor =
                      "color-mix(in srgb, var(--aurora-common-border) 55%, transparent)";
                  }}
                />
              </label>
            </div>
          )}

          {/* Body */}
          {availableModels.length === 0 ? (
            <div className="p-4 text-center">
              <p className="mb-2 text-[11.5px] text-text-secondary">
                No models configured
              </p>
              <button
                onClick={() => {
                  setIsOpen(false);
                  onOpenSettings();
                }}
                className="mx-auto inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold transition-colors"
                style={{
                  color: "var(--aurora-common-primary)",
                  backgroundColor:
                    "color-mix(in srgb, var(--aurora-common-primary) 12%, transparent)",
                  border:
                    "1px solid color-mix(in srgb, var(--aurora-common-primary) 30%, transparent)",
                  borderRadius: 5,
                }}
              >
                <Settings size={11} />
                <span>Configure providers</span>
              </button>
            </div>
          ) : totalFilteredCount === 0 ? (
            <div className="p-5 text-center">
              <p className="text-[11.5px] text-text-secondary">
                No models match that search.
              </p>
              <button
                onClick={() => setSearchQuery("")}
                className="mt-1.5 text-[11px] font-medium transition-colors hover:underline"
                style={{ color: "var(--aurora-common-primary)" }}
              >
                Clear search
              </button>
            </div>
          ) : (
            <div className="max-h-[340px] overflow-y-auto px-1.5 py-1 scrollbar-thin">
              {groupedFiltered.map(([providerId, list]) => {
                const providerName = list[0]?.providerName ?? providerId;
                const monogram = getProviderMonogram(providerName);
                return (
                  <div key={providerId} className="pb-1">
                    <div
                      className="flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em]"
                      style={{ color: "var(--aurora-text-disabled, var(--aurora-editor-foreground))" }}
                    >
                      <span
                        className="inline-flex h-3.5 w-3.5 items-center justify-center text-[8px] font-bold"
                        style={{
                          backgroundColor:
                            "color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)",
                          color: "var(--aurora-common-primary)",
                          borderRadius: 3,
                        }}
                      >
                        {monogram || "AI"}
                      </span>
                      <span>{providerName}</span>
                    </div>

                    {list.map(({ providerId: pId, model, label }) => {
                      const optionKey = `${pId}:${model}`;
                      const isSelected = selectedModel === optionKey;

                      return (
                        <button
                          key={optionKey}
                          onClick={() => handleSelectModel(pId, model)}
                          className={clsx(
                            "group flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px] transition-colors",
                          )}
                          style={{
                            color: isSelected
                              ? "var(--aurora-common-primary)"
                              : "var(--aurora-editor-foreground)",
                            backgroundColor: isSelected
                              ? "color-mix(in srgb, var(--aurora-common-primary) 12%, transparent)"
                              : "transparent",
                            borderRadius: 5,
                          }}
                          onMouseEnter={(event) => {
                            if (isSelected) return;
                            event.currentTarget.style.backgroundColor =
                              "color-mix(in srgb, var(--aurora-common-primary) 6%, transparent)";
                          }}
                          onMouseLeave={(event) => {
                            if (isSelected) return;
                            event.currentTarget.style.backgroundColor =
                              "transparent";
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {label}
                          </span>
                          <span
                            className="font-mono text-[10px]"
                            style={{
                              color: "var(--aurora-text-disabled, var(--aurora-editor-foreground))",
                              opacity: 0.7,
                            }}
                          >
                            {model.length > 26
                              ? `${model.slice(0, 24)}…`
                              : model}
                          </span>
                          <Check
                            size={12}
                            className="shrink-0"
                            style={{
                              color: isSelected
                                ? "var(--aurora-common-primary)"
                                : "transparent",
                            }}
                          />
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <div ref={wrapperRef} className="relative z-20">
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggle}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className="flex h-7 items-center gap-1.5 px-2 pr-1.5 text-[11px] font-medium text-text-primary"
        style={triggerStyle}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        title={currentModelLabel}
      >
        <span
          className="flex h-4 w-4 shrink-0 items-center justify-center"
          style={{
            backgroundColor:
              "color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)",
            color: "var(--aurora-common-primary)",
            borderRadius: 3,
          }}
        >
          <Box size={10} />
        </span>
        <span className="max-w-[164px] truncate">{currentModelLabel}</span>
        <motion.span
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ duration: 0.16, ease: [0.4, 0, 0.2, 1] }}
          className="flex shrink-0"
        >
          <ChevronDown size={11} className="text-text-disabled" />
        </motion.span>
      </button>
      {typeof document !== "undefined"
        ? createPortal(dropdown, document.body)
        : null}
    </div>
  );
};
