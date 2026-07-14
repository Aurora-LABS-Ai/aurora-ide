/**
 * Agent Window — tool-result parser (leaf, non-component).
 *
 * Isolated re-implementation of the IDE's `useToolResultParser`: turns a raw
 * `tool.result` JSON payload into the per-view data the agent window's rich
 * renderers consume (tree / multi-file / grep / shell / file list / code). We do
 * NOT import the IDE parser or its types on purpose — the agent window is a
 * self-contained module (own `--agw-*` theme, own icons) that must keep working
 * if the IDE chat is later removed. The runtime hands us the FULL result via the
 * `tool_execution_result` event (same source the IDE renders trees from), so
 * `JSON.parse` succeeds for non-truncated payloads; anything else degrades to a
 * cleaned code/text view rather than a raw blob.
 */

// ── Data shapes ──────────────────────────────────────────────────────

export interface WorkspaceTreeNode {
  name: string;
  type: "file" | "directory" | string;
  path?: string;
  children?: WorkspaceTreeNode[];
  lineCount?: number;
  size?: number;
  largeFile?: boolean;
  /** A build/dependency dir shown by name only — its contents weren't walked. */
  artifact?: boolean;
}

export interface WorkspaceTreeStats {
  filesRead?: number;
  filesSkipped?: number;
}

export interface WorkspaceTreeData {
  rootPath?: string;
  tree: WorkspaceTreeNode[];
  stats?: WorkspaceTreeStats;
}

export interface MultiFileEntry {
  path: string;
  success: boolean;
  lines?: number;
  error?: string;
}

export interface GrepMatch {
  file: string;
  line: number;
  content?: string;
}

export interface GrepData {
  matches: GrepMatch[];
  pattern?: string;
  totalMatches?: number;
  truncated?: boolean;
}

export interface ShellOutputData {
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  mode: "inline" | "terminal";
  output: string;
  success: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
}

export interface ParsedToolResult {
  /** Short status line shown in the header (e.g. "Read 3 files"). */
  summary: string | null;
  tree: WorkspaceTreeData | null;
  multiFile: MultiFileEntry[] | null;
  grep: GrepData | null;
  shell: ShellOutputData | null;
  fileList: FileEntry[] | null;
  /** Edit preview built from the call ARGS (modify tools). */
  edit: { removed?: string; added?: string } | null;
  /** Line-change counts for the header chip (+added green / −removed red). */
  stat: { added: number; removed: number } | null;
  /** Full before/after content for a REAL line diff (modify tools that emit
   *  `oldContent`/`newContent`). Preferred over `edit` when present. `fullPath`
   *  is the absolute path (for opening the file in the IDE across windows). */
  diff: { oldText: string; newText: string; path?: string; fullPath?: string } | null;
  /** One entry per file for a multi-file edit (`file_edit` with per-item paths).
   *  Each carries its own before/after so the UI can draw a diff for every file
   *  the single call touched. `null` for single-file results. */
  diffs:
    | Array<{ oldText: string; newText: string; path?: string; fullPath?: string }>
    | null;
  /** Cleaned text fallback when no rich view applies. */
  code: string | null;
  /** Source path behind `code` (file_read / content payloads), so the view can
   *  pick a syntax-highlight language. `null` when the text isn't a file. */
  codePath: string | null;
  /** `browser_screenshot` result — the on-disk PNG (asset-protocol loadable via
   *  `convertFileSrc`), its pixel dimensions, and the captured page URL. The card
   *  renders the image only when expanded; clicking it opens the image modal.
   *  `base64` is the embedded fallback used when the on-disk file is gone (pruned)
   *  or a persisted/reloaded thread carries the raw `<aurora_image>` block. */
  screenshot: {
    path?: string;
    width?: number;
    height?: number;
    url?: string;
    base64?: string;
  } | null;
}

const FILE_MODIFY_TOOLS = new Set([
  // Current.
  "file_write",
  "file_edit",
  // Legacy (historical threads).
  "file_create",
  "file_patch",
  "search_replace",
]);

const MAX_CODE = 4000;

/**
 * Cap on shell output rendered in a tool card. A runaway command can emit
 * megabytes; pushing that into a `<pre>` freezes layout (and stresses the
 * WebView renderer). Keep the head (the command's real signal) plus the tail
 * (exit summary / final error) and note the elision between them.
 */
const MAX_SHELL_HEAD = 24_000;
const MAX_SHELL_TAIL = 12_000;

