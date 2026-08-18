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

import { getProfessionalToolName } from "@/apps/agent/services/tools/tool-display";
import {
  completedToolStringArrayArgument,
  streamedToolStringArguments,
  type StreamedToolStringArgument,
} from "@/apps/agent/components/tools/tool-call";

export interface AgentActivityTarget {
  kind: "file" | "folder";
  name: string;
  path: string;
}

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
  targets?: AgentActivityTarget[];
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
  glob: "Finding",
  read_lints: "Checking diagnostics",
  shell_execute: "Running",
  shell_spawn: "Starting",
  shell_kill: "Stopping a process",
  shell_list_processes: "Listing processes",
  auroro_websearch: "Searching the web for",
  // "the plan" is a different thing in this product (a Plan-mode document in
  // the Canvas). This is the working checklist in the window header.
  todo: "Updating the checklist",
  plan_write: "Writing the plan",
  plan_read: "Reading the plan",
  plan_step_update: "Updating the plan",
  ask_question: "Waiting for your answer",
  present_artifact: "Presenting",
  browser_navigate: "Browsing to",
  browser_click: "Clicking",
  browser_fill: "Typing into",
  browser_scroll: "Scrolling",
  browser_screenshot: "Capturing",
  browser_get_console_logs: "Reading console logs",
  browser_page_outline: "Mapping page",
  browser_inspect_element: "Inspecting",
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
/** Tools that open a path for reading (so a spilled-output path can appear). */
const READ_TOOLS = new Set(["file_read", "multi_file_read", "editor_open_file"]);

/**
 * Does this call target a file the runtime spilled oversized tool output into?
 *
 * The runtime writes those to `<thread_id>.tool-results/out-<hash>[-field].txt`
 * (`session_store::tool_results_dir_in`) and hands the model the path so it can
 * page through the overflow with `file_read`. That path is Aurora's own
 * bookkeeping, not the user's project, so it must never surface as a filename.
 * Matched on the directory segment, which is the stable part of the contract.
 */
function spilledOutputPath(
  args: Record<string, unknown>,
  streamedPaths: string[],
): boolean {
  const candidates = [...pathListOf(args), ...streamedPaths];
  return candidates.some(
    (p) => !!p && p.replace(/\\/g, "/").includes(".tool-results/"),
  );
}

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

/**
 * Every path a call names, in order, de-duplicated.
 *
 * `file_read`'s `path` takes EITHER a string or an array — one slot, so a
 * strictly-decoding model cannot contradict itself (see `read_targets` in
 * `file_read.rs`). `paths` is still read because threads already on disk were
 * recorded under it, and a card has to render an old transcript as faithfully
 * as a new one.
 */
function pathListOf(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    const text = asStr(value);
    if (text && !out.includes(text)) out.push(text);
  };
  for (const key of ["path", "paths"] as const) {
    const value = args[key];
    if (Array.isArray(value)) value.forEach(add);
    else add(value);
  }
  return out;
}

/** The single path a path tool is acting on (full, unclipped), or null. */
function pathOf(args: Record<string, unknown>): string | null {
  return (
    asStr(args.path) ||
    asStr(args.file_path) ||
    asStr(args.filePath) ||
    asStr(args.target) ||
    asStr(args.source) ||
    asStr(args.old_path) ||
    asStr(args.new_path) ||
    null
  );
}

/** `.ext` present (and not a leading-dot-only name like ".env"). */
function looksLikeFile(base: string): boolean {
  const i = base.lastIndexOf(".");
  return i > 0 && i < base.length - 1;
}

function targetFor(name: string, path: string): AgentActivityTarget | null {
  const base = basename(path);
  if (!base || base === ".") return null; // workspace root — no icon
  if (FILE_ICON_TOOLS.has(name)) return { name: base, path, kind: "file" };
  if (FOLDER_ICON_TOOLS.has(name)) return { name: base, path, kind: "folder" };
  if (AMBIGUOUS_PATH_TOOLS.has(name))
    return { name: base, path, kind: looksLikeFile(base) ? "file" : "folder" };
  return null;
}

function editPaths(args: Record<string, unknown>): string[] {
  const topPath = asStr(args.path);
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (edits.length === 0) return topPath ? [topPath] : [];
  return edits.flatMap((edit) => {
    if (!edit || typeof edit !== "object") return [];
    const path = asStr((edit as Record<string, unknown>).path) || topPath;
    return path ? [path] : [];
  });
}

