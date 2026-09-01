/**
 * Agent Window — tool-call card [view].
 *
 * One assistant tool invocation, modelled on the IDE chat's `ToolItem` but
 * deliberately LIGHTER — no boxed wrapper. It's an inline row:
 *
 *   ● Read File  src/foo.ts   Read 142 lines              ▸   ← dot · name · chip · summary
 *     └ (expand) rich result view (tree / grep / shell / diff / code)
 *
 * The result is routed through the isolated parser + `ToolResultView` so a
 * `workspace_tree` renders as a real tree, `multi_file_read` as a file list, etc.
 * — never a raw JSON dump. Everything uses `AgentIcon` (no lucide) and `--agw-*`
 * tokens (no `--aurora-*`); status is inferred (no discrete status field on the
 * persisted call): no result + streaming = running; no result + idle = failed; an
 * `[error]`/`[rejected]` sentinel = failed; anything else = done.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { CanvasCategoryMark } from "@/apps/agent/components/tools/CanvasCategoryMark";
import {
  artifactCategoryLabel,
  normalizeArtifactCategory,
} from "@/apps/agent/lib/artifacts/artifact-category";
import { getProfessionalToolName } from "@/apps/agent/services/tools/tool-display";
import { FileIcon, FolderIcon } from "@/kernel/ui/FileIcons";
import { AgentIcon, type AgentIconName } from "@/apps/agent/shared/AgentIcon";
import { useAgentArtifactStore } from "@/apps/agent/store/artifacts/useAgentArtifactStore";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
import {
  describeToolActivity,
  looksLikeFile,
  type AgentActivityTarget,
} from "@/apps/agent/components/conversation/activity";
import {
  formatToolDuration,
  streamedToolStringArguments,
  toolStatus,
  type ToolCall,
  type ToolStatus,
} from "@/apps/agent/components/tools/tool-call";
import { DoctrineRule } from "@/apps/agent/components/tools/DoctrineRule";
import { parseToolResult } from "@/apps/agent/components/tool-views/tool-result";
import { shellMeta } from "@/apps/agent/components/tool-views/shell-meta";
import { ShellBadge } from "@/apps/agent/components/tool-views/ShellBadge";
import { useSettingsStore } from "@/kernel/store/useSettingsStore";
import { ShellStreamView } from "@/apps/agent/components/tool-views/ShellStreamView";
import { ToolResultView } from "@/apps/agent/components/tool-views/ToolResultView";
import { useShellStream } from "@/apps/agent/hooks/useShellStream";
import { useConversationScope } from "@/apps/agent/lib/thread/conversation-scope";

/** A header chip: an activity target plus optional per-file diff counts. */
type ChipTarget = AgentActivityTarget & { added?: number; removed?: number };

/** Marks stacked inside the count chip before it stops adding them. */
const COUNT_CHIP_MARKS = 3;

/**
 * The title is the ACT; the chip beside it is the target.
 *
 * These tools always carry a target chip, so a noun in the title only repeats
 * what the chip says better — and worse, it has to be pluralised, which left
 * "Edit File" and "Edit Files" one letter apart as the only thing telling a
 * one-file call from a four-file one. That is not a difference you can see
 * while scanning a column; you have to stop and read for it.
 *
 * Card-only. `getProfessionalToolName` keeps the full noun everywhere the tool
 * is named WITHOUT a target beside it — Settings → Tools, activity lines —
 * where "Edit" alone would be a fragment.
 */
const ACT_TITLE: Record<string, string> = {
  file_read: "Read",
  multi_file_read: "Read",
  file_write: "Write",
  file_edit: "Edit",
  move_path: "Move",
  delete_path: "Delete",
  grep: "Search",
  glob: "Find",
  // Legacy names — historic threads render in the same voice.
  file_create: "Create",
  file_delete: "Delete",
  file_patch: "Edit",
  search_replace: "Edit",
  multi_search_replace: "Edit",
  folder_move: "Move",
  folder_delete: "Delete",
};

/**
 * The marks to stack inside the count chip: one per DISTINCT kind, in the order
 * they were touched, capped at three.
 *
 * Repeating a mark says nothing. Four edited `.tsx` files drew four identical
 * squares, which reads as a quantity — and it is the wrong quantity, because the
 * stack stops at three while the count beside it does not. Deduplicated, the
 * stack answers a different question from the number: the number is how many,
 * the marks are what kind. All-markdown shows one mark, and that is the honest
 * answer.
 *
 * The `kind` rides along because it is also the mark's REACT KEY. Keying by
 * path made the whole stack blink when the result landed: while the arguments
 * stream the targets are the paths the model typed, and the moment the result
 * arrives they are replaced by the result's own paths (`fullPath`, usually
 * absolute). Same files, same marks, different strings — so every key changed,
 * React unmounted and remounted each `<img>`, and four icons repainted for no
 * reason a reader could name. The kind is what the mark actually draws, and it
 * survives that swap untouched.
 */
interface StackMark {
  target: ChipTarget;
  /** Extension (`.tsx`), bare name (`dockerfile`), or `" folder"`. */
  kind: string;
}

function markKind(target: ChipTarget): string {
  const name = basename(target.path) || target.name;
  const dot = name.lastIndexOf(".");
  // Extension where there is one; otherwise the whole name, because
  // `Dockerfile` and `Makefile` get their own marks by name, not by suffix.
  return target.kind === "folder"
    ? " folder"
    : dot > 0
      ? name.slice(dot).toLowerCase()
      : name.toLowerCase();
}

function stackTargets(targets: ChipTarget[]): StackMark[] {
  const seen = new Set<string>();
  const marks: StackMark[] = [];
  for (const target of targets) {
    const kind = markKind(target);
    if (seen.has(kind)) continue;
    seen.add(kind);
    marks.push({ target, kind });
    if (marks.length >= COUNT_CHIP_MARKS) break;
  }
  return marks;
}

/* ── The target reel ────────────────────────────────────────────────────────
 * A call that names several files SAYS them, one at a time, and then keeps the
 * summary. It borrows the reply drum's motion whole (`.agw-suggest-drum`,
 * 09-tool-cards.css): each name arrives from below on a tilted curve, the one
 * before it leaves through the top, and the container's mask cuts both — no
 * fade in place, because a fade in place is what made the old row read as a
 * repaint rather than as an arrival.
 *
 * The last thing to ride through is the summary the row keeps, so the settle
 * is the same motion as every step before it. There is no moment where one
 * kind of chip is swapped for another.
 */

/**
 * How long one name holds the reel before the next rides in — the floor under
 * the paced reel, straight from the design's `PACE_MS`.
 *
 * This shipped at 850ms, which was the design page's **0.35× inspection
 * speed** read off the screen rather than its 1× number. The reel is a live
 * report on work in flight, and at that beat it was not live: five reads
 * finishing in under a second left the row still naming the second file while
 * the agent had moved on to the next tool. A report that lags the work it
 * reports on is worse than no report — the row is describing the past while
 * claiming to be current.
 */
const REEL_HOLD_MS = 300;

/**
 * The glide itself, in seconds.
 *
 * `0.18s`, because that is what `.agw-suggest-item` uses and this motion is
 * that drum's, borrowed whole. The 0.5s it shipped with was the same 0.35×
 * slowdown, and it quietly made the claim below — "the reply drum's,
 * unchanged" — untrue.
 */
const REEL_GLIDE_S = 0.18;

/**
 * Past this many files the row states the count instead of reading the list.
 *
 * At the beat above, thirty files is nine seconds of a settled row still
 * talking. The reel is a live report on work in flight; when the list is
 * longer than anyone would follow, the count is the more honest answer.
 */
const REEL_NAME_LIMIT = 8;

/** Travel, in px: one cell height, so a leaving cell clears the window exactly. */
const REEL_TRAVEL = 19;