function clampShellOutput(text: string): string {
  if (text.length <= MAX_SHELL_HEAD + MAX_SHELL_TAIL) return text;
  const omitted = text.length - MAX_SHELL_HEAD - MAX_SHELL_TAIL;
  return `${text.slice(0, MAX_SHELL_HEAD)}\n… (${omitted.toLocaleString()} characters omitted) …\n${text.slice(-MAX_SHELL_TAIL)}`;
}

// ── Safe accessors (JSON.parse → unknown; narrow before use) ──────────

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNum(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function asArr(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

function baseName(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() || p;
}

/** Host of a URL for the summary line, or the raw string if it won't parse. */
function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * Extract a `browser_screenshot` result in EITHER shape:
 *  - lean JSON `{ screenshot: { path, width, height, url } }` (the live UI event)
 *  - the raw model string `<aurora_image ... src=.. width=.. height=..>BASE64</aurora_image>
 *    \nScreenshot of URL (W×H px)` (persisted/reloaded threads carry this — the
 *    UI copy isn't re-persisted, only the model-history copy is).
 * Returns null when neither shape is present. NEVER lets the raw base64 leak to
 * the text/code fallback.
 */
function parseScreenshotResult(
  parsed: Record<string, unknown> | null,
  raw: string,
): ParsedToolResult["screenshot"] {
  const j = parsed ? rec(parsed.screenshot) : null;
  if (j) {
    return {
      path: asStr(j.path),
      width: asNum(j.width),
      height: asNum(j.height),
      url: asStr(j.url),
      base64: asStr(j.base64),
    };
  }

  const open = raw.indexOf("<aurora_image ");
  if (open < 0) return null;
  const headerEnd = raw.indexOf(">", open);
  if (headerEnd < 0) return null;
  const header = raw.slice(open, headerEnd);
  const attr = (name: string): string | undefined => {
    const m = header.match(new RegExp(`${name}="([^"]*)"`));
    return m ? m[1] : undefined;
  };
  const closeAt = raw.indexOf("</aurora_image>", headerEnd);
  const base64 = closeAt > headerEnd ? raw.slice(headerEnd + 1, closeAt).trim() : undefined;

  const capAt = raw.indexOf("Screenshot of ");
  const url =
    capAt >= 0 ? raw.slice(capAt + "Screenshot of ".length).split(" (")[0].trim() || undefined : undefined;

  const rawPath = attr("src");
  const w = attr("width");
  const h = attr("height");
  return {
    path: rawPath ? rawPath.replace(/&quot;/g, '"').replace(/&amp;/g, "&") : undefined,
    width: w ? Number(w) : undefined,
    height: h ? Number(h) : undefined,
    url,
    base64: base64 || undefined,
  };
}

function toTreeNodes(v: unknown): WorkspaceTreeNode[] {
  const arr = asArr(v);
  if (!arr) return [];
  const out: WorkspaceTreeNode[] = [];
  for (const item of arr) {
    const o = rec(item);
    if (!o) continue;
    out.push({
      name: asStr(o.name) ?? "",
      type: asStr(o.type) ?? "file",
      path: asStr(o.path),
      lineCount: asNum(o.lineCount),
      size: asNum(o.size),
      largeFile: o.largeFile === true,
      artifact: o.artifact === true,
      children: o.children ? toTreeNodes(o.children) : undefined,
    });
  }
  return out;
}

function clean(raw: string): string {
  const text = raw.length > MAX_CODE
    ? `${raw.slice(0, MAX_CODE)}\n… (${raw.length - MAX_CODE} more characters)`
    : raw;
  return text;
}

const EMPTY: ParsedToolResult = {
  summary: null,
  tree: null,
  multiFile: null,
  grep: null,
  shell: null,
  fileList: null,
  edit: null,
  stat: null,
  diff: null,
  diffs: null,
  code: null,
  codePath: null,
  screenshot: null,
};

// ── Parser ───────────────────────────────────────────────────────────

export function parseToolResult(
  name: string,
  args: Record<string, unknown>,
  result: string | null | undefined,
): ParsedToolResult {
  const out: ParsedToolResult = { ...EMPTY };

  // Edit preview from ARGS (available even before the result lands).
  if (FILE_MODIFY_TOOLS.has(name)) {
    const removed = asStr(args.old_string) ?? asStr(args.oldString);
    const added =
      asStr(args.new_string) ??
      asStr(args.newString) ??
      asStr(args.content) ??
      asStr(args.newContent);
    if (removed || added) out.edit = { removed, added };
  }

  if (!result) return out;

  const trimmed = result.trim();
  const isJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  let parsed: Record<string, unknown> | null = null;
  if (isJson) {
    try {
      parsed = rec(JSON.parse(trimmed));
    } catch {
      parsed = null;
    }
  }

  // browser_screenshot — handled FIRST (before the non-JSON fallback) so the raw
  // `<aurora_image>…base64…` block a reloaded thread carries renders as an image,
  // never as a dumped base64 blob. Covers both the lean JSON (live) and raw
  // (persisted) shapes.
  if (name === "browser_screenshot" || result.includes("<aurora_image ")) {
    const shot = parseScreenshotResult(parsed, result);
    if (shot && (shot.path || shot.base64)) {
      out.screenshot = shot;
      const host = hostOf(shot.url);
      out.summary = host ? `Captured ${host}` : "Captured screenshot";
      return out;
    }
  }

  // Non-JSON (plain text, error sentinel, truncated) → text fallback.
  if (!parsed) {
    if (!out.edit) out.code = clean(result);
    return out;
  }

  // Multi-file edit — one entry per file. Fires for the canonical result
  // (`multiFile:true` + per-file `oldContent`/`newContent`) AND for compacted or
  // legacy shapes that only carry `newContent` (e.g. a card reloaded from an old
  // conversation whose stored result dropped the `oldContent` side). Either way
  // the card NEVER falls through to a raw-JSON dump:
  //   • both sides present  → a real red/green diff per file;
  //   • only `newContent`   → the resulting file, syntax-highlighted.
  const filesArr = asArr(parsed.files);
  const isEditFiles =
    !!filesArr &&
    filesArr.length > 0 &&
    (parsed.multiFile === true ||
      filesArr.some((f) => {
        const o = rec(f);
        return !!o && (typeof o.newContent === "string" || typeof o.oldContent === "string");
      }));
  if (isEditFiles) {
    const files = filesArr!;
    const diffs: NonNullable<ParsedToolResult["diffs"]> = [];
    const newOnly: Array<{ path?: string; fullPath?: string; content: string }> = [];
    let added = 0;
    let removed = 0;
    for (const f of files) {
      const o = rec(f);
      if (!o) continue;
      added += asNum(o.linesAdded) ?? 0;
      removed += asNum(o.linesRemoved) ?? 0;
      const fo = o.oldContent;
      const fn = o.newContent;
      if (typeof fo === "string" && typeof fn === "string") {
        diffs.push({
          oldText: fo,
          newText: fn,
          path: asStr(o.path),
          fullPath: asStr(o.fullPath),
        });
      } else if (typeof fn === "string") {
        newOnly.push({ path: asStr(o.path), fullPath: asStr(o.fullPath), content: fn });
      }
    }
    if (diffs.length > 0) {
      out.diffs = diffs;
    } else if (newOnly.length === 1) {
      // No before/after available — show the resulting file content instead of
      // a raw JSON blob (syntax-highlighted via the carried path).
      out.code = newOnly[0].content;
      out.codePath = newOnly[0].fullPath ?? newOnly[0].path ?? null;
    } else if (newOnly.length > 1) {
      out.code = newOnly
        .map((f) => `// ── ${f.path ?? f.fullPath ?? "file"} ──\n${f.content}`)
        .join("\n\n");
    }
    if (added || removed) out.stat = { added, removed };
    const n = asNum(parsed.filesEdited) ?? files.length;
    const success = parsed.success !== false;
    out.summary = success
      ? `Edited ${n} ${n === 1 ? "file" : "files"}`
      : asStr(parsed.error) ?? "Edit failed";
    return out;
  }

  // Real before/after for the diff, emitted by the modify tools. Both sides must
  // be present strings (a `null` side means the backend capped it on size → we
  // fall back to the hunk/stats). `""` is valid (a created file's old side).
  const oldC = parsed.oldContent;
  const newC = parsed.newContent;
  if (typeof oldC === "string" && typeof newC === "string") {
    out.diff = {
      oldText: oldC,
      newText: newC,
      path: asStr(parsed.path) ?? asStr(args.path) ?? asStr(args.file_path),
      fullPath: asStr(parsed.fullPath),
    };
  }

  if (name === "shell_execute" || name === "shell_spawn") {
    const pieces: string[] = [];
    const stdout = asStr(parsed.stdout);
    const stderr = asStr(parsed.stderr);
    const error = asStr(parsed.error);
    if (stdout) pieces.push(stdout);
    if (stderr) pieces.push(stderr);
    if (error) pieces.push(error);
    const success = parsed.success === true;
    const exit = asNum(parsed.exitCode);
    out.shell = {
      command: asStr(parsed.command) ?? asStr(args.command),
      cwd: asStr(parsed.cwd) ?? asStr(args.cwd),
      exitCode: exit ?? null,
      mode: parsed.type === "terminal" ? "terminal" : "inline",
      output: clampShellOutput(pieces.join("\n")),
      success,
    };
    out.summary = success ? "Ran command" : "Command failed";
    return out;
  }

  // Batch reads now flow through `file_read` (paths form), which returns
  // the same `files` payload the old `multi_file_read` did.
  if ((name === "multi_file_read" || name === "file_read") && parsed.files) {
    const files = asArr(parsed.files) ?? [];
    const entries: MultiFileEntry[] = [];
    for (const f of files) {
      const o = rec(f);
      if (!o) continue;
      entries.push({
        path: asStr(o.path) ?? "",
        success: o.success !== false,
        lines: asNum(o.lines),
        error: asStr(o.error),
      });
    }
    out.multiFile = entries;
    const n = asNum(parsed.filesRead) ?? entries.length;
    out.summary = `Read ${n} ${n === 1 ? "file" : "files"}`;
    return out;
  }

  if (name === "workspace_tree" && Array.isArray(parsed.tree)) {
    const stats = rec(parsed.stats);
    out.tree = {
      rootPath: asStr(parsed.rootPath),
      tree: toTreeNodes(parsed.tree),
      stats: stats
        ? { filesRead: asNum(stats.filesRead), filesSkipped: asNum(stats.filesSkipped) }
        : undefined,
    };
    const fileCount = asNum(stats?.filesRead);
    out.summary = fileCount !== undefined ? `${fileCount} files` : null;
    return out;
  }

  if (name === "grep" && (Array.isArray(parsed.matches) || Array.isArray(parsed.files))) {
    if (Array.isArray(parsed.matches)) {
      const matches: GrepMatch[] = [];
      for (const m of asArr(parsed.matches) ?? []) {
        const o = rec(m);
        if (!o) continue;
        matches.push({
          file: asStr(o.file) ?? "",
          line: asNum(o.line_number) ?? asNum(o.line) ?? 0,
          content: asStr(o.content),
        });
      }
      out.grep = {
        matches,
        pattern: asStr(parsed.pattern) ?? asStr(args.pattern),
        totalMatches: asNum(parsed.total_matches) ?? asNum(parsed.totalMatches),
        truncated: parsed.truncated === true,
      };
      const hits = matches.length;
      const files = new Set(matches.map((m) => m.file)).size;
      out.summary = `${hits} ${hits === 1 ? "match" : "matches"} · ${files} ${files === 1 ? "file" : "files"}`;
    } else {
      const files = asArr(parsed.files) ?? [];
      out.fileList = files
        .map((p) => asStr(p))
        .filter((p): p is string => !!p)
        .map((p) => ({ name: baseName(p), path: p }));
      out.summary = `${out.fileList.length} files`;
    }
    return out;
  }

  // file_read and generic content payloads.
  const content = asStr(parsed.content);
  if (content) {
    out.code = clean(content);
    out.codePath =
      asStr(parsed.path) ?? asStr(args.path) ?? asStr(args.file_path) ?? null;
    if (name === "file_read") {
      const lines = content.split("\n").length;
      out.summary = `Read ${lines} ${lines === 1 ? "line" : "lines"}`;
    }
    return out;
  }

  // workspace file list (non-grep).
  if (parsed.files && name.includes("workspace")) {
    const files = asArr(parsed.files) ?? [];
    out.fileList = files
      .map((p) => asStr(p))
      .filter((p): p is string => !!p)
      .map((p) => ({ name: baseName(p), path: p }));
    out.summary = `${out.fileList.length} files`;
    return out;
  }

  // Diff counts for modify tools.
  const linesAdded = asNum(parsed.linesAdded);
  const linesRemoved = asNum(parsed.linesRemoved);
  if (linesAdded || linesRemoved) {
    out.stat = { added: linesAdded ?? 0, removed: linesRemoved ?? 0 };
    out.summary = [
      linesRemoved ? `-${linesRemoved}` : null,
      linesAdded ? `+${linesAdded}` : null,
    ]
      .filter(Boolean)
      .join("  ");
    return out;
  }

  const message = asStr(parsed.message);
  if (message) {
    out.summary = message.length > 60 ? "Done" : message;
    return out;
  }
  if (parsed.success === true) {
    out.summary = "Done";
    return out;
  }

  // Last resort: pretty-print the object so it's at least readable.
  if (!out.edit) out.code = clean(JSON.stringify(parsed, null, 2));
  return out;
}

export { baseName };
