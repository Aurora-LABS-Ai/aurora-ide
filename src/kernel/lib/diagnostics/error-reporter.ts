/**
 * Send web-layer failures to `aurora.log`.
 *
 * Aurora's log records the Rust half of a failure in full and, until this
 * module, none of the web half. A packaged build has no console: every
 * `console.error` in 197 places, every render crash, every rejected promise
 * went nowhere. So the log looked complete while missing the half of the app
 * the user actually touches.
 *
 * Scope, on purpose:
 *   • `console.error` — not `console.warn`. The file is an ERROR log; 113
 *     warn sites of routine chatter would bury the lines that matter and turn
 *     "the log has entries" from a signal into wallpaper.
 *   • `window.onerror` and unhandled rejections — the crashes nobody wrote a
 *     `console.error` for.
 *
 * Three ways this could make things worse, and what stops each:
 *   1. **A loop.** Reporting an error can fail, and reporting THAT failure can
 *      fail. `reporting` guards re-entry and the IPC swallows its own errors.
 *   2. **A flood.** A render loop emits thousands of identical errors a second
 *      and would fill a 5 MB file in seconds, rotating away the real cause.
 *      Identical messages collapse inside {@link DEDUPE_MS}, and the rate is
 *      capped at {@link MAX_PER_MINUTE}.
 *   3. **Silent capping.** Going quiet without saying so is the failure mode
 *      that makes a log lie, so crossing the cap writes one line explaining
 *      itself before the silence.
 */

import { reportToLog } from "@/kernel/services/diagnostics";

/** Identical messages inside this window are one event. */
export const DEDUPE_MS = 2000;

/** Ceiling per rolling minute, after which one notice is written and the rest drop. */
export const MAX_PER_MINUTE = 60;

/** IPC payload ceiling. Rust clamps entries at 8 KB; don't ship more than that. */
const MAX_MESSAGE_LEN = 8000;

// ── Formatting ──────────────────────────────────────────────────────────────

/**
 * One log message out of whatever was passed to `console.error`.
 *
 * Errors contribute their stack: the message alone ("Cannot read properties of
 * undefined") names a symptom that could come from anywhere, and a log entry
 * that cannot be traced back to a line is not worth the disk.
 */
export function formatLogArgs(args: readonly unknown[]): string {
  const parts = args.map((arg) => {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) {
      return arg.stack ? `${arg.name}: ${arg.message}\n${arg.stack}` : `${arg.name}: ${arg.message}`;
    }
    if (arg === null) return "null";
    if (arg === undefined) return "undefined";
    try {
      return JSON.stringify(arg);
    } catch {
      // Circular or otherwise unserializable — the type is still a clue.
      return Object.prototype.toString.call(arg);
    }
  });

  const text = parts.join(" ").trim();
  return text.length > MAX_MESSAGE_LEN
    ? `${text.slice(0, MAX_MESSAGE_LEN)} …[truncated, ${text.length} chars total]`
    : text;
}

// ── Rate gate ───────────────────────────────────────────────────────────────

export interface ReporterGate {
  /** message → when it was last let through. */
  lastSeen: Map<string, number>;
  windowStart: number;
  count: number;
  /** The cap has been announced for this window; stay quiet until it resets. */
  announced: boolean;
}

export const createGate = (now: number): ReporterGate => ({
  lastSeen: new Map(),
  windowStart: now,
  count: 0,
  announced: false,
});

export type GateVerdict = "send" | "drop" | "announce-throttle";

/**
 * Should this message reach the log?
 *
 * `announce-throttle` is returned exactly once per minute-window, when the cap
 * is first crossed — the caller writes a line saying reporting has been capped
 * and then drops the rest.
 */
export function admit(gate: ReporterGate, message: string, now: number): GateVerdict {
  if (now - gate.windowStart >= 60_000) {
    gate.windowStart = now;
    gate.count = 0;
    gate.announced = false;
    gate.lastSeen.clear();
  }

  const last = gate.lastSeen.get(message);
  if (last !== undefined && now - last < DEDUPE_MS) return "drop";

  if (gate.count >= MAX_PER_MINUTE) {
    if (gate.announced) return "drop";
    gate.announced = true;
    return "announce-throttle";
  }

  gate.lastSeen.set(message, now);
  gate.count += 1;
  return "send";
}

// ── Installation ────────────────────────────────────────────────────────────

let installed = false;

export function installErrorReporter(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const gate = createGate(Date.now());
  let reporting = false;

  const send = (component: string, message: string) => {
    if (!message || reporting) return;
    reporting = true;
    try {
      const verdict = admit(gate, message, Date.now());
      if (verdict === "announce-throttle") {
        void reportToLog(
          "warn",
          "reporter",
          `More than ${MAX_PER_MINUTE} errors in a minute — further reports dropped until the next minute. The app is failing in a loop; the entries above are the start of it.`,
        );
        return;
      }
      if (verdict === "drop") return;
      void reportToLog("error", component, message);
    } finally {
      reporting = false;
    }
  };

  const nativeError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    nativeError(...args);
    send("console", formatLogArgs(args));
  };

  window.addEventListener("error", (event) => {
    // A resource that failed to load fires here with no `error` object. It is
    // real, but it is not a crash, and the message would be a bare URL.
    if (!event.error && !event.message) return;
    const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : "";
    send("crash", `${formatLogArgs([event.error ?? event.message])}${where}`);
  });

  window.addEventListener("unhandledrejection", (event) => {
    // Something upstream already decided this rejection was expected — Tauri
    // stream cancellation on Stop, for one (see App.tsx). Listener order puts
    // that decision before this one, so honour it rather than duplicating the
    // list of what counts as noise.
    if (event.defaultPrevented) return;
    send("promise", formatLogArgs([event.reason]));
  });
}