/** Degrees of X-tilt, straight from `.agw-suggest-item`. */
const REEL_TILT = 48;

/** `ease`, as the drum's stylesheet spells it. */
const REEL_EASE = [0.25, 0.1, 0.25, 1] as const;

const ToolTargetReel: React.FC<{
  /** Every file the call names, in the order it named them. */
  targets: ChipTarget[];
  /** The call is over — once the names run out, the summary stays. */
  settled: boolean;
  /** What the row keeps: today's mark stack and count. */
  children: React.ReactNode;
}> = ({ targets, settled, children }) => {
  const reduceMotion = useAgentThemeStore((s) => s.reduceMotion);
  /**
   * Was this call still running when the card mounted?
   *
   * If it was not, there is nothing to narrate — a reloaded thread must not
   * replay every read in it — and the row renders its summary as PLAIN
   * CONTENT: no reel, no absolute cells, no measurement, no motion. A
   * historical card is then byte-for-byte the card it was before the reel
   * existed, which is the only way to be certain the reel cannot cost anyone
   * their transcript. It already did once: the reel's cells are absolutely
   * positioned so the reel owns its width, that width is set from a measured
   * ref, and on a settled card the measurement never ran — leaving every
   * multi-file row in the history an empty grey pill where its icons were.
   */
  const [narrates] = useState(() => !settled);
  const [index, setIndex] = useState(0);

  const readable = Math.min(targets.length, REEL_NAME_LIMIT);
  const drained = index >= readable;
  // While the call is still running, a drained reel HOLDS on its last name
  // rather than showing the summary early: a path arriving after that would
  // otherwise send the row summary → name → summary, which is the flicker
  // wearing a different coat.
  const showSummary = drained && settled;
  const active = targets[Math.min(index, readable - 1)];

  useEffect(() => {
    if (!narrates || drained) return;
    const timer = window.setTimeout(() => setIndex((current) => current + 1), REEL_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [narrates, drained, index]);

  const cellKey = showSummary || !active ? " summary" : `${index}:${active.path}`;

  /**
   * The cells are absolutely stacked, so the reel owns its own width — and
   * animating it is what stops `error.tsx` → `ToolCallCard.tsx` from snapping
   * the row ninety pixels wider between two frames. Measured on the cell's
   * mount (a ref callback fires exactly once per cell, and every cell has its
   * own key), never on the one that is leaving.
   *
   * Reached through `parentElement`, NOT through a ref on the reel: React
   * attaches refs CHILD FIRST, so a ref on the parent is still null while this
   * runs and the width was never written at all.
   */
  const measure = (node: HTMLSpanElement | null) => {
    const reel = node?.parentElement;
    if (!node || !reel) return;
    reel.style.width = `${node.offsetWidth}px`;
  };

  // Every hook above runs either way; only the rendering below differs.
  if (!narrates) return <>{children}</>;

  const glide = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, y: REEL_TRAVEL, rotateX: -REEL_TILT, scale: 0.94 },
        animate: { opacity: 1, y: 0, rotateX: 0, scale: 1 },
        exit: { opacity: 0, y: -REEL_TRAVEL, rotateX: REEL_TILT, scale: 0.94 },
      };

  return (
    <span className="agw-tool-reel">
      {/* `initial={false}`: the first cell is the chip appearing, and a settled
          card's first cell is its summary — neither should ride in. */}
      <AnimatePresence initial={false}>
        <motion.span
          key={cellKey}
          ref={measure}
          className="agw-tool-reel-cell"
          data-live={showSummary ? undefined : ""}
          {...glide}
          transition={{ duration: reduceMotion ? 0.12 : REEL_GLIDE_S, ease: REEL_EASE }}
        >
          {showSummary || !active ? (
            children
          ) : (
            <>
              {active.kind === "folder" ? (
                <FolderIcon name={active.name} className="agw-file-ico" />
              ) : (
                <FileIcon
                  name={basename(active.path) || active.name}
                  path={active.path}
                  className="agw-file-ico"
                />
              )}
              <span>{basename(active.path) || active.name}</span>
            </>
          )}
        </motion.span>
      </AnimatePresence>
    </span>
  );
};

/** "4 files" / "2 folders" / "5 items" — the noun follows what was touched. */
function countLabel(targets: ChipTarget[]): string {
  const folders = targets.filter((target) => target.kind === "folder").length;
  const noun =
    folders === targets.length ? "folders" : folders > 0 ? "items" : "files";
  return `${targets.length} ${noun}`;
}

const FILE_MODIFY_TOOLS = new Set([
  // Current.
  "file_write",
  "file_edit",
  // Legacy (historic threads).
  "file_create",
  "file_patch",
  "search_replace",
  "multi_search_replace",
]);

const FOLDER_TOOLS = new Set([
  "workspace_tree",
  "folder_create",
  "move_path",
  "delete_path",
  // Legacy.
  "folder_move",
  "folder_delete",
]);

/**
 * Tools taking TWO facts: a `path` that says WHERE to look and a `pattern` that
 * says WHAT to look for.
 *
 * Their `path` is a search root, usually a directory (`src`, `src/services`) —
 * so it is neither a file tool nor a folder tool, and the extension decides,
 * exactly as it does for `move_path`/`delete_path`. Before this it fell through
 * to "file" and a directory was drawn with the blank page glyph, which is both
 * the wrong picture and — sitting one word after "Search" — reads as the term
 * that was searched for rather than the folder it was searched in.
 */
const SCOPE_PATH_TOOLS = new Set(["grep", "glob"]);

/** Args we render specially / that are too noisy for the chip row. */
const HIDDEN_ARG_KEYS = new Set([
  "content",
  "path",
  "file_path",
  "filePath",
  "raw",
  "new_string",
  "newString",
  "old_string",
  "oldString",
  "newContent",
  "todos",
  "edits",
  "replacements",
  // Streaming UI metadata, not an instruction the reader gave. The file chips
  // already name these. Both spellings — threads on disk carry the old one.
  "affected_paths",
  "target_paths",
  // The file chips name these, one per file, with their own diff counts.
  // "paths: [2 items]" is the same fact counted instead of named.
  "paths",
]);

/**
 * The line range the caller ASKED for. Hidden once the result states the range
 * it actually RETURNED, which is the more useful of the two and can differ:
 * asking 255-275 of a 261-line file returns 255-261, and showing both invites
 * the reader to work out which one happened.
 */
const RANGE_ARG_KEYS = new Set(["start_line", "end_line", "max_lines"]);

const SHELL_ARG_KEYS = new Set([
  "command",
  "cwd",
  "timeout",
  "timeout_ms",
  "shell",
  "type",
]);

function isShellTool(name: string): boolean {
  return name === "shell_execute" || name === "shell_spawn";
}

/**
 * The `shell` argument while the call is still streaming — read with the
 * partial-JSON scanner because `JSON.parse` fails until the arguments close.
 * Only a COMPLETE value counts: a half-streamed `"pow` must not flash as an
 * unknown shell.
 */
function streamedShellArg(argsJson: string): string | null {
  const [first] = streamedToolStringArguments(argsJson || "", ["shell"]).shell ?? [];
  return first?.complete ? first.value : null;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * Pull a string field out of a PARTIAL (still-streaming) tool-arguments JSON
 * blob — `JSON.parse` can't, because the JSON isn't closed yet. Reads the value
 * of `"key": "..."` char by char, unescaping, until the closing quote OR the end
 * of the truncated buffer. This is what lets the card show a file being written
 * live, before the tool actually runs.
 */
function partialString(raw: string, key: string): string | null {
  const at = raw.indexOf(`"${key}"`);
  if (at < 0) return null;
  const colon = raw.indexOf(":", at + key.length + 2);
  if (colon < 0) return null;
  const open = raw.indexOf('"', colon + 1);
  if (open < 0) return null;
  let out = "";
  for (let i = open + 1; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\") {
      const n = raw[i + 1];
      out += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "" : (n ?? "");
      i++;
      continue;
    }
    if (c === '"') break;
    out += c;
  }
  return out;
}

