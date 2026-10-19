/**
 * Agent Window — how an MCP server's state is named and coloured.
 *
 * A leaf (no JSX) so the settings cards and the Plugins page tiles read the
 * same words and the same dot tones from one place. Status reads as green /
 * amber / red / grey, never the accent.
 */

import type { McpServerStatus, McpTransportType } from "@/apps/agent/store/tools/useMcpStore";

/** Shown on a collapsed card. The two HTTP transports are named apart so a
 *  server's transport is legible without opening the editor. */
export const TRANSPORT_SUMMARY: Record<McpTransportType, string> = {
  stdio: "Local process",
  http: "Streamable HTTP",
  sse: "HTTP+SSE",
};

/** The `data-tone` of `.agw-mcp-card-dot` for a connection state. */
export function statusDotTone(status: McpServerStatus): string {
  switch (status) {
    case "connected":
      return "ready";
    case "connecting":
      return "busy";
    case "error":
      return "error";
    case "disconnected":
      return "off";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/** The marker Rust puts between its sentence and the server's own lines (`OutputTail::as_suffix`). */
const OUTPUT_MARKER = "\n\nThe server's last output:\n";

/**
 * Aurora's sentence and the server's own output, apart: the sentence is the
 * notice, the output goes in a bounded code box, so a long npm log scrolls
 * inside the card instead of pushing everything under it.
 */
export function splitError(error?: string | null): { message: string; output?: string } | null {
  const text = error?.trim();
  if (!text) return null;
  const at = text.indexOf(OUTPUT_MARKER);
  if (at < 0) return { message: text };
  return {
    message: text.slice(0, at).trim(),
    output: text.slice(at + OUTPUT_MARKER.length).trim(),
  };
}

export function statusLabel(status: McpServerStatus): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "error":
      return "Error";
    case "disconnected":
      return "Disconnected";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
