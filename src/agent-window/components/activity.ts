/**
 * Agent Window — live-activity narration (leaf, non-component).
 *
 * Turns a streaming tool call into a short present-tense frame for the header
 * narrator: a verb ("Editing"), an optional named target ("LeftRail.tsx" / a
 * folder) with the info the header needs to draw the SAME file/folder icon the
 * tool cards use, and a full fallback `label` for tools with no named target
 * ("Running pnpm test", "Searching …").
 *
 * Args stream incrementally, so `argsJson` may be partial/unparseable — every
 * path degrades to a verb-only label ("Editing…") rather than throwing.
 */

import { getProfessionalToolName } from "../../services/tool-display";

/** One narration frame. The header renders `verb [icon] name`, or just `label`. */
export interface AgentActivity {
  /** Full fallback line, e.g. "Reading db-client.ts", "Thinking…". */
  label: string;
  /** Leading verb when there's a named target, e.g. "Reading". */
  verb?: string;
  /** The target's display name (basename), e.g. "db-client.ts" / "src". */
  name?: string;
  /** Full path, for the path-aware file icon. */
  path?: string;
  /** Whether the target is a file or a folder — picks the icon. */
  kind?: "file" | "folder";
}

/** Present-continuous verb per tool. */
const TOOL_GERUND: Record<string, string> = {
  file_read: "Reading",
  multi_file_read: "Reading",
  file_write: "Writing",
  file_create: "Creating",
  file_edit: "Editing",
  search_replace: "Editing",
  multi_search_replace: "Editing",
  file_patch: "Editing",
  move_path: "Moving",
  delete_path: "Deleting",
  file_delete: "Deleting",
  editor_open_file: "Opening",
  folder_create: "Creating",
  folder_move: "Moving",
  folder_delete: "Deleting",
  grep: "Searching",
  read_lints: "Checking diagnostics",
  shell_execute: "Running",
  shell_spawn: "Starting",
  shell_kill: "Stopping a process",
  shell_list_processes: "Listing processes",
  auroro_websearch: "Searching the web for",
  todo_write: "Updating the plan",
  ask_question: "Waiting for your answer",
  browser_navigate: "Browsing to",
  browser_click: "Clicking",
  browser_fill: "Typing into a field",
  browser_scroll: "Scrolling the page",
  browser_screenshot: "Capturing the page",
};

/** Tools whose path arg names a FILE → file-extension icon. */
const FILE_ICON_TOOLS = new Set([
  "file_read",
  "file_write",
  "file_edit",
  "file_create",
  "file_patch",
  "search_replace",
  "multi_search_replace",
  "editor_open_file",
]);
/** Tools whose path arg names a FOLDER → folder icon. */
const FOLDER_ICON_TOOLS = new Set([
  "folder_create",
  "folder_move",
  "folder_delete",
]);
/** Path tools that could be either — decided by whether the basename has an ext. */
const AMBIGUOUS_PATH_TOOLS = new Set(["move_path", "delete_path"]);

function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const asStr = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/** The single path a path tool is acting on (full, unclipped), or null. */
function pathOf(args: Record<string, unknown>): string | null {
  return (
    asStr(args.path) ||
    asStr(args.file_path) ||
    asStr(args.filePath) ||
    asStr(args.target) ||
    asStr(args.source) ||
    null
  );
}

/** `.ext` present (and not a leading-dot-only name like ".env"). */
function looksLikeFile(base: string): boolean {
  const i = base.lastIndexOf(".");
  return i > 0 && i < base.length - 1;
}

/** A named file/folder target for the inline icon, or null (verb-only). */
function targetOf(
  name: string,
  args: Record<string, unknown>,
): { name: string; path: string; kind: "file" | "folder" } | null {
  const path = pathOf(args);
  if (!path) return null;
  const base = basename(path);
  if (!base || base === ".") return null; // workspace root — no icon
  if (FILE_ICON_TOOLS.has(name)) return { name: base, path, kind: "file" };
  if (FOLDER_ICON_TOOLS.has(name)) return { name: base, path, kind: "folder" };
  if (AMBIGUOUS_PATH_TOOLS.has(name))
    return { name: base, path, kind: looksLikeFile(base) ? "file" : "folder" };
  return null;
}

/** The display arg for tools WITHOUT a named file/folder target (already clipped). */
function labelArg(name: string, args: Record<string, unknown>): string | null {
  if (name === "grep") {
    const p = asStr(args.pattern);
    return p ? `"${clip(p, 32)}"` : null;
  }
  if (name === "auroro_websearch") {
    const q = asStr(args.query);
    return q ? `"${clip(q, 40)}"` : null;
  }
  if (name === "shell_execute" || name === "shell_spawn") {
    const cmd = asStr(args.command);
    return cmd ? `\`${clip(cmd, 44)}\`` : null;
  }
  if (name === "browser_navigate") {
    const url = asStr(args.url);
    return url ? clip(url, 44) : null;
  }
  if (name === "multi_file_read" && Array.isArray(args.paths)) {
    const n = args.paths.length;
    return n ? `${n} file${n === 1 ? "" : "s"}` : null;
  }
  return null;
}

/**
 * A narration frame for a streaming tool call. Never throws; returns a
 * verb-only label while arguments are still incomplete.
 */
export function describeToolActivity(name: string, argsJson: string): AgentActivity {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
  } catch {
    args = {}; // partial mid-stream JSON — verb only, no icon yet
  }

  // workspace_tree names a folder (or the root) — handle it explicitly so the
  // narrator reads "Inspecting src" with a folder icon, not "Scanning …".
  if (name === "workspace_tree") {
    const target = targetOf("folder_create", args); // reuse folder detection
    return target
      ? { label: `Inspecting ${target.name}`, verb: "Inspecting", ...target }
      : { label: "Inspecting the workspace" };
  }

  const verb = TOOL_GERUND[name];

  // Named file/folder target → the header shows its icon inline.
  const target = targetOf(name, args);
  if (target) {
    const v = verb ?? getProfessionalToolName(name);
    return { label: `${v} ${target.name}`, verb: v, ...target };
  }

  // Everything else (grep, shell, web, still-partial args) → text only.
  const arg = labelArg(name, args);
  if (verb) return { label: arg ? `${verb} ${arg}` : `${verb}…` };
  const display = getProfessionalToolName(name);
  return { label: arg ? `${display}: ${arg}` : `${display}…` };
}
