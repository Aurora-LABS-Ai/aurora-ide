/**
 * Agent Window — how the machine card words its numbers (pure).
 *
 * The card (`components/shell/MachineCell.tsx`) shows the machine the engine
 * runs on; these turn the engine's raw bytes and seconds into the short
 * strings it reads ("3.1 of 25.1 GB", "6 weeks") and pick a bar's tone.
 */

/** What `machine_stats` returns (`src-tauri/src/machine.rs`). */
export interface MachineStats {
  hostname: string;
  os: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  cpuPercent: number;
  memoryUsed: number;
  memoryTotal: number;
  disk: { mount: string; used: number; total: number } | null;
  gpus: { name: string; percent: number; memoryUsed: number; memoryTotal: number }[];
  uptimeSecs: number;
  processes: { name: string; cpuPercent: number; memory: number }[];
}

const GB = 1e9;
const MB = 1e6;

/** "3.1 of 25.1 GB"; whole numbers past 100 GB, where a decimal is noise. */
export function usedOf(used: number, total: number): string {
  const digits = total >= 100 * GB ? 0 : 1;
  return `${(used / GB).toFixed(digits)} of ${(total / GB).toFixed(digits)} GB`;
}

/** A process's memory: "664 MB", "1.2 GB". */
export function memorySize(bytes: number): string {
  return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / MB)} MB`;
}

/** "2%", never "2.37%": the card is read at a glance. */
export function percent(value: number): string {
  return `${Math.round(value)}%`;
}

/** The longest unit that fits: "6 weeks", "3 days", "5 hours", "12 min". */
export function uptime(secs: number): string {
  const units: [number, string][] = [
    [7 * 86400, "week"],
    [86400, "day"],
    [3600, "hour"],
  ];
  for (const [size, name] of units) {
    const n = Math.floor(secs / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? "" : "s"}`;
  }
  return `${Math.max(1, Math.floor(secs / 60))} min`;
}

/** A meter's tone: past 75% it is getting full, past 90% it is a problem. */
export type MeterTone = "ok" | "warn" | "bad";
export function meterTone(fraction: number): MeterTone {
  if (fraction > 0.9) return "bad";
  if (fraction > 0.75) return "warn";
  return "ok";
}

/** 0–1, safe for a zero total. */
export function fraction(used: number, total: number): number {
  return total > 0 ? Math.min(1, Math.max(0, used / total)) : 0;
}
