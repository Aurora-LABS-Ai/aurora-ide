/**
 * Agent Window — the clock the Agents tab and an agent's tab share [view helper].
 *
 * How long an agent has run, written the way the probe draws it (`2m 14s`), and
 * a once-a-second "now" so a running row ticks.
 */

import { useEffect, useState } from "react";

import { fmtDuration } from "@/apps/agent/lib/time/duration";
import type { SubagentSnapshot } from "@/apps/agent/services/subagents/commands";

/**
 * Milliseconds → `2m 14s` / `40s`. Under an hour it keeps the seconds, because a
 * running row ticks every second and `fmtDuration` ("2m") would sit still for a
 * minute at a time. An hour or more has nothing to tick, so it defers to it.
 */
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total >= 3600) return fmtDuration(total);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** The current time, re-read every second while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    // Catch up right away (the value may be stale from before `active`), then
    // tick. Both go through the callback so no state is set during the effect.
    const first = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [active]);
  return now;
}

/** How long the agent has run: live while running, the recorded total after. */
export function agentElapsedMs(
  agent: Pick<SubagentSnapshot, "status" | "startedAtMs" | "usage">,
  now: number,
): number {
  if (agent.status === "running") return Math.max(0, now - agent.startedAtMs);
  return agent.usage.durationMs;
}