function targetsOf(
  name: string,
  args: Record<string, unknown>,
  streamedPaths: string[],
): AgentActivityTarget[] {
  let paths: string[];
  if (
    (name === "file_read" || name === "multi_file_read" || name === "read_lints") &&
    (Array.isArray(args.path) || Array.isArray(args.paths))
  ) {
    paths = pathListOf(args);
  } else if (
    name === "file_edit" ||
    name === "file_patch" ||
    name === "search_replace" ||
    name === "multi_search_replace"
  ) {
    const editTargets = editPaths(args);
    const announcedTargets = Array.isArray(args.target_paths)
      ? args.target_paths.filter((path): path is string => typeof path === "string")
      : [];
    paths =
      editTargets.length > 0
        ? [...editTargets, ...streamedPaths]
        : [...announcedTargets, ...streamedPaths];
  } else {
    const path = pathOf(args);
    paths = path ? [path] : streamedPaths;
  }

  const seen = new Set<string>();
  return paths.flatMap((path) => {
    if (seen.has(path)) return [];
    seen.add(path);
    const target = targetFor(name, path);
    return target ? [target] : [];
  });
}

/** The display arg for tools WITHOUT a named file/folder target (already clipped). */
function labelArg(name: string, args: Record<string, unknown>): string | null {
  // `glob` shares grep's shape here — the pattern IS the subject, so it reads
  // "Finding "**/*.tsx"" while the args are still streaming.
  if (name === "grep" || name === "glob") {
    const p = asStr(args.pattern);
    return p ? `"${clip(p, 32)}"` : null;
  }
  if (name === "auroro_websearch") {
    const q = asStr(args.query);
    const url = asStr(args.url);
    return q ? `"${clip(q, 40)}"` : url ? clip(url, 44) : null;
  }
  if (name === "shell_execute" || name === "shell_spawn") {
    const cmd = asStr(args.command);
    return cmd ? `\`${clip(cmd, 44)}\`` : null;
  }
  if (name === "shell_kill") {
    const id = asStr(args.processId) || asStr(args.requestId) || asStr(args.pid);
    return id ? `\`${clip(id, 32)}\`` : null;
  }
  if (name === "browser_navigate") {
    const url = asStr(args.url);
    return url ? clip(url, 44) : null;
  }
  if (name === "browser_click" || name === "browser_inspect_element") {
    const selector = asStr(args.selector);
    return selector ? `element "${clip(selector, 40)}"` : null;
  }
  if (name === "browser_fill" || name === "browser_screenshot") {
    const selector = asStr(args.selector);
    return selector ? `"${clip(selector, 40)}"` : null;
  }
  if (name === "browser_scroll") {
    const selector = asStr(args.selector);
    const direction = asStr(args.direction);
    return selector ? `to "${clip(selector, 36)}"` : direction;
  }
  if (name === "browser_get_console_logs") {
    const level = asStr(args.level);
    return level ? `(${level})` : null;
  }
  if (name === "present_artifact") {
    const title = asStr(args.title);
    return title ? `“${clip(title, 40)}”` : null;
  }
  return null;
}

const STREAMED_STRING_KEYS = [
  "path",
  "file_path",
  "filePath",
  "target",
  "source",
  "old_path",
  "new_path",
  "pattern",
  "query",
  "url",
  "command",
  "selector",
  "direction",
  "level",
  "action",
  "title",
  "processId",
  "requestId",
  "pid",
] as const;

const STREAMED_PATH_KEYS = new Set([
  "path",
  "file_path",
  "filePath",
  "target",
  "source",
  "old_path",
  "new_path",
]);

function partialPathIsReady(name: string, value: string): boolean {
  return (
    (FILE_ICON_TOOLS.has(name) || AMBIGUOUS_PATH_TOOLS.has(name)) &&
    looksLikeFile(basename(value))
  );
}

function firstUsableString(
  name: string,
  key: string,
  values: StreamedToolStringArgument[] | undefined,
): string | null {
  const complete = values?.find((value) => value.complete)?.value;
  if (complete) return complete;
  const partial = values?.[0]?.value;
  return partial && STREAMED_PATH_KEYS.has(key) && partialPathIsReady(name, partial)
    ? partial
    : null;
}