/** The streaming-content arg key per modify tool (single-edit shapes only). */
function streamKeyFor(name: string): string | null {
  if (name === "file_create" || name === "file_write") return "content";
  if (name === "file_edit" || name === "search_replace" || name === "file_patch")
    return "new_string";
  return null;
}

/** Leading glyph per tool family (AgentIcon — never lucide). */
function toolIcon(name: string): AgentIconName {
  const lower = name.toLowerCase();
  if (lower.startsWith("mcp_")) return "mcp";
  if (lower === "browser_click") return "browser-click";
  if (lower === "browser_fill") return "browser-fill";
  if (lower === "browser_scroll") return "browser-scroll";
  if (lower === "browser_screenshot") return "browser-screenshot";
  if (lower === "browser_get_console_logs") return "terminal";
  // Acts on the browser rather than on the page. Without these, every one of
  // them fell to the generic globe below — eleven different acts, one mark.
  if (lower === "browser_navigate") return "browser-navigate";
  if (lower === "browser_press_key") return "browser-key";
  if (lower === "browser_set_viewport") return "browser-viewport";
  if (lower === "browser_page_outline" || lower === "browser_a11y_tree")
    return "browser-outline";
  // Reuses, not new marks: the app already owns a glyph for each of these acts,
  // and a second one for the same idea is how a set stops reading as a set.
  // Doctrine, not an act on a page — same mark as the design/canvas guidelines.
  if (lower === "browser_guidelines") return "design-guidelines";
  if (lower === "browser_inspect_element") return "inspect";
  if (lower === "browser_view") return "eye";
  if (lower === "browser_emulate_media") return "contrast";
  // `browser_hover` and `browser_status` keep the globe on purpose: neither has
  // an act distinct enough to earn a mark of its own.
  if (lower.startsWith("browser_")) return "browser";
  // Dedicated per-action file glyphs (read / write / edit / move / delete),
  // each distinct so a glance at the card header tells you what happened.
  if (lower === "file_read" || lower === "multi_file_read") return "file-read";
  if (lower === "file_write" || lower === "file_create") return "file-write";
  if (
    lower === "file_edit" ||
    lower === "file_patch" ||
    lower === "search_replace" ||
    lower === "multi_search_replace"
  )
    return "file-edit";
  if (lower === "move_path" || lower === "folder_move") return "file-move";
  if (lower === "delete_path" || lower === "file_delete" || lower === "folder_delete")
    return "file-delete";
  if (lower === "editor_open_file") return "files";
  if (lower === "grep") return "search";
  // `glob` finds files, so it takes the file icon rather than grep's
  // magnifier — the icon is the fastest way to tell the two searches apart.
  if (lower === "glob") return "files";
  if (lower === "workspace_tree") return "workspace-tree";
  if (lower === "code") return "code-index";
  if (lower === "folder_create") return "files";
  if (lower === "shell_execute" || lower === "shell_spawn") return "terminal";
  // The user's terminals get their own mark: `terminal` is the agent RUNNING a
  // command, these two are it LOOKING at a shell the user is driving. Same
  // family, different act — the window glyph reads as a pane being observed.
  if (lower === "terminal_list" || lower === "terminal_read") return "terminal-watch";
  if (lower === "shell_kill") return "process-stop";
  if (lower === "shell_list_processes") return "process-list";
  if (lower === "shell_read_output") return "shell-output";
  if (lower === "read_lints") return "diagnostics";
  // Reporting a fault in Aurora itself — the alert mark, not the diagnostics
  // one: `read_lints` inspects the user's code, this one is about the tool.
  if (lower === "report_aurora_issue") return "alert";
  // Both doctrine tools — they hand over the rules for building a surface, so
  // they share the guides mark rather than the generic file glyph.
  // (`browser_guidelines` is the third, matched earlier — it has to be caught
  // before the `browser_` prefix rule claims it.)
  if (lower === "design_guidelines" || lower === "canvas_guidelines")
    return "design-guidelines";
  if (lower === "todo") return "checklist";
  // The plan. `plan_write` and `plan_step_update` never reach here (they have
  // their own cards); reading it is the one that does, and it takes the task
  // family's mark rather than `checklist`, which belongs to the todo list.
  if (lower === "plan_read") return "task-list";
  // Skills. `book` is the skill mark app-wide (the `/` picker, the message
  // chip, Settings → Skills), so loading one shows the book and finding one
  // shows the book under a lens.
  if (lower === "aurora_skill_load") return "book";
  if (lower === "aurora_skill_search") return "skill-search";
  // Searching the deferred tool roster: the Tool-loading layer stack under a
  // lens, the same subject-under-magnifier pairing as skill-search. Without
  // this it fell through to the generic `diff` fallback and wore a file mark.
  if (lower === "tool_search") return "tool-search";
  // Artifacts live in the Canvas, and `panel-right` is what opens it everywhere
  // else in the window — the dock tab, the rail, the command centre.
  if (lower === "read_artifact" || lower === "present_artifact") return "panel-right";
  if (lower === "auroro_websearch" || lower === "auroro_web_search") return "search";
  if (lower === "ask_question") return "help";
  if (FILE_MODIFY_TOOLS.has(lower)) return "file-edit";
  return "diff";
}

function pathOf(args: Record<string, unknown>): string {
  // `path` may be the ARRAY form (one slot, string or array). A batch names its
  // files through the chip targets, so the single-name slot takes the first
  // entry rather than stringifying the whole array into the row.
  if (Array.isArray(args.path)) {
    const first = args.path.find((entry) => typeof entry === "string" && entry.trim());
    return typeof first === "string" ? first : "";
  }
  return (
    (args.path as string) ||
    (args.file_path as string) ||
    (args.filePath as string) ||
    (args.target as string) ||
    ""
  );
}

const DOT_ICON: Record<ToolStatus, AgentIconName | null> = {
  running: null,
  done: "check",
  failed: "close",
};

/**
 * The elapsed clock on a call that is still going.
 *
 * A spinner is identical at second 3 and second 300, so a command that prints
 * nothing until it finishes — `pnpm lint` is the one that started this — left
 * the reader with no way to tell work from a hang. The number is the whole
 * answer: seeing it climb past a minute is what tells you to go look.
 *
 * Held back for the first two seconds. Most tool calls finish inside that, and
 * a digit that appears and vanishes on every one of six batched reads is worse
 * than no digit at all.
 *
 * The clock is `now`, not the elapsed time: the interval only advances the
 * timestamp and the span is computed during render, which is the same shape
 * `AgentThinkingBlock` uses for the reasoning timer.
 */
const CLOCK_APPEARS_AFTER_MS = 2_000;

/**
 * Mirrors `DEFAULT_TIMEOUT_MS` in `src-tauri/.../shell_execute.rs`.
 *
 * Only ever used to describe the wait, never to enforce it — Rust kills the
 * process and this number just tells the reader when that happens. If the two
 * drift, a card says "of 2m" while the command runs to some other limit, which
 * is a wrong caption and not a wrong timeout.
 */
const DEFAULT_SHELL_TIMEOUT_MS = 120_000;

const RunningClock: React.FC<{ startedAt?: number }> = ({ startedAt }) => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === undefined) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  // No anchor means this row was rebuilt from history, where the start time
  // was never persisted. Nothing honest to show.
  if (startedAt === undefined) return null;
  const elapsed = Math.max(0, now - startedAt);
  if (elapsed < CLOCK_APPEARS_AFTER_MS) return null;

  return (
    <span className="agw-tool-time" aria-label={`Running for ${Math.round(elapsed / 1000)} seconds`}>
      {formatToolDuration(elapsed)}
    </span>
  );
};

