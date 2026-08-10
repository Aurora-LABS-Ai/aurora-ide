/**
 * Live shell output for a running tool call.
 *
 * Rust streams a command's stdout/stderr on `shell-stream-{requestId}` while it
 * runs, and `shell_execute` uses the **tool call id** as that request id — so
 * the card rendering the call is exactly the surface that receives its output.
 * Before this, a card stayed empty until the process exited, which made a
 * thirty-second build look indistinguishable from a hung one.
 *
 * Two details matter for the transcript staying smooth:
 *
 * - **Chunks are coalesced into one state update per animation frame.** Rust
 *   already batches at ~30 Hz, but a burst still lands as several events, and
 *   the transcript re-renders on every card update.
 * - **The buffer keeps a tail, not everything.** A command that prints tens of
 *   megabytes would otherwise grow an unbounded string in memory — and a very
 *   large `<pre>` is the known WebView2 renderer-crash surface.
 *
 * The live text is a *preview*: the settled tool result carries the complete,
 * authoritative output, so anything dropped here is never lost from the record.
 */

import { useEffect, useRef, useState } from "react";

import { auroraListen } from "@/kernel/lib/ipc/runtime";

/** Tail kept in memory while a command runs. */
const MAX_LIVE_CHARS = 256 * 1024;
/** Trimmed back to this when the cap is hit, so trimming is not per-chunk. */
const TRIM_TO_CHARS = 192 * 1024;

interface ShellStreamChunk {
  stream: "stdout" | "stderr";
  data: string;
  done: boolean;
  exitCode?: number | null;
  success?: boolean | null;
}

/**
 * Accumulated output for `callId`, or `""` before anything arrives.
 *
 * Pass `active: false` for tool calls that are not running shell commands; the
 * hook then registers no listener at all.
 */
export function useShellStream(callId: string, active: boolean): string {
  const [text, setText] = useState("");
  const bufferRef = useRef("");
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active || !callId) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;

    const flush = () => {
      frameRef.current = null;
      if (!disposed) setText(bufferRef.current);
    };

    void auroraListen<ShellStreamChunk>(`shell-stream-${callId}`, (event) => {
      const chunk = event?.payload;
      if (disposed || !chunk?.data) return;

      let next = bufferRef.current + chunk.data;
      if (next.length > MAX_LIVE_CHARS) next = next.slice(next.length - TRIM_TO_CHARS);
      bufferRef.current = next;

      if (frameRef.current === null) {
        frameRef.current = requestAnimationFrame(flush);
      }
    })
      .then((dispose) => {
        // The command can finish while the listener is still being registered;
        // dispose immediately in that case rather than leaking it.
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {
        // No live view is a degraded preview, not a failure — the settled
        // result still renders the complete output.
      });

    return () => {
      disposed = true;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      unlisten?.();
    };
  }, [callId, active]);

  return text;
}
