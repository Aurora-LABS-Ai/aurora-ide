/**
 * Agent Window — Settings · Team (view).
 *
 * The dedicated home for the Agent Team: a virtual engineering team that plans,
 * splits the project by scope, and runs peer workers under one lead you chat
 * with. This page owns everything team-shaped — enablement, size ceiling, the
 * team model, and (soon) recent runs.
 * All controls read/write the shared `useSettingsStore` so the IDE and this
 * window stay in lockstep. Reads `--agw-*` tokens exclusively.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";

import {
  useSettingsStore,
  TEAM_SIZE_HARD_CEILING,
  TEAM_SIZE_RECOMMENDED,
} from "../../store/useSettingsStore";
import { AgentIcon } from "../shared/AgentIcon";
import {
  AgwPill,
  AgwSwitch,
  SettingsRow,
  SettingsSection,
} from "./primitives";

// ── Model select (value/label/meta, no native <select>) ──────────────────────

interface ModelOption {
  value: string;
  label: string;
  meta?: string;
}

interface MenuRect {
  left: number;
  width: number;
  maxHeight: number;
  up: boolean;
  top?: number;
  bottom?: number;
}

const ModelSelect: React.FC<{
  value: string;
  options: ModelOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
}> = ({ value, options, onChange, ariaLabel, disabled }) => {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<MenuRect | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const attachRoot = useCallback((el: HTMLDivElement | null) => {
    if (el) setPortalTarget((el.closest(".agw-root") as HTMLElement) ?? document.body);
  }, []);

  const place = useCallback(() => {
    const t = triggerRef.current?.getBoundingClientRect();
    if (!t) return;
    const GAP = 6;
    const MARGIN = 12;
    const est = Math.min(300, options.length * 34 + 10);
    const below = window.innerHeight - t.bottom - GAP;
    const above = t.top - GAP;
    const openUp = below < est && above > below;
    if (openUp) {
      setRect({
        left: t.left,
        bottom: window.innerHeight - t.top + GAP,
        width: t.width,
        maxHeight: Math.min(est, above - MARGIN),
        up: true,
      });
    } else {
      setRect({
        left: t.left,
        top: t.bottom + GAP,
        width: t.width,
        maxHeight: Math.min(est, below - MARGIN),
        up: false,
      });
    }
  }, [options.length]);

  const toggle = useCallback(() => {
    if (disabled) return;
    setOpen((prev) => {
      if (!prev) place();
      return !prev;
    });
  }, [disabled, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
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

  const selected = options.find((o) => o.value === value) ?? options[0];

  return (
    <div className="agw-agent-modelsel" ref={attachRoot}>
      <button
        ref={triggerRef}
        type="button"
        className="agw-csel-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-open={open || undefined}
        disabled={disabled}
        onClick={toggle}
      >
        <span className="agw-agent-modelsel-label">{selected?.label}</span>
        <AgentIcon
          name="chevron-down"
          size={13}
          style={{
            flexShrink: 0,
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
                className="agw-menu agw-scroll"
                initial={{ opacity: 0, scale: 0.97, y: rect.up ? 6 : -6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97, y: rect.up ? 6 : -6 }}
                transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                style={{
                  position: "fixed",
                  left: rect.left,
                  ...(rect.up ? { bottom: rect.bottom } : { top: rect.top }),
                  width: rect.width,
                  transformOrigin: rect.up ? "bottom left" : "top left",
                  zIndex: 1000,
                  maxHeight: rect.maxHeight,
                  overflowY: "auto",
                  scrollbarGutter: "stable",
                  padding: 5,
                }}
              >
                {options.map((o) => (
                  <button
                    key={o.value || "__default__"}
                    type="button"
                    role="option"
                    aria-selected={o.value === value}
                    className="agw-csel-item"
                    data-active={o.value === value || undefined}
                    onClick={() => {
                      onChange(o.value);
                      setOpen(false);
                    }}
                  >
                    <span className="agw-agent-modelsel-itemlabel">{o.label}</span>
                    {o.meta && <span className="agw-agent-modelsel-meta">{o.meta}</span>}
                    {o.value === value && <AgentIcon name="check" size={13} />}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>,
          portalTarget,
        )}
    </div>
  );
};

// ── Stepper (team size) ──────────────────────────────────────────────────────

const Stepper: React.FC<{
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  format: (v: number) => string;
}> = ({ value, min, max, onChange, disabled, format }) => {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <div className="agw-agent-stepper" data-disabled={disabled || undefined}>
      <button
        type="button"
        className="agw-agent-stepper-btn"
        aria-label="Decrease team size"
        disabled={disabled || value <= min}
        onClick={() => onChange(clamp(value - 1))}
      >
        &#8722;
      </button>
      <span className="agw-agent-stepper-val">{format(value)}</span>
      <button
        type="button"
        className="agw-agent-stepper-btn"
        aria-label="Increase team size"
        disabled={disabled || value >= max}
        onClick={() => onChange(clamp(value + 1))}
      >
        +
      </button>
    </div>
  );
};

// ── Page ─────────────────────────────────────────────────────────────────────

export const TeamSettings: React.FC = () => {
  const teamEnabled = useSettingsStore((s) => s.teamEnabled);
  const maxTeamSize = useSettingsStore((s) => s.maxTeamSize);
  const setTeamEnabled = useSettingsStore((s) => s.setTeamEnabled);
  const setMaxTeamSize = useSettingsStore((s) => s.setMaxTeamSize);
  const teamMemberModel = useSettingsStore((s) => s.teamMemberModel);
  const setTeamMemberModel = useSettingsStore((s) => s.setTeamMemberModel);

  const providers = useSettingsStore((s) => s.providers);
  const modelSlice = useSettingsStore((s) => s.models);
  const getAvailableModels = useSettingsStore((s) => s.getAvailableModels);

  const modelOptions = useMemo<ModelOption[]>(() => {
    const options: ModelOption[] = [
      { value: "", label: "Same as chat model", meta: "default" },
    ];
    for (const m of getAvailableModels()) {
      options.push({
        value: `${m.providerId}:${m.model}`,
        label: m.label,
        meta: m.providerName,
      });
    }
    return options;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, modelSlice, getAvailableModels]);

  return (
    <div className="agw-set-wide">
      {/* Agent Team */}
      <SettingsSection
        icon="users"
        title="Agent Team"
        description="Give a big task to the agent you're chatting with (the lead), and it assigns scoped peer workers that can coordinate with each other while they work in parallel. You keep talking to the lead; the team works underneath."
        badge={
          <AgwPill tone={teamEnabled ? "success" : "neutral"}>
            {teamEnabled ? "Enabled" : "Disabled"}
          </AgwPill>
        }
      >
        <SettingsRow
          label="Enable Agent Team"
          hint="When on, the lead can convene a team for a request instead of working solo."
        >
          <AgwSwitch
            checked={teamEnabled}
            onChange={setTeamEnabled}
            ariaLabel="Toggle Agent Team"
          />
        </SettingsRow>

        <SettingsRow
          label="Maximum workers"
          hint={`Recommended: ${TEAM_SIZE_RECOMMENDED}. The number of parallel workers the lead can spin up per task. The lead is separate and always present — it's not counted here.`}
        >
          <Stepper
            value={maxTeamSize}
            min={1}
            max={TEAM_SIZE_HARD_CEILING - 1}
            onChange={setMaxTeamSize}
            disabled={!teamEnabled}
            format={(v) => `${v} ${v === 1 ? "worker" : "workers"}`}
          />
        </SettingsRow>

        <SettingsRow
          label="Coordinator"
          hint="Whoever you're chatting with — the model in your composer's selector. It reads your task and decides to convene a team. There's nothing to pick here; switch it by switching your chat model."
        >
          <span style={{ fontSize: 12, color: "var(--agw-text-subtle)" }}>
            Your active chat model
          </span>
        </SettingsRow>

        <SettingsRow
          last
          label="Team model"
          hint="The model every worker runs on. Set this and the workers never use your chat provider. Defaults to your chat model when left blank."
        >
          <ModelSelect
            value={teamMemberModel}
            options={modelOptions}
            onChange={setTeamMemberModel}
            ariaLabel="Team model"
            disabled={!teamEnabled}
          />
        </SettingsRow>
      </SettingsSection>

      {/* Recent runs — placeholder until wired to team_run_status history. */}
      <SettingsSection
        icon="layers"
        title="Recent runs"
        description="Team runs for this project — their goal, phase, and outcome."
      >
        <SettingsRow last label="History" hint="Populates once the team has run in this project.">
          <span style={{ fontSize: 12, color: "var(--agw-text-subtle)" }}>
            No team runs yet.
          </span>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
};