/**
 * Bytes of tool-call JSON streamed so far, as a size the reader can watch move.
 * A spinner is identical at second 2 and second 80; "1.8 KB → 4.2 KB" is not.
 * It measures the ARGUMENT text, which is what the model is actually sending,
 * so it is honest about progress without pretending to know the final size.
 */
function formatStreamedBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * One short clause. A stack trace in a meta line helps nobody, and the parts
 * that carry no information for the reader — the thrown `Error:` wrapper and the
 * tool's own name, which the card already shows — are stripped.
 */
function clipReason(reason: string): string {
  const firstLine = reason.split("\n").find((line) => line.trim().length > 0) ?? reason;
  const cleaned = firstLine
    .replace(/^\s*Error:\s*/i, "")
    .replace(/^\s*present_artifact:\s*/i, "")
    .trim();
  return cleaned.length > 72 ? `${cleaned.slice(0, 71)}…` : cleaned;
}

const CanvasLaunchCard: React.FC<{
  call: ToolCall;
  isActivelyStreaming: boolean;
}> = ({ call, isActivelyStreaming }) => {
  const status = toolStatus(call, isActivelyStreaming);
  let args: Record<string, unknown> = {};
  let result: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }
  try {
    result = JSON.parse(call.result || "{}") as Record<string, unknown>;
  } catch {
    result = {};
  }

  // Both spellings, new first. The `artifact*` rename exists so the header
  // sorts ahead of `content`; threads already on disk carry the old names and
  // must keep rendering exactly the same.
  const readArg = (...keys: string[]): string => {
    for (const key of keys) {
      const settled = args[key];
      if (typeof settled === "string" && settled.length > 0) return settled;
      const streaming = partialString(call.arguments, key);
      if (streaming) return streaming;
    }
    return "";
  };

  const artifactId = readArg("artifactId");
  // NO placeholder noun. An unnamed card draws a shimmering skeleton instead —
  // "Canvas artifact" read as the title and was wrong for the whole write.
  const artifactTitle = readArg("artifactTitle", "title");
  const category = normalizeArtifactCategory(readArg("artifactCategory"));
  const versionTag = typeof result.versionTag === "string" ? result.versionTag : "";
  const canOpen = status === "done" && artifactId.length > 0;

  // The failure's reason belongs on the card. It cost an expand before, and a
  // compile error is one short clause.
  //
  // A thrown tool error arrives as the raw sentinel string `[error] …`, NOT as
  // JSON — `useAgentWindowSend` formats it that way and `toolStatus` keys off
  // the prefix. Reading `result.error` off the parsed object would have found
  // nothing on every real failure, because the parse never succeeds.
  const failureReason =
    status === "failed"
      ? (call.result || "").trimStart().startsWith("[error]")
        ? (call.result || "").trimStart().slice("[error]".length)
        : (typeof result.error === "string" && result.error) ||
          (typeof result.message === "string" && result.message) ||
          ""
      : "";
  const isRevision = Boolean(
    (typeof args.baseVersionTag === "string" && args.baseVersionTag) ||
      (Array.isArray(args.patches) && args.patches.length > 0),
  );
  const streamedBytes =
    status === "running" ? (call.arguments || "").length : 0;

  const metaParts: string[] = [];
  if (status === "failed") {
    metaParts.push("Couldn’t save");
    if (failureReason) metaParts.push(clipReason(failureReason));
  } else if (status === "running") {
    metaParts.push(artifactTitle ? artifactCategoryLabel(category) : "Writing a canvas");
  } else {
    metaParts.push(artifactCategoryLabel(category));
    if (isRevision) metaParts.push("revised");
    if (versionTag) metaParts.push(versionTag);
  }
  // Artifacts are stored per conversation, so this has to open the artifact of
  // the chat the card is IN — which is not the open chat when the card is being
  // rendered by a conversation docked in the side panel.
  const scope = useConversationScope();

  const openCanvas = () => {
    if (!canOpen) return;
    const threadId =
      scope?.threadId ?? useAgentChatStore.getState().currentThreadId;
    if (!threadId) return;
    useAgentWorkspaceStore.getState().openTab("canvas");
    // Claim the canvas for artifacts up front — `select` also does this on
    // success, but an old card with no version tag (or a failed select) must
    // still land the user on the artifact view they asked for, not on a plan
    // covering it.
    useAgentArtifactStore.getState().setCanvasSource("artifact");
    if (versionTag) {
      void useAgentArtifactStore
        .getState()
        .select(threadId, artifactId, versionTag)
        .catch(() => undefined);
    }
  };

  return (
    <button
      type="button"
      className="agw-canvas-launch"
      data-status={status}
      disabled={!canOpen}
      aria-label={
        canOpen
          ? `Open ${artifactTitle || "canvas"}${versionTag ? ` ${versionTag}` : ""} in Canvas`
          : status === "running"
            ? `Writing ${artifactCategoryLabel(category).toLowerCase()} canvas${artifactTitle ? `, ${artifactTitle}` : ""}`
            : undefined
      }
      onClick={openCanvas}
    >
      <span className="agw-canvas-launch-lead">
        <CanvasCategoryMark
          category={category}
          size={34}
          animate={status === "running"}
        />
      </span>
      <span className="agw-canvas-launch-copy">
        {artifactTitle ? (
          <span
            className={`agw-canvas-launch-title${status === "running" ? " agw-shimmer" : ""}`}
          >
            {artifactTitle}
          </span>
        ) : (
          <span className="agw-canvas-launch-skel" aria-label="Naming the canvas" />
        )}
        <span className="agw-canvas-launch-meta">
          {metaParts.map((part, index) => (
            <React.Fragment key={`${part}-${index}`}>
              {index > 0 && <s aria-hidden>·</s>}
              <i className={part === versionTag ? "agw-canvas-launch-num" : undefined}>
                {part}
              </i>
            </React.Fragment>
          ))}
          {streamedBytes > 0 && (
            <>
              <s aria-hidden>·</s>
              <i className="agw-canvas-launch-num">{formatStreamedBytes(streamedBytes)}</i>
            </>
          )}
        </span>
      </span>
      {status === "failed" && (
        <span className="agw-canvas-launch-x">
          <AgentIcon name="close" size={13} strokeWidth={2.4} />
        </span>
      )}
      {status === "running" && (
        <span className="agw-canvas-launch-rail" aria-hidden>
          <i />
        </span>
      )}
      {canOpen && (
        <span className="agw-canvas-launch-open">
          <span>Open</span>
          <AgentIcon name="external" size={13} />
        </span>
      )}
    </button>
  );
};