function activityArgs(
  name: string,
  argsJson: string,
): { args: Record<string, unknown>; streamedPaths: string[] } {
  const streamed = streamedToolStringArguments(argsJson, STREAMED_STRING_KEYS);
  const streamedPaths = (streamed.path ?? [])
    .filter((value) => value.complete || partialPathIsReady(name, value.value))
    .map((value) => value.value);

  try {
    const parsed: unknown = JSON.parse(argsJson || "{}");
    return {
      args:
        parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {},
      streamedPaths,
    };
  } catch {
    const args: Record<string, unknown> = {};
    for (const key of STREAMED_STRING_KEYS) {
      const value = firstUsableString(name, key, streamed[key]);
      if (value) args[key] = value;
    }
    const paths = completedToolStringArrayArgument(argsJson, "paths");
    if (paths.length > 0) args.paths = paths;
    // `path` may itself be the array form. Only when the string scanner found
    // nothing, so a plain single path is never overwritten by a stray match.
    const pathArray = completedToolStringArrayArgument(argsJson, "path");
    if (pathArray.length > 0 && typeof args.path !== "string") args.path = pathArray;
    const targetPaths = completedToolStringArrayArgument(argsJson, "target_paths");
    if (targetPaths.length > 0) args.target_paths = targetPaths;
    return { args, streamedPaths };
  }
}

/**
 * A narration frame for a streaming tool call. Never throws; returns a
 * verb-only label while arguments are still incomplete.
 */
export function describeToolActivity(name: string, argsJson: string): AgentActivity {
  const { args, streamedPaths } = activityArgs(name, argsJson);

  // workspace_tree names a folder (or the root) — handle it explicitly so the
  // narrator reads "Inspecting src" with a folder icon, not "Scanning …".
  if (name === "workspace_tree") {
    const target = targetsOf("folder_create", args, streamedPaths)[0];
    return target
      ? {
          label: `Inspecting ${target.name}`,
          verb: "Inspecting",
          ...target,
          targets: [target],
        }
      : { label: "Inspecting the workspace" };
  }

  // The agent naming the part of the work it is starting. The transcript is
  // where this lands (as a heading); the narrator frame exists because every
  // call gets one, and it should read as the announcement it is rather than as
  // a tool being run on something.
  if (name === "chapter") {
    const title = asStr(args.title);
    return { label: title ? `Starting: ${clip(title, 40)}` : "Starting the next part" };
  }

  const webUrl = asStr(args.url);
  if (name === "auroro_websearch" && webUrl && !asStr(args.query)) {
    return { label: `Fetching ${clip(webUrl, 44)}` };
  }

  if (name === "browser_screenshot" && !asStr(args.selector)) {
    return { label: "Capturing the page" };
  }

  if (name === "browser_scroll" && !asStr(args.selector) && !asStr(args.direction)) {
    return { label: "Scrolling the page" };
  }

  const verb = TOOL_GERUND[name];

  // Reading back oversized tool output that the runtime spilled to disk
  // (`<thread_id>.tool-results/out-<hash>.txt`). Showing that filename would
  // put an internal temp path in the transcript and read as if the agent were
  // opening a project file called `out-b6179211-content.txt` — it is neither a
  // real file the user has nor a name that means anything to them. Say what is
  // actually happening instead, with no file chip to click.
  if (READ_TOOLS.has(name) && spilledOutputPath(args, streamedPaths)) {
    return { label: "Reading tool output", verb: verb ?? "Reading" };
  }

  // Named file/folder target → the header shows its icon inline.
  const targets = targetsOf(name, args, streamedPaths);
  const target = targets[0];
  if (target) {
    const v = verb ?? getProfessionalToolName(name);
    const displayName =
      targets.length === 1 ? target.name : `${target.name} +${targets.length - 1}`;
    return {
      label: `${v} ${displayName}`,
      verb: v,
      ...target,
      name: displayName,
      targets,
    };
  }

  // Everything else (grep, shell, web, still-partial args) → text only.
  const arg = labelArg(name, args);
  if (verb) return { label: arg ? `${verb} ${arg}` : `${verb}…` };
  const display = getProfessionalToolName(name);
  return { label: arg ? `${display}: ${arg}` : `${display}…` };
}
