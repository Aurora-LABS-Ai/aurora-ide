/**
 * Agent Window — the machine cell [view], web version only.
 *
 * A gauge in the icon rail that, on hover or focus, opens a card with how
 * loaded the machine the ENGINE runs on is: CPU, memory, its data disk, any
 * GPU, uptime and the busiest processes (probe
 * `Documents/aurora-machine-card-designs.html`, card 02, meters). In a browser
 * on `aurora serve` that machine is the server, which is the point; the desktop
 * window runs on the computer in front of you and shows nothing here.
 *
 * It asks the engine (`machine_stats`) every 2 s while the card is open and
 * not at all while it is closed. A click pins the card open; Escape or a
 * second click closes it.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { auroraInvoke, isAuroraRuntimeAvailable, isDesktopRuntime } from "@/kernel/lib/ipc/runtime";
import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import {
  fraction,
  memorySize,
  meterTone,
  percent,
  uptime,
  usedOf,
  type MachineStats,
} from "@/apps/agent/lib/machine/machine-format";

const REFRESH_MS = 2_000;
/** Pointer travel from the cell to the card must not close it. */
const CLOSE_GRACE_MS = 160;

const Meter: React.FC<{ label: string; value: string; fill: number | null }> = ({
  label,
  value,
  fill,
}) => (
  <div className="agw-machine-meter">
    <div className="agw-machine-meter-top">
      <span>{label}</span>
      <span className="agw-machine-meter-value">{value}</span>
    </div>
    {fill !== null && (
      <div className="agw-machine-bar" aria-hidden>
        <i data-tone={meterTone(fill)} style={{ width: `${Math.round(fill * 100)}%` }} />
      </div>
    )}
  </div>
);

const MachineCard: React.FC<{ stats: MachineStats | null; error: string | null }> = ({
  stats,
  error,
}) => {
  if (!stats) {
    return <div className="agw-machine-empty">{error ?? "Reading the machine…"}</div>;
  }
  return (
    <>
      <div className="agw-machine-title">
        <b>{stats.hostname}</b>
        <span>
          {stats.os} · {stats.arch}
        </span>
      </div>
      <Meter
        label="CPU"
        value={`${percent(stats.cpuPercent)} · ${stats.cpuCores} ${stats.cpuCores === 1 ? "core" : "cores"}`}
        fill={stats.cpuPercent / 100}
      />
      <Meter
        label="Memory"
        value={usedOf(stats.memoryUsed, stats.memoryTotal)}
        fill={fraction(stats.memoryUsed, stats.memoryTotal)}
      />
      {stats.disk && (
        <Meter
          label="Disk"
          value={usedOf(stats.disk.used, stats.disk.total)}
          fill={fraction(stats.disk.used, stats.disk.total)}
        />
      )}
      {stats.gpus.length === 0 ? (
        <Meter label="GPU" value="None on this machine" fill={null} />
      ) : (
        stats.gpus.map((gpu, index) => (
          <Meter
            key={`${gpu.name}-${index}`}
            label={stats.gpus.length > 1 ? `GPU ${index + 1}` : "GPU"}
            value={`${percent(gpu.percent)} · ${usedOf(gpu.memoryUsed, gpu.memoryTotal)}`}
            fill={fraction(gpu.memoryUsed, gpu.memoryTotal)}
          />
        ))
      )}
      {stats.gpus.length > 0 && (
        <div className="agw-machine-gpu-names">{stats.gpus.map((gpu) => gpu.name).join(" · ")}</div>
      )}
      <div className="agw-machine-sep" role="separator" />
      <div className="agw-machine-sub">Busiest by memory</div>
      {stats.processes.map((process, index) => (
        <div key={`${process.name}-${index}`} className="agw-machine-proc">
          <span className="agw-machine-proc-name">{process.name}</span>
          <span className="agw-machine-proc-num">{percent(process.cpuPercent)}</span>
          <span className="agw-machine-proc-num">{memorySize(process.memory)}</span>
        </div>
      ))}
      <div className="agw-machine-foot">
        {stats.cpuModel} · up {uptime(stats.uptimeSecs)} · updates every 2 s
        {error && <span className="agw-machine-stale"> · last read failed</span>}
      </div>
    </>
  );
};

export const MachineCell: React.FC = () => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [stats, setStats] = useState<MachineStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bottom, setBottom] = useState(0);
  /** Where the card is drawn: the window root, so no rail ancestor clips it. */
  const [portal, setPortal] = useState<Element | null>(null);
  const open = hovered || pinned;

  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const show = useCallback(() => {
    cancelClose();
    const button = buttonRef.current;
    if (button) {
      setBottom(window.innerHeight - button.getBoundingClientRect().bottom);
      setPortal(button.closest(".agw-root"));
    }
    setHovered(true);
  }, []);
  const hideSoon = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setHovered(false), CLOSE_GRACE_MS);
  };

  useEffect(() => cancelClose, []);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const read = () => {
      void auroraInvoke<MachineStats>("machine_stats")
        .then((next) => {
          if (!alive) return;
          setStats(next);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          console.warn("[machine] machine_stats failed", err);
          setError(`Could not read the machine: ${String((err as Error)?.message ?? err)}`);
        });
    };
    read();
    const timer = window.setInterval(read, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPinned(false);
      setHovered(false);
      buttonRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // A browser on `aurora serve` only: the desktop window's own machine is the
  // one in front of the user.
  if (isDesktopRuntime() || !isAuroraRuntimeAvailable()) return null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="agw-iconrail-btn"
        data-active={open || undefined}
        aria-label="This machine"
        aria-haspopup="dialog"
        aria-expanded={open}
        onPointerEnter={show}
        onPointerLeave={hideSoon}
        onFocus={show}
        onBlur={() => {
          if (!pinned) hideSoon();
        }}
        onClick={() => {
          if (pinned) {
            setPinned(false);
            setHovered(false);
          } else {
            show();
            setPinned(true);
          }
        }}
      >
        <AgentIcon name="gauge" size={18} solid={open} />
      </button>
      {open &&
        portal &&
        createPortal(
          <div
            className="agw-menu agw-machine-card"
            role="dialog"
            aria-label="This machine"
            style={{ bottom }}
            onPointerEnter={cancelClose}
            onPointerLeave={() => {
              if (!pinned) hideSoon();
            }}
          >
            <MachineCard stats={stats} error={error} />
          </div>,
          portal,
        )}
    </>
  );
};