const StandardToolCallCard: React.FC<{
  call: ToolCall;
  isActivelyStreaming?: boolean;
}> = ({ call, isActivelyStreaming = false }) => {
  // Derived open state (no setState-in-effect): failed tools default OPEN so the
  // reason is visible; a user toggle overrides that default for this card.
  const [override, setOverride] = useState<boolean | null>(null);
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const targetStripRef = useRef<HTMLDivElement>(null);

  const parsedArgs = useMemo<Record<string, unknown>>(() => {
    try {
      const v = JSON.parse(call.arguments || "{}");
      return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }, [call.arguments]);

  const status = toolStatus(call, isActivelyStreaming);
  const defaultTitle = getProfessionalToolName(call.name);
  const icon = toolIcon(call.name);
  const activity = useMemo(
    () => describeToolActivity(call.name, call.arguments),
    [call.name, call.arguments],
  );
  const parsed = useMemo(
    () => parseToolResult(call.name, parsedArgs, call.result),
    [call.name, parsedArgs, call.result],
  );

  const path = activity.path || pathOf(parsedArgs);
  const fileName = activity.name || (path ? basename(path) : "");
  const isFolder =
    activity.kind === "folder" ||
    (!activity.kind &&
      (FOLDER_TOOLS.has(call.name) ||
        (SCOPE_PATH_TOOLS.has(call.name) && !!path && !looksLikeFile(basename(path)))));
  const narratedTargets: AgentActivityTarget[] =
    activity.targets?.length
      ? activity.targets
      : path || isFolder
        ? [
            {
              kind: isFolder ? "folder" : "file",
              name: fileName || "directory",
              path,
            },
          ]
        : [];
  const resultFileTargets: ChipTarget[] = parsed.multiFile?.length
    ? parsed.multiFile.map((file) => ({
        kind: "file" as const,
        name: basename(file.path),
        path: file.fullPath ?? file.path,
      }))
    : parsed.diffs?.length
      ? parsed.diffs.map((diff, index) => {
          const diffPath = diff.fullPath ?? diff.path ?? `file ${index + 1}`;
          return {
            kind: "file" as const,
            name: basename(diffPath),
            path: diffPath,
            added: diff.added,
            removed: diff.removed,
          };
        })
      : [];
  const activityTargets: ChipTarget[] =
    resultFileTargets.length > 0 ? resultFileTargets : narratedTargets;
  // ONE target keeps its name on the row; more than one collapses to a count.
  // The rule is the tool-agnostic part: a 3-file read compacts exactly like a
  // 4-file edit, so the row's shape stops depending on which tool ran.
  const isMultiTarget = activityTargets.length > 1;
  // The call NAMES its paths as a list, whether one has arrived or four have.
  // A settled call re-read from disk answers this the same way a live one
  // does, because it is a fact about the argument and not about the clock.
  const listTargets = activity.targetsAreList === true && activityTargets.length > 0;
  const title = ACT_TITLE[call.name] ?? defaultTitle;
  const isSelectableMultiFileResult = resultFileTargets.length > 1;
  const selectedFileIndex = isSelectableMultiFileResult
    ? Math.min(activeFileIndex, activityTargets.length - 1)
    : 0;
  const singleChip: ChipTarget | null = isMultiTarget
    ? null
    : (activityTargets[0] ?? null) && {
        ...activityTargets[0],
        name: activity.name || activityTargets[0].name,
      };
  // What a search LOOKED FOR, beside where it looked.
  //
  // The scope chip alone left two different searches of the same folder drawing
  // the identical row — "Search  src  3 matches · 1 file" twice over, from two
  // calls that shared nothing but their directory. The result view has always
  // shown the pattern in its own header; the collapsed row, which is what most
  // of a transcript IS, never did.
  const searchPattern = SCOPE_PATH_TOOLS.has(call.name)
    ? typeof parsedArgs.pattern === "string"
      ? parsedArgs.pattern.trim()
      : ""
    : "";

  // Live content preview: the file being written, pulled from the partial args.
  const streamingPreview = useMemo(() => {
    if (status !== "running") return null;
    const key = streamKeyFor(call.name);
    if (!key) return null;
    const text = partialString(call.arguments, key);
    return text && text.length > 0 ? text : null;
  }, [status, call.name, call.arguments]);
  // Lines streamed so far. This is the running summary for modify tools —
  // needed most when the model emits `content` BEFORE `path` (it often does),
  // which leaves the card with no file chip until the write finishes. A bare
  // "Writing…" for 30 seconds reads as stalled; "Writing… 214 lines" reads as
  // work happening.
  const streamingLineCount = useMemo(() => {
    if (!streamingPreview) return 0;
    let lines = 1;
    for (let i = 0; i < streamingPreview.length; i++) {
      if (streamingPreview[i] === "\n") lines++;
    }
    return lines;
  }, [streamingPreview]);

  const previewRef = React.useRef<HTMLPreElement>(null);
  React.useEffect(() => {
    // Follow the newest written lines as they stream in.
    if (previewRef.current) previewRef.current.scrollTop = previewRef.current.scrollHeight;
  }, [streamingPreview]);

  // Live terminal output, streamed from Rust on the tool call's own channel.
  // Subscribing from the card (which mounts when the call appears, before
  // execution begins) means the listener is in place before the first byte.
  const liveShellOutput = useShellStream(call.id, isShellTool(call.name) && status === "running");
  const liveShellCommand =
    typeof parsedArgs.command === "string" ? parsedArgs.command : undefined;
  const liveShellCwd = typeof parsedArgs.cwd === "string" ? parsedArgs.cwd : undefined;
  // What the command will be killed at. Rust reads `timeout` then `timeout_ms`
  // and defaults to two minutes (`shell_execute.rs`); mirrored here so the
  // waiting state can say when the waiting ends instead of only that it is
  // happening. Both spellings, because the model sends both.
  const liveShellTimeoutMs =
    typeof parsedArgs.timeout === "number"
      ? parsedArgs.timeout
      : typeof parsedArgs.timeout_ms === "number"
        ? parsedArgs.timeout_ms
        : DEFAULT_SHELL_TIMEOUT_MS;
  const showLiveShell = isShellTool(call.name) && status === "running";
  // Which shell the command runs in. The result's resolved id wins (a
  // substitution shows what ACTUALLY ran); the requested arg covers the
  // running state, streamed scanner first because the args JSON is still open.
  const shell = isShellTool(call.name)
    ? shellMeta(
        parsed.shell?.shell ??
          (typeof parsedArgs.shell === "string" ? parsedArgs.shell : null) ??
          streamedShellArg(call.arguments),
      )
    : null;
  // The badge's mark comes from the explorer icon pack, so the transcript and
  // the Files panel never show two different pictures of the same thing.
  const explorerIconPack = useSettingsStore((s) => s.explorerIconPack);

  // Every file view already carrying its own range makes the requested range a
  // second, weaker copy of the same fact.
  const resultStatesRange = parsed.multiFile?.some((file) => file.window) ?? false;
  const argChips = useMemo(
    () =>
      Object.entries(parsedArgs).filter(
        ([k]) =>
          !HIDDEN_ARG_KEYS.has(k) &&
          !(resultStatesRange && RANGE_ARG_KEYS.has(k)) &&
          !(isShellTool(call.name) && SHELL_ARG_KEYS.has(k)) &&
          // The pattern now rides on the row AND heads the result view. A third
          // copy as `pattern: …` in the arg list is the same string stated
          // three times inside one card.
          !(k === "pattern" && searchPattern !== ""),
      ),
    [parsedArgs, call.name, resultStatesRange, searchPattern],
  );

  const summary = useMemo(() => {
    if (status === "running") return ""; // the shimmer line speaks for a live call
    // A failure's own sentence is usually a paragraph — "Replacement 3: Could
    // not find the specified text in the original file snapshot." — and this
    // slot is one line beside a filename. It arrived clipped mid-word behind an
    // ellipsis, which is the shape of an error message without being one: too
    // long to sit on the row, too short to act on.
    //
    // So the row states the OUTCOME, in the same slot every other tool uses for
    // its outcome ("Read 142 lines", "+18 −4"), and the dropdown states the
    // reason in full — where there is room for the recovery step these messages
    // almost always end with, and which is the part actually worth reading.
    if (status === "failed") return "Failed";
    return parsed.summary || "";
  }, [status, parsed.summary]);

  const hasResult = Boolean(
    parsed.tree ||
      parsed.multiFile?.length ||
      parsed.grep?.matches.length ||
      // Not `.files.length`: a glob that matched nothing still has a result
      // worth expanding — it says so, and says how to widen the pattern.
      parsed.glob ||
      (parsed.shell && parsed.shell.output) ||
      parsed.fileList?.length ||
      parsed.diff ||
      parsed.diffs?.length ||
      parsed.edit?.removed ||
      parsed.edit?.added ||
      parsed.code ||
      parsed.image?.path ||
      parsed.image?.base64,
  );
  // `isMultiTarget` counts: the file list now lives in the body, so a call that
  // touched several things always has something to open even when its result
  // parsed to nothing.
  const hasDetail =
    hasResult || isMultiTarget || argChips.length > 0 || !!streamingPreview || showLiveShell;
  // Collapsed by DEFAULT in every state — running, done, and failed alike. A
  // tool card is a quiet one-line row until the reader asks for more; they click
  // it open to inspect args, the live write stream, or the result.
  //
  // A live failure used to default open. It read as helpful and behaved as the
  // opposite: the card expanded mid-turn, shoved everything after it down the
  // screen, and then STAYED expanded for the rest of the turn while the agent
  // recovered and moved on — one card permanently louder than the work that
  // followed it. Nothing else in the transcript opens itself, and a failure the
  // agent has already worked around is not an exception worth making. The ✗ and
  // the "Failed" label carry the state on the row; the reason is one click away,
  // like every other result. `override` wins.
  const defaultOpen = false;
  const open = (override ?? defaultOpen) && hasDetail;
  const toggle = () => setOverride(!(override ?? defaultOpen));
  // The file list is in the body now, which lays out as a wrapping strip — so
  // there is no drag-scroll, no wheel-to-pan, and no "+N" overflow menu to
  // maintain. All three existed to make an unbounded horizontal strip usable
  // inside a fixed-width row; nothing lives in that row any more.
  const selectFileTarget = (event: React.SyntheticEvent, index: number) => {
    event.stopPropagation();
    setActiveFileIndex(index);
  };
  // WebView2 150.x renderer CHECK (STATUS_BREAKPOINT sad page): a mouse-up
  // while a text selection exists during style/layout churn kills the page —
  // and clicking this header causes exactly that churn (expand animation +
  // highlighter mount). Disarm both halves before the click lands: swallow
  // double/triple-click word selection on the header, and collapse any live
  // transcript selection before layout starts moving.
  const disarmSelectionBeforeClick = (event: React.MouseEvent) => {
    if (event.detail > 1) event.preventDefault();
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) selection.removeAllRanges();
  };

  return (
    // `data-status` on the card itself (not only on the inner dot) so the
    // transcript spine can mark the call that is running right now without
    // reaching into this card's internals.
    <div className="agw-tool-card" data-status={status}>
      <button
        type="button"
        className="agw-tool-head"
        aria-expanded={open}
        onMouseDown={disarmSelectionBeforeClick}
        onClick={() => hasDetail && toggle()}
      >
        {/* While the call is running the status column is EMPTY on purpose: the
            mark beside it is the live sign now (33-tool-glyph-motion.css), and
            a spinner 8px from an animated glyph is two things saying one thing.
            The box keeps its 16px, so nothing shifts when the ✓ lands. */}
        <span className={`agw-tool-dot agw-tool-dot-${status}`}>
          {DOT_ICON[status] && <AgentIcon name={DOT_ICON[status]!} size={13} strokeWidth={2.6} />}
        </span>

        {/* Two copies while live: the mark itself, and a full-strength copy the
            scan is masked over. Only mounted for the running state, so a settled
            transcript carries no extra nodes. */}
        <span className="agw-tool-glyph" data-live={status === "running" ? "" : undefined}>
          <AgentIcon name={icon} size={16} strokeWidth={1.5} />
          {status === "running" && (
            <AgentIcon
              name={icon}
              size={16}
              strokeWidth={1.5}
              className="agw-tool-glyph-scan"
            />
          )}
        </span>

        <span
          style={{
            color: status === "failed" ? "var(--agw-text-muted)" : "var(--agw-text)",
            fontWeight: "var(--agw-fw-medium)",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </span>

        {shell && (
          <ShellBadge
            shell={shell}
            packId={explorerIconPack}
            note={parsed.shell?.shellNote}
          />
        )}

        {/* One target: its name, which is the most useful thing on the row.
            Several: one chip carrying the count, wearing the same shape as the
            strip it replaces so the row still reads as files and not only as a
            number. The names are in the dropdown.

            A call whose paths arrived as a LIST takes this chip from its very
            first path — `listTargets`, not `isMultiTarget`. The count is the
            shape a list ends in, so committing to it up front is what removes
            the mid-stream swap: the row used to draw a filename at one path and
            throw it away for a count seventy milliseconds later, losing about
            ninety pixels of width in a single frame. Nothing is lost by
            committing early, because the reel inside says every name anyway. */}
        {listTargets || isMultiTarget ? (
          <span
            className="agw-tool-chip agw-tool-chip-count"
            title={activityTargets.map((target) => target.path).join("\n")}
          >
            <ToolTargetReel targets={activityTargets} settled={status !== "running"}>
              <span className="agw-chip-stack" aria-hidden>
                {stackTargets(activityTargets).map(({ target, kind }) =>
                  target.kind === "folder" ? (
                    <FolderIcon key={kind} name={target.name} className="agw-file-ico" />
                  ) : (
                    <FileIcon
                      key={kind}
                      name={basename(target.path) || target.name}
                      path={target.path}
                      className="agw-file-ico"
                    />
                  ),
                )}
              </span>
              {/* A one-path list keeps saying that path's NAME. "1 file" is a
                  worse answer to the same question, and the reel has just
                  spent its whole run establishing the name. */}
              {activityTargets.length === 1 && activityTargets[0]
                ? basename(activityTargets[0].path) || activityTargets[0].name
                : countLabel(activityTargets)}
            </ToolTargetReel>
          </span>
        ) : (
          (singleChip || searchPattern) && (
            <span className="agw-tool-targets">
              {singleChip && (
                <span className="agw-tool-chip">
                  {singleChip.kind === "folder" ? (
                    <FolderIcon name={singleChip.name} className="agw-file-ico" />
                  ) : (
                    <FileIcon
                      name={basename(singleChip.path) || singleChip.name}
                      path={singleChip.path}
                      className="agw-file-ico"
                    />
                  )}
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {singleChip.name}
                  </span>
                  {(singleChip.added || singleChip.removed) && (
                    <span className="agw-chip-stat">
                      {singleChip.removed ? (
                        <span className="agw-chip-stat-del">−{singleChip.removed}</span>
                      ) : null}
                      {singleChip.added ? (
                        <span className="agw-chip-stat-add">+{singleChip.added}</span>
                      ) : null}
                    </span>
                  )}
                </span>
              )}
              {searchPattern && (
                <span
                  className="agw-tool-chip agw-tool-chip-pattern"
                  title={searchPattern}
                >
                  {searchPattern}
                </span>
              )}
            </span>
          )
        )}

        {status === "running" ? (
          <span className="agw-tool-summary agw-shimmer">
            {streamingLineCount > 0
              ? `${activity.verb ?? "Writing"}… ${streamingLineCount} ${
                  streamingLineCount === 1 ? "line" : "lines"
                }`
              : activity.name
                ? "Running…"
                : activity.label}
          </span>
        ) : status === "failed" ? (
          summary && (
            <span className="agw-tool-summary" style={{ color: "var(--agw-text-muted)" }}>
              {summary}
            </span>
          )
        ) : parsed.stat && (parsed.stat.added > 0 || parsed.stat.removed > 0) ? (
          <span className="agw-tool-summary" style={{ display: "inline-flex", gap: 8 }}>
            {parsed.stat.removed > 0 && (
              <span style={{ color: "var(--agw-removed)" }}>−{parsed.stat.removed}</span>
            )}
            {parsed.stat.added > 0 && (
              <span style={{ color: "var(--agw-added)" }}>+{parsed.stat.added}</span>
            )}
          </span>
        ) : (
          summary && (
            <span
              className="agw-tool-summary"
              style={{ color: "var(--agw-text-subtle)" }}
            >
              {summary}
            </span>
          )
        )}

        {/* Quiet elapsed time — only once settled, and only when it's long
            enough to mean something (sub-500ms would just be row noise). */}
        {status !== "running" &&
          typeof call.durationMs === "number" &&
          call.durationMs >= 500 && (
            <span className="agw-tool-time">{formatToolDuration(call.durationMs)}</span>
          )}

        {/* The same clock while it runs. Same slot, same face, so a row does
            not reflow when the number stops moving. */}
        {status === "running" && <RunningClock startedAt={call.startedAt} />}

        <span style={{ flex: 1 }} />

        {hasDetail && (
          <span
            style={{
              color: "var(--agw-text-subtle)",
              display: "inline-flex",
              transform: open ? "rotate(180deg)" : "none",
              transition: "transform 0.15s ease",
            }}
          >
            <AgentIcon name="chevron-down" size={14} />
          </span>
        )}
      </button>

      <AnimatePresence initial={false}>
        {open && hasDetail && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            style={{ overflow: "hidden" }}
          >
            <div className="agw-tool-body">
              {/* The file list, in the one place it now lives. It WRAPS rather
                  than scrolling — the whole set is visible at once instead of
                  hidden behind a drag. Selecting one still drives which file's
                  content shows below, exactly as it did from the header. */}
              {isMultiTarget && (
                <div
                  ref={targetStripRef}
                  className="agw-tool-files"
                  role={isSelectableMultiFileResult ? "tablist" : undefined}
                  aria-label={isSelectableMultiFileResult ? "Files in this tool result" : undefined}
                >
                  {activityTargets.map((target, index) => {
                    const chipContent = (
                      <>
                        {target.kind === "folder" ? (
                          <FolderIcon name={target.name} className="agw-file-ico" />
                        ) : (
                          <FileIcon
                            name={basename(target.path) || target.name}
                            path={target.path}
                            className="agw-file-ico"
                          />
                        )}
                        <span
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {target.name}
                        </span>
                        {(target.added || target.removed) && (
                          <span className="agw-chip-stat">
                            {target.removed ? (
                              <span className="agw-chip-stat-del">−{target.removed}</span>
                            ) : null}
                            {target.added ? (
                              <span className="agw-chip-stat-add">+{target.added}</span>
                            ) : null}
                          </span>
                        )}
                      </>
                    );

                    return isSelectableMultiFileResult ? (
                      <button
                        key={`${target.path}:${index}`}
                        type="button"
                        role="tab"
                        tabIndex={selectedFileIndex === index ? 0 : -1}
                        aria-selected={selectedFileIndex === index}
                        className="agw-tool-chip agw-tool-chip-btn"
                        title={target.path}
                        data-index={index}
                        data-selected={selectedFileIndex === index ? "true" : undefined}
                        onClick={(event) => selectFileTarget(event, index)}
                        onKeyDown={(event) => {
                          const last = activityTargets.length - 1;
                          const next =
                            event.key === "ArrowRight"
                              ? Math.min(index + 1, last)
                              : event.key === "ArrowLeft"
                                ? Math.max(index - 1, 0)
                                : event.key === "Home"
                                  ? 0
                                  : event.key === "End"
                                    ? last
                                    : null;
                          if (next === null) return;
                          event.preventDefault();
                          selectFileTarget(event, next);
                          requestAnimationFrame(() => {
                            targetStripRef.current
                              ?.querySelector<HTMLElement>(`[role="tab"][data-index="${next}"]`)
                              ?.focus();
                          });
                        }}
                      >
                        {chipContent}
                      </button>
                    ) : (
                      <span key={`${target.path}:${index}`} className="agw-tool-chip">
                        {chipContent}
                      </span>
                    );
                  })}
                </div>
              )}

              {argChips.length > 0 && (
                <div className="agw-tool-args">
                  {argChips.map(([k, v]) => {
                    let val: string;
                    if (v === null || v === undefined) val = "null";
                    else if (typeof v === "object")
                      val = Array.isArray(v) ? `[${v.length} items]` : "{…}";
                    else val = String(v).slice(0, 40);
                    return (
                      <span key={k} className="agw-tool-arg">
                        <span style={{ opacity: 0.6 }}>{k}:</span> {val}
                      </span>
                    );
                  })}
                </div>
              )}

              {showLiveShell ? (
                <ShellStreamView
                  command={liveShellCommand}
                  cwd={liveShellCwd}
                  shell={shell?.id}
                  output={liveShellOutput}
                  startedAt={call.startedAt}
                  timeoutMs={liveShellTimeoutMs}
                />
              ) : streamingPreview ? (
                <pre
                  ref={previewRef}
                  className="agw-code agw-scroll agw-diff agw-diff-added agw-tool-stream"
                >
                  {streamingPreview}
                </pre>
              ) : (
                <ToolResultView parsed={parsed} activeMultiFileIndex={selectedFileIndex} />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

/**
 * `plan_write` — the plan is the deliverable of a planning conversation, so its
 * card is a way into the Canvas, not a JSON dump. Mirrors `CanvasLaunchCard`.
 */
const PlanLaunchCard: React.FC<{
  call: ToolCall;
  isActivelyStreaming: boolean;
}> = ({ call, isActivelyStreaming }) => {
  const status = toolStatus(call, isActivelyStreaming);
  let args: Record<string, unknown> = {};
  let result: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }
  try {
    result = JSON.parse(call.result || "{}") as Record<string, unknown>;
  } catch {
    result = {};
  }

  const title =
    (typeof args.title === "string" && args.title) ||
    partialString(call.arguments, "title") ||
    "Plan";
  const steps = Array.isArray(result.steps)
    ? result.steps.length
    : Array.isArray(args.steps)
      ? args.steps.length
      : 0;
  const revised = result.revised === true;
  const canOpen = status === "done";

  const openCanvas = () => {
    if (!canOpen) return;
    useAgentWorkspaceStore.getState().openTab("canvas");
  };

  return (
    <button
      type="button"
      className="agw-plan-launch"
      data-status={status}
      disabled={!canOpen}
      aria-label={canOpen ? `Open plan ${title} in Canvas` : undefined}
      onClick={openCanvas}
    >
      <span className="agw-plan-launch-status">
        {status === "running" ? (
          <span className="agw-spinner" aria-hidden />
        ) : (
          <AgentIcon
            name={status === "done" ? "check" : "close"}
            size={13}
            strokeWidth={2.6}
          />
        )}
      </span>
      <span className="agw-plan-launch-glyph">
        <AgentIcon name="task-list" size={16} />
      </span>
      <span className="agw-plan-launch-copy">
        <span className="agw-plan-launch-kicker">
          {status === "running"
            ? "Writing plan"
            : status === "failed"
              ? "Plan could not be written"
              : revised
                ? "Plan updated — open in Canvas"
                : "Plan ready — open in Canvas"}
        </span>
        <span className="agw-plan-launch-title">{title}</span>
      </span>
      {steps > 0 && (
        <span className="agw-plan-launch-version">
          {steps} step{steps === 1 ? "" : "s"}
        </span>
      )}
      {canOpen && <AgentIcon name="external" size={14} className="agw-plan-launch-open" />}
    </button>
  );
};

const PLAN_STEP_WORD: Record<string, string> = {
  in_progress: "Started",
  done: "Finished",
  failed: "Failed",
  skipped: "Skipped",
  pending: "Reset",
};

/**
 * `plan_step_update` — a progress beat, not a tool result worth unfolding. One
 * line naming the step and where the plan now stands; the Canvas has the rest.
 */
const PlanStepCard: React.FC<{
  call: ToolCall;
  isActivelyStreaming: boolean;
}> = ({ call, isActivelyStreaming }) => {
  const status = toolStatus(call, isActivelyStreaming);
  let args: Record<string, unknown> = {};
  let result: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }
  try {
    result = JSON.parse(call.result || "{}") as Record<string, unknown>;
  } catch {
    result = {};
  }

  const stepId = typeof args.stepId === "string" ? args.stepId : "";
  const newStatus = typeof args.status === "string" ? args.status : "";
  const steps = Array.isArray(result.steps)
    ? (result.steps as Array<Record<string, unknown>>)
    : [];
  const stepTitle =
    (steps.find((s) => s.id === stepId)?.title as string | undefined) ?? stepId;
  const cursor = (result.cursor ?? {}) as Record<string, unknown>;
  const done = typeof cursor.done === "number" ? cursor.done : undefined;
  const total = typeof cursor.total === "number" ? cursor.total : undefined;

  return (
    <button
      type="button"
      className="agw-plan-beat"
      data-status={status}
      data-step-status={newStatus || undefined}
      onClick={() => useAgentWorkspaceStore.getState().openTab("canvas")}
      aria-label={`${PLAN_STEP_WORD[newStatus] ?? "Updated"} ${stepTitle}. Open plan in Canvas.`}
    >
      <span className="agw-plan-beat-dot" aria-hidden />
      <span className="agw-plan-beat-verb">
        {PLAN_STEP_WORD[newStatus] ?? "Updated"}
      </span>
      <span className="agw-plan-beat-title">{stepTitle}</span>
      {done !== undefined && total !== undefined && (
        <span className="agw-plan-beat-count">
          {done}/{total}
        </span>
      )}
    </button>
  );
};

const TODO_STATUS_WORD: Record<string, string> = {
  in_progress: "Started",
  completed: "Finished",
  cancelled: "Dropped",
  pending: "Reset",
};

/**
 * `todo` — a progress beat, like `plan_step_update`, and for the same reason:
 * laying out a checklist or flipping one item is not a tool result worth
 * unfolding, but it IS an event, and a checklist that moves with no trace in
 * the reply reads as if nothing happened.
 *
 * One line, in the transcript's own past-tense rhythm: what happened, to what,
 * and how far along the list now is. It replaces what the transcript used to
 * show, which was the tool's raw result message verbatim — "Marked t2 as
 * completed. Nothing in progress; next up is t3." That string is written for
 * the model. A reader got internal ids instead of the task, and "nothing in
 * progress" read as if the agent had lost its place when it was simply between
 * two items.
 *
 * Static, not a button: the full checklist is one hover away in the header, so
 * a second click target here would lead somewhere the user can already reach.
 */
const TodoBeatCard: React.FC<{
  call: ToolCall;
  isActivelyStreaming: boolean;
}> = ({ call, isActivelyStreaming }) => {
  const status = toolStatus(call, isActivelyStreaming);
  let args: Record<string, unknown> = {};
  let result: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }
  try {
    result = JSON.parse(call.result || "{}") as Record<string, unknown>;
  } catch {
    result = {};
  }

  const op =
    (typeof result.op === "string" ? result.op : undefined) ??
    (typeof args.op === "string" ? args.op : "");
  const cursor = (result.cursor ?? {}) as Record<string, unknown>;
  const total =
    typeof cursor.total === "number"
      ? cursor.total
      : Array.isArray(args.todos)
        ? args.todos.length
        : undefined;
  // Closed, matching the header indicator and the checklist panel exactly.
  const done =
    typeof cursor.completed === "number"
      ? cursor.completed + (typeof cursor.cancelled === "number" ? cursor.cancelled : 0)
      : undefined;

  let verb: string;
  let title: string;
  if (op === "set") {
    // Laying out the list. The count IS the news here, so it leads.
    verb = "Planned";
    title = total === 1 ? "1 task" : `${total ?? 0} tasks`;
  } else {
    const newStatus =
      (typeof result.status === "string" ? result.status : undefined) ??
      (typeof args.status === "string" ? args.status : "");
    verb = TODO_STATUS_WORD[newStatus] ?? "Updated";
    // The id is the fallback, never the headline: it means nothing to a reader.
    title =
      (typeof result.title === "string" && result.title) ||
      (typeof args.id === "string" ? args.id : "task");
  }

  // What CHANGED — never the whole list. The full checklist has one home, the
  // header indicator, which is live and one hover away; drawing it again in
  // every card would say the same thing twice and age badly, since a card is a
  // record of a moment and the header is the current state.
  //
  // One line per change, because `updates` can now carry several: "Finished A"
  // then "Started B" is one call, and a single line could only name one of
  // them.
  const changes: Array<{ key: string; verb: string; title: string }> = [];
  if (status === "running") {
    // In flight. The result carries what actually changed, and until it lands
    // naming a task would be a guess — so say what is happening, not to what.
    changes.push({ key: "running", verb: "Updating", title: "tasks" });
  } else if (op === "set") {
    changes.push({ key: "set", verb, title });
  } else {
    const applied = Array.isArray(result.updates)
      ? (result.updates as Array<Record<string, unknown>>)
      : [];
    const items = Array.isArray(result.items)
      ? (result.items as Array<Record<string, unknown>>)
      : [];
    const titleOf = (id: unknown): string => {
      const match = items.find((item) => item.id === id);
      return typeof match?.content === "string" ? match.content : String(id ?? "task");
    };
    if (applied.length > 0) {
      for (const change of applied) {
        const changeStatus = typeof change.status === "string" ? change.status : "";
        changes.push({
          key: String(change.id),
          verb: TODO_STATUS_WORD[changeStatus] ?? "Updated",
          title: titleOf(change.id),
        });
      }
    } else {
      // Single-item form, or a result from before `updates` existed.
      changes.push({ key: "single", verb, title });
    }
  }

  return (
    <div className="agw-task-beat" data-status={status} data-task-op={op || undefined}>
      {changes.map((change, index) => (
        <div className="agw-task-beat-head" key={change.key}>
          <span className="agw-task-beat-dot" aria-hidden />
          <span className="agw-task-beat-verb">{change.verb}</span>
          <span className="agw-task-beat-title">{change.title}</span>
          {/* The count is the state AFTER the whole call, so it belongs to the
            * last line only — repeating it per line would show the same
            * number beside changes it does not describe yet. */}
          {index === changes.length - 1 && done !== undefined && total !== undefined && (
            <span className="agw-task-beat-count">
              {done}/{total}
            </span>
          )}
        </div>
      ))}
    </div>
  );
};

export const ToolCallCard: React.FC<{
  call: ToolCall;
  isActivelyStreaming?: boolean;
}> = ({ call, isActivelyStreaming = false }) => {
  if (call.name === "present_artifact") {
    return <CanvasLaunchCard call={call} isActivelyStreaming={isActivelyStreaming} />;
  }
  if (call.name === "plan_write") {
    return <PlanLaunchCard call={call} isActivelyStreaming={isActivelyStreaming} />;
  }
  // The doctrine is a boundary, not an act — it gets a rule across the pane
  // instead of a row. A FAILED call keeps the standard card: an invalid
  // `topic` has a message worth reading and a body worth opening, and a
  // divider can carry neither.
  if (
    call.name === "design_guidelines" &&
    toolStatus(call, isActivelyStreaming) !== "failed"
  ) {
    return <DoctrineRule call={call} isActivelyStreaming={isActivelyStreaming} />;
  }
  if (call.name === "plan_step_update") {
    return <PlanStepCard call={call} isActivelyStreaming={isActivelyStreaming} />;
  }
  // `op: "read"` never reaches here — `buildRows` drops it (see
  // `isSilentToolCall`), because a lookup that changes nothing is not an event.
  if (call.name === "todo") {
    return <TodoBeatCard call={call} isActivelyStreaming={isActivelyStreaming} />;
  }
  return <StandardToolCallCard call={call} isActivelyStreaming={isActivelyStreaming} />;
};
