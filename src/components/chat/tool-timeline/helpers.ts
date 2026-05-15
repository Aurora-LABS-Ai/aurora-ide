import clsx from "clsx";
import { twMerge } from "tailwind-merge";
import type { ToolCall } from "../../../types";

/** Tailwind-aware className combiner used across every view. */
export function cn(...inputs: (string | undefined | null | false)[]): string {
  return twMerge(clsx(inputs));
}

/** Collapse whitespace and clip the tail so a noisy shell line fits a chip. */
export function summarizeShellCommand(command: string): string {
  const compact = command.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

/** Render an unknown approval-parameter value safely inside the modal. */
export function formatApprovalValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    return value.length > 120 ? `${value.slice(0, 120)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    return json.length > 120 ? `${json.slice(0, 120)}...` : json;
  } catch {
    return "[unserializable]";
  }
}

interface StatusLabelOptions {
  isAwaitingApproval?: boolean;
  isStale?: boolean;
  simpleMessage?: string | null;
}

/** Resolve the small status string under each tool card. */
export function getProfessionalStatusLabel(
  status: ToolCall["status"],
  options?: StatusLabelOptions,
): string {
  if (options?.isAwaitingApproval) return "Awaiting approval";
  if (options?.isStale) return "Execution interrupted";

  if (options?.simpleMessage) {
    return options.simpleMessage;
  }

  switch (status) {
    case "pending":
      return "Queued";
    case "executing":
      return "In progress";
    case "complete":
      return "Completed";
    case "failed":
      return "Failed";
    case "rejected":
      return "Not approved";
    default:
      return "Completed";
  }
}

/**
 * Best-effort unescape for content the agent returned as a JSON string
 * literal (e.g. `\n`, `\"`). Falls back to manual replacement so a
 * partially-escaped string still renders something readable.
 */
export function unescapeContent(str: string): string {
  if (!str) return str;
  try {
    if (!str.startsWith('"')) {
      return str
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    return JSON.parse(str);
  } catch {
    return str
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

/** Map a file extension to a Monaco language id for `openFile`. */
export const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  css: "css",
  scss: "scss",
  html: "html",
  md: "markdown",
  rs: "rust",
  py: "python",
  go: "go",
};
