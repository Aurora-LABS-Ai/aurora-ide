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

import { streamedToolStringArguments } from "@/apps/agent/components/tools/tool-call";
import { computeDiff } from "@/apps/agent/components/tool-views/diff";
import {
  findImageMarker,
  hasImageMarker,
  MARKER_CLOSE,
} from "@/apps/agent/lib/render/image-markers";

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
  /** A dot-directory listed but not walked (pass include_hidden to expand). */
  hidden?: boolean;
  /** The walk stopped here at the depth limit — NOT an empty directory. */
  depthLimited?: boolean;
  /** Entries the node budget left out of THIS directory. */
  elided?: number;
}

export interface WorkspaceTreeStats {
  filesRead?: number;
  filesSkipped?: number;
  nodesReturned?: number;
  nodesDiscovered?: number;
}

export interface WorkspaceTreeData {
  rootPath?: string;
  tree: WorkspaceTreeNode[];
  stats?: WorkspaceTreeStats;
  /** The map is partial. `note` says what was left out and how to get it. */
  truncated?: boolean;
  note?: string;
}

/** The line range a windowed read actually returned, when one was asked for. */
export interface ReadWindow {
  start: number;
  end: number;
}

export interface MultiFileEntry {
  path: string;
  success: boolean;
  lines?: number;
  error?: string;
  content?: string;
  fullPath?: string;
  truncated?: boolean;
  /** Set when the caller asked for a line range rather than the whole file. */
  window?: ReadWindow;
  /** Set when this entry is a picture rather than text. A read can name images
   *  and source files in one call, so the two share the file list and the same
   *  selection — the body shows the picture for this entry and the code for the
   *  next, instead of stacking every image down the card. */
  image?: ToolImage;
}

/** One picture in a result, from a capture or an opened file. */
export interface ToolImage {
  /** The on-disk copy, asset-protocol loadable. */
  path?: string;
  width?: number;
  height?: number;
  /** A captured page's URL. Absent for a file that was read. */
  url?: string;
  /** The path the caller named. Absent for a capture. */
  name?: string;
  /** Inline fallback for when the on-disk copy is gone. */
  base64?: string;
  mediaType?: string;
  /**
   * The Canvas artifact this picture was placed in. Only `generate_image`
   * sets it (the marker's `artifact` attribute); a capture or a read file has
   * no Canvas entry and the card offers nothing to open.
   */
  artifactId?: string;
}

/**
 * Rust compacts oversized string fields before persisting a tool result,
 * appending this marker INSIDE the field. Left alone it leaks into diffs as a
 * fake red/green change line ("−[truncated 4923 bytes…] / +[truncated 4933
 * bytes…]") — strip it and let the view render an honest note instead.
 */
const HISTORY_TRUNCATION_MARKER = /\n*\[truncated \d+ bytes in persisted history\]\s*$/;

function splitHistoryTruncation(text: string): { text: string; truncated: boolean } {
  const match = text.match(HISTORY_TRUNCATION_MARKER);
  if (!match || match.index === undefined) return { text, truncated: false };
  return { text: text.slice(0, match.index), truncated: true };
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

/**
 * `glob` result — files matched by NAME rather than content.
 *
 * Distinct from `fileList` (a flat bag of names) because the answer to "where
 * is this file" is the *path*, not the basename, and because a truncated match
 * set has to report its real total the same way grep does.
 */
export interface GlobData {
  /** Workspace-relative paths, newest-modified first. */
  files: string[];
  pattern?: string;
  /** Total matches found, which may exceed `files.length`. */
  total?: number;
  truncated?: boolean;
  /** What was left out and how to get it, straight from the tool. */
  note?: string;
}

export interface ShellOutputData {
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  mode: "inline" | "terminal";
  output: string;
  success: boolean;
  /** Shell the command ran in — the RESOLVED id from the result when present
   *  (a substitution shows what actually ran), else the requested arg. */
  shell?: string;
  /** Runtime note when the requested shell wasn't configured and another ran. */
  shellNote?: string;
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
  glob: GlobData | null;
  shell: ShellOutputData | null;
  fileList: FileEntry[] | null;
  /** Edit preview built from the call ARGS (modify tools). */
  edit: { removed?: string; added?: string } | null;
  /** Line-change counts for the header chip (+added green / −removed red). */
  stat: { added: number; removed: number } | null;
  /** Full before/after content for a REAL line diff (modify tools that emit
   *  `oldContent`/`newContent`). Preferred over `edit` when present. `fullPath`
   *  is the absolute path (for opening the file in the IDE across windows). */
  diff: {
    oldText: string;
    newText: string;
    path?: string;
    fullPath?: string;
    truncated?: boolean;
  } | null;
  /** One entry per file for a multi-file edit (`file_edit` with per-item paths).
   *  Each carries its own before/after so the UI can draw a diff for every file
   *  the single call touched. `added`/`removed` are that file's own line-change
   *  counts (rendered inside its header chip). `null` for single-file results. */
  diffs:
    | Array<{
        oldText: string;
        newText: string;
        path?: string;
        fullPath?: string;
        added?: number;
        removed?: number;
        /** Persisted history clamped this file's before/after — the rendered
         *  diff is the kept head, not the whole change. */
        truncated?: boolean;
      }>
    | null;
  /** Cleaned text fallback when no rich view applies. */
  code: string | null;
  /** Source path behind `code` (file_read / content payloads), so the view can
   *  pick a syntax-highlight language. `null` when the text isn't a file. */
  codePath: string | null;
  /** A result that is ONE picture and nothing else — a `browser_screenshot`
   *  capture, or a single image opened by `file_read`. The card renders it only
   *  when expanded; clicking it opens the image modal.
   *
   *  A call that named several files puts its pictures on `multiFile` instead,
   *  so they share the file chips and one selection with the text files beside
   *  them rather than stacking down the card. */
  image: ToolImage | null;
  /** `auroro_websearch` — either a results page or one fetched document. */
  web: WebData | null;
}

/** One entry on a results page. */
export interface WebHit {
  rank: number;
  title: string;
  url: string;
  displayUrl?: string;
  snippet?: string;
}

/**
 * A web result, in whichever of its two shapes came back.
 *
 * One type rather than two because the card routes on it once, and the two
 * shapes share their head: a source, a count, and a note when something was
 * left out.
 */
export interface WebData {
  kind: "search" | "document";
  /** Search: the query. Document: the page title. */
  heading: string;
  /** Search: the back end that answered. Document: the URL. */
  source?: string;
  hits?: WebHit[];
  /** The fetched page as Markdown. */
  content?: string;
  /** `article` when the page's body was isolated, `page` when it was not,
   *  `text`/`data` for a non-HTML payload. Drives the label on the card. */
  documentKind?: string;
  /** Characters in the whole document, when more than this window holds. */
  totalChars?: number;
  offset?: number;
  hasMore?: boolean;
  /** Anything the reader has to know: a rewritten URL, an unreadable format,
   *  a partial download. Shown verbatim — it is the same sentence the model
   *  was given. */
  note?: string;
}

const FILE_MODIFY_TOOLS = new Set([
  // Current.
  "file_write",
  "file_edit",
  // Legacy (historical threads).
  "file_create",
  "file_patch",
  "search_replace",
  "multi_search_replace",
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

/** Reverse the escaping applied when a path was written into a marker
 *  attribute. Mirrors `aurora_image::unescape_attr` on the Rust side. */
function unescapeAttr(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/**
 * Extract every picture in a result, in EITHER shape:
 *  - lean JSON `{ screenshot: { path, width, height, url, name } }` — the live
 *    UI event for a result holding exactly one image;
 *  - the raw string `<aurora_image ... src=.. width=.. height=..>BASE64</aurora_image>`
 *    followed by its caption. Persisted/reloaded threads carry this (only the
 *    model-history copy is re-persisted), and so does any live result with more
 *    than one image, which does not fit the single envelope.
 *
 * Returns null when neither shape is present. NEVER lets raw base64 leak to the
 * text/code fallback.
 *
 * The raw branch uses the validated marker parser: a plain file read whose
 * content merely quotes the marker syntax used to land here and render as a
 * "Captured screenshot" card.
 */
function parseImageResults(
  parsed: Record<string, unknown> | null,
  raw: string,
): ToolImage[] | null {
  const j = parsed ? rec(parsed.screenshot) : null;
  if (j) {
    return [
      {
        path: asStr(j.path),
        width: asNum(j.width),
        height: asNum(j.height),
        url: asStr(j.url),
        name: asStr(j.name),
        base64: asStr(j.base64),
      },
    ];
  }

  // Only a capture's caption carries a URL, and there is at most one of them in
  // a result, so it is read once rather than per image.
  const capAt = raw.indexOf("Screenshot of ");
  const url =
    capAt >= 0
      ? raw.slice(capAt + "Screenshot of ".length).split(" (")[0].trim() || undefined
      : undefined;

  const out: ToolImage[] = [];
  for (let cursor = 0; ; ) {
    const marker = findImageMarker(raw, cursor);
    if (!marker) break;
    cursor = marker.end;

    const rawPath = marker.attrs.src;
    const w = marker.attrs.width;
    const h = marker.attrs.height;
    out.push({
      path: rawPath ? unescapeAttr(rawPath) : undefined,
      width: w ? Number(w) : undefined,
      height: h ? Number(h) : undefined,
      url,
      name: marker.attrs.name ? unescapeAttr(marker.attrs.name) : undefined,
      base64: marker.body.trim() || undefined,
      mediaType: marker.attrs.media_type,
      artifactId: marker.attrs.artifact ? unescapeAttr(marker.attrs.artifact) : undefined,
    });
  }
  return out.length > 0 ? out : null;
}

/** A batch read's `files` rows → the card's file list. */
function filesToEntries(files: unknown[], historyTruncated: boolean): MultiFileEntry[] {
  const entries: MultiFileEntry[] = [];
  for (const f of files) {
    const o = rec(f);
    if (!o) continue;
    const content = typeof o.content === "string" ? splitHistoryTruncation(o.content) : null;
    const range = rec(o.range);
    entries.push({
      path: asStr(o.path) ?? "",
      success: o.success !== false,
      lines: asNum(o.lines),
      error: asStr(o.error),
      content: content?.text,
      fullPath: asStr(o.fullPath),
      // A read the caller WINDOWED is not a read that was cut for size, and
      // the card says a different thing for each. `outsideWindow` means "there
      // are lines either side of what you asked for" — normal, and stated as
      // the range. `truncated` means "this was too big to keep", which is the
      // only case worth an apology.
      truncated: o.truncated === true || historyTruncated || content?.truncated === true,
      window:
        o.windowed === true && range
          ? { start: asNum(range.startLine) ?? 0, end: asNum(range.endLine) ?? 0 }
          : undefined,
    });
  }
  return entries;
}

/**
 * Recover the JSON inventory a mixed read appends AFTER its pictures.
 *
 * `file_read` answers a call naming both images and source files in two shapes:
 * the `<aurora_image>` markers first, then the ordinary batch envelope. The
 * whole string is therefore not JSON, so the caller's `JSON.parse` fails and
 * the text files would be lost from the card even though the model got them.
 *
 * Returns null when there is no trailing object — a read of nothing but
 * pictures, which is most of them.
 */
function trailingEnvelope(raw: string): Record<string, unknown> | null {
  const lastClose = raw.lastIndexOf(MARKER_CLOSE);
  if (lastClose < 0) return null;
  const after = raw.slice(lastClose + MARKER_CLOSE.length);
  const start = after.indexOf("{");
  if (start < 0) return null;
  try {
    return rec(JSON.parse(after.slice(start)));
  } catch {
    return null;
  }
}

/**
 * Put each picture on the file-list entry for the path it came from, so one
 * selection drives the whole result.
 *
 * The pictures name the path the caller asked for (the marker's `name`), which
 * is exactly the `path` the inventory rows carry — matching on it rather than
 * on position is what keeps the seventh chip showing the seventh file when the
 * two halves were read by different readers and came back in different orders.
 *
 * An image matching no row still gets an entry: a picture the card silently
 * drops is worse than one listed twice.
 */
function mergeImagesIntoFiles(rows: MultiFileEntry[], images: ToolImage[]): MultiFileEntry[] {
  const merged = rows.map((row) => {
    const image = images.find((candidate) => candidate.name === row.path);
    return image ? { ...row, image } : row;
  });
  const claimed = new Set(merged.map((row) => row.image?.name).filter(Boolean));
  for (const image of images) {
    if (image.name && claimed.has(image.name)) continue;
    merged.push({ path: image.name ?? "", success: true, image });
  }
  return merged;
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
      hidden: o.hidden === true,
      depthLimited: o.depthLimited === true,
      elided: asNum(o.elided),
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

function editDiffsFromArgs(
  args: Record<string, unknown>,
): NonNullable<ParsedToolResult["diffs"]> {
  const edits = asArr(args.edits) ?? asArr(args.replacements) ?? [];
  const defaultPath = asStr(args.path);
  const grouped = new Map<string, { oldText: string[]; newText: string[] }>();

  for (const edit of edits) {
    const item = rec(edit);
    if (!item) continue;
    const path = asStr(item.path) ?? defaultPath;
    const oldText = asStr(item.old_string) ?? asStr(item.oldString);
    const newText = asStr(item.new_string) ?? asStr(item.newString);
    if (!path || oldText === undefined || newText === undefined) continue;
    const group = grouped.get(path) ?? { oldText: [], newText: [] };
    group.oldText.push(oldText);
    group.newText.push(newText);
    grouped.set(path, group);
  }

  return Array.from(grouped, ([path, edit]) => ({
    path,
    oldText: edit.oldText.join("\n\n"),
    newText: edit.newText.join("\n\n"),
  }));
}

function stripBrokenHistoryMarker(value: string): string {
  const marker = value.indexOf("\n\n[truncated ");
  return marker >= 0 ? value.slice(0, marker) : value;
}

function recoverTruncatedRead(
  out: ParsedToolResult,
  name: string,
  args: Record<string, unknown>,
  raw: string,
): boolean {
  if (name !== "file_read" && name !== "multi_file_read") return false;
  if (!raw.includes("[truncated ")) return false;

  const values = streamedToolStringArguments(raw, [
    "path",
    "fullPath",
    "content",
    "error",
  ]);
  const contents = values.content ?? [];
  if (contents.length === 0) return false;

  // `file_read`'s `path` is one slot holding an ARRAY; a bare string and
  // `paths` are what threads already on disk were recorded under. All three
  // spell the same request, so a batch card renders the same either way.
  const argPaths = [args.path, args.paths].flatMap((value) =>
    Array.isArray(value)
      ? value.filter((path): path is string => typeof path === "string")
      : [],
  );
  const paths = (values.path ?? []).map((value) => value.value);
  const fullPaths = (values.fullPath ?? []).map((value) => value.value);
  const errors = (values.error ?? []).map((value) => value.value);
  const batch = name === "multi_file_read" || argPaths.length > 0;

  if (batch) {
    const count = Math.max(contents.length, paths.length, argPaths.length);
    out.multiFile = Array.from({ length: count }, (_, index) => {
      const contentValue = contents[index];
      const content = contentValue
        ? stripBrokenHistoryMarker(contentValue.value)
        : undefined;
      return {
        path: paths[index] ?? argPaths[index] ?? fullPaths[index] ?? `file ${index + 1}`,
        fullPath: fullPaths[index],
        success: content !== undefined,
        content,
        lines: content === undefined ? undefined : content.split("\n").length,
        error: errors[index],
        truncated: !contentValue?.complete,
      };
    });
    out.summary = `Read ${out.multiFile.length} ${
      out.multiFile.length === 1 ? "file" : "files"
    }`;
    return true;
  }

  const content = stripBrokenHistoryMarker(contents[0].value);
  out.code = content;
  out.codePath =
    paths[0] ??
    fullPaths[0] ??
    asStr(args.path) ??
    asStr(args.file_path) ??
    null;
  out.summary = `Read ${content.split("\n").length} ${
    content.split("\n").length === 1 ? "line" : "lines"
  }`;
  return true;
}

function completeJsonArrayItems(raw: string, arrayStart: number): unknown[] {
  const items: unknown[] = [];
  let itemStart = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = arrayStart + 1; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      if (itemStart < 0) itemStart = index;
      continue;
    }
    if (itemStart < 0) {
      if (/\s|,/.test(char)) continue;
      if (char === "]") break;
      itemStart = index;
    }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;

    if (depth === 0 && (char === "}" || char === "]")) {
      try {
        items.push(JSON.parse(raw.slice(itemStart, index + 1)));
      } catch {
        break;
      }
      itemStart = -1;
    }
  }
  return items;
}

function recoverTruncatedWorkspaceTree(
  out: ParsedToolResult,
  name: string,
  raw: string,
): boolean {
  if (name !== "workspace_tree" || !raw.includes("[truncated ")) return false;
  const treeKey = raw.indexOf('"tree"');
  const arrayStart = treeKey < 0 ? -1 : raw.indexOf("[", treeKey);
  if (arrayStart < 0) return false;
  const nodes = toTreeNodes(completeJsonArrayItems(raw, arrayStart));
  if (nodes.length === 0) return false;

  const rootPath = streamedToolStringArguments(raw, ["rootPath"]).rootPath?.[0]?.value;
  out.tree = { rootPath, tree: nodes };
  out.summary = `${nodes.length}+ ${nodes.length === 1 ? "node" : "nodes"}`;
  return true;
}

const EMPTY: ParsedToolResult = {
  summary: null,
  tree: null,
  multiFile: null,
  grep: null,
  glob: null,
  shell: null,
  fileList: null,
  edit: null,
  stat: null,
  diff: null,
  diffs: null,
  code: null,
  codePath: null,
  image: null,
  web: null,
};

/**
 * `auroro_websearch` — a results page or one fetched document.
 *
 * Returns `null` for a failed call so the card falls through to its normal
 * error path: the tool's own message ("… returned 404 Not Found — the page is
 * gone") is more use than an empty results panel.
 */
function parseWebResult(parsed: Record<string, unknown>): WebData | null {
  if (parsed.success === false) return null;

  const search = rec(parsed.search);
  if (search) {
    const hits = (asArr(search.results) ?? []).flatMap((raw): WebHit[] => {
      const hit = rec(raw);
      const url = asStr(hit?.url);
      if (!hit || !url) return [];
      return [
        {
          rank: asNum(hit.rank) ?? 0,
          title: asStr(hit.title) || url,
          url,
          displayUrl: asStr(hit.displayUrl),
          snippet: asStr(hit.snippet),
        },
      ];
    });
    // A back end that answered only after another failed is worth showing —
    // it explains a thinner set of results than usual.
    const fallbacks = asArr(search.fallbacks) ?? [];
    return {
      kind: "search",
      heading: asStr(search.query) ?? "",
      source: asStr(search.engine),
      hits,
      note:
        fallbacks.length > 0
          ? `${fallbacks.length === 1 ? "One other source" : `${fallbacks.length} other sources`} returned nothing first.`
          : undefined,
    };
  }

  const document = rec(parsed.document);
  if (document) {
    const url = asStr(document.finalUrl) ?? asStr(document.url) ?? "";
    return {
      kind: "document",
      heading: asStr(document.title) || hostOf(url) || url,
      source: url,
      content: asStr(document.content) ?? "",
      documentKind: asStr(document.kind),
      totalChars: asNum(document.totalChars),
      offset: asNum(document.offset),
      hasMore: document.hasMore === true,
      note: asStr(document.note),
    };
  }

  return null;
}

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

  // Images — handled FIRST (before the non-JSON fallback) so the raw
  // `<aurora_image>…base64…` block a reloaded thread carries renders as a
  // picture, never as a dumped base64 blob. Covers both the lean JSON (live)
  // and raw (persisted) shapes, for a captured page and for a file that was
  // read alike.
  //
  // The gate is the SHAPE of the result, not the tool that produced it. A
  // `file_read` that opened ONE picture reaches the live UI as the same lean
  // `{ screenshot: … }` envelope a capture does — no marker survives in it —
  // so a name-only gate dropped it through to the code fallback and printed
  // the envelope as raw JSON where the picture belonged.
  if (name === "browser_screenshot" || hasImageMarker(result) || !!rec(parsed?.screenshot)) {
    const images = (parseImageResults(parsed, result) ?? []).filter(
      (image) => image.path || image.base64,
    );
    if (images.length > 0) {
      // A read that named several files appends its inventory as JSON after the
      // pictures. Recovering it lets the images and the source files share ONE
      // file list and one selection — the card shows the file you clicked,
      // instead of stacking every picture down the page and dropping the text.
      const inventory = trailingEnvelope(result);
      const rows = inventory ? filesToEntries(asArr(inventory.files) ?? [], false) : [];

      if (rows.length > 0 || images.length > 1) {
        out.multiFile = mergeImagesIntoFiles(rows, images);
        out.summary = `${images.length} ${images.length === 1 ? "image" : "images"}`;
        return out;
      }

      // One picture and nothing else: a capture, or a single opened image.
      const [image] = images;
      out.image = image;
      const host = hostOf(image.url);
      // A made picture is not described by its file name — that is Aurora's
      // sequence number plus a slug of the prompt, and the prompt is already
      // on the card's header. Where it went is the news. (The marker's
      // dimensions are the vision-sized copy's, so they are not quoted.)
      out.summary =
        name === "generate_image"
          ? "Saved to Canvas"
          : host
            ? `Captured ${host}`
            : image.name
              ? baseName(image.name)
              : "Captured screenshot";
      return out;
    }
  }

  // Web search / page fetch. Placed before the generic branches because both
  // shapes carry a `content` key that the code fallback would otherwise dump
  // as raw JSON.
  if (parsed && name === "auroro_websearch") {
    const web = parseWebResult(parsed);
    if (web) {
      out.web = web;
      out.summary =
        web.kind === "search"
          ? `${web.hits?.length ?? 0} ${web.hits?.length === 1 ? "result" : "results"}`
          : (hostOf(web.source) ?? "Fetched page");
      return out;
    }
  }

  // Non-JSON (plain text, error sentinel, truncated) → text fallback.
  if (!parsed) {
    if (recoverTruncatedRead(out, name, args, result)) return out;
    if (recoverTruncatedWorkspaceTree(out, name, result)) return out;

    const argumentDiffs = editDiffsFromArgs(args);
    if (argumentDiffs.length > 1) {
      out.diffs = argumentDiffs;
      out.edit = null;
      return out;
    }
    if (argumentDiffs.length === 1) {
      out.diff = argumentDiffs[0];
      out.edit = null;
      return out;
    }
    if ((name === "file_write" || name === "file_create") && out.edit?.added) {
      out.code = out.edit.added;
      out.codePath = asStr(args.path) ?? asStr(args.file_path) ?? null;
      out.edit = null;
      return out;
    }
    if (!FILE_MODIFY_TOOLS.has(name)) out.code = clean(result);
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
      const fileAdded = asNum(o.linesAdded);
      const fileRemoved = asNum(o.linesRemoved);
      added += fileAdded ?? 0;
      removed += fileRemoved ?? 0;
      const fo = o.oldContent;
      const fn = o.newContent;
      if (typeof fo === "string" && typeof fn === "string") {
        const oldSide = splitHistoryTruncation(fo);
        const newSide = splitHistoryTruncation(fn);
        diffs.push({
          oldText: oldSide.text,
          newText: newSide.text,
          path: asStr(o.path),
          fullPath: asStr(o.fullPath),
          added: fileAdded,
          removed: fileRemoved,
          truncated: oldSide.truncated || newSide.truncated || undefined,
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
    const oldSide = splitHistoryTruncation(oldC);
    const newSide = splitHistoryTruncation(newC);
    out.diff = {
      oldText: oldSide.text,
      newText: newSide.text,
      path: asStr(parsed.path) ?? asStr(args.path) ?? asStr(args.file_path),
      fullPath: asStr(parsed.fullPath),
      truncated: oldSide.truncated || newSide.truncated || undefined,
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
      shell: asStr(parsed.shell) ?? asStr(args.shell),
      shellNote: asStr(parsed.shellNote),
    };
    // Surface the exit code on the COLLAPSED row for failures — "exit 1" is
    // the single most useful fact before deciding whether to expand.
    out.summary = success
      ? "Ran command"
      : typeof exit === "number"
        ? `Command failed · exit ${exit}`
        : "Command failed";
    return out;
  }

  // Batch reads now flow through `file_read` (paths form), which returns
  // the same `files` payload the old `multi_file_read` did.
  if ((name === "multi_file_read" || name === "file_read") && parsed.files) {
    const entries = filesToEntries(asArr(parsed.files) ?? [], parsed.historyTruncated === true);
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
        ? {
            filesRead: asNum(stats.filesRead),
            filesSkipped: asNum(stats.filesSkipped),
            nodesReturned: asNum(stats.nodesReturned),
            nodesDiscovered: asNum(stats.nodesDiscovered),
          }
        : undefined,
      truncated: parsed.truncated === true,
      note: asStr(parsed.note),
    };
    const fileCount = asNum(stats?.filesRead);
    out.summary = fileCount !== undefined ? `${fileCount} files` : null;
    return out;
  }

  // `glob` before the generic file-list paths below: it also returns a `files`
  // array, but the paths are the answer (not decoration on a basename), and it
  // carries a true total plus a recovery note that a flat list would discard.
  if (name === "glob" && Array.isArray(parsed.files)) {
    const files = (asArr(parsed.files) ?? [])
      .map((p) => asStr(p))
      .filter((p): p is string => !!p);
    const total = asNum(parsed.count) ?? files.length;
    out.glob = {
      files,
      pattern: asStr(parsed.pattern) ?? asStr(args.pattern) ?? undefined,
      total,
      truncated: parsed.truncated === true,
      note: asStr(parsed.note) ?? undefined,
    };
    out.summary =
      total === 0
        ? "No matches"
        : `${total} ${total === 1 ? "file" : "files"}`;
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
  // Results persisted before the tools reported counts still carry the full
  // before/after — derive the header's −x/+y from it so a reloaded thread
  // shows the same numbers a live one does. Skipped when history clamped a
  // side: counting a truncated diff would state a wrong number as fact.
  if (out.diff && !out.diff.truncated) {
    const derived = computeDiff(out.diff.oldText, out.diff.newText);
    if (derived.added || derived.removed) {
      out.stat = { added: derived.added, removed: derived.removed };
      return out;
    }
  }

  // The user's terminals. Both render like every other tool: a plain summary on
  // the row, the real content in the dropdown — never a raw JSON dump.
  if (name === "terminal_list") {
    const terminals = Array.isArray(parsed.terminals) ? parsed.terminals : [];
    out.summary =
      terminals.length === 0
        ? "No terminal open"
        : `${terminals.length} open`;
    if (terminals.length > 0) {
      out.code = terminals
        .map(rec)
        .filter((t): t is Record<string, unknown> => Boolean(t))
        .map((t) => {
          const title = asStr(t.title) ?? asStr(t.id) ?? "terminal";
          const where = asStr(t.cwd) ?? "";
          const state = t.running === false ? " (exited)" : "";
          return where ? `${title}${state}  ${where}` : `${title}${state}`;
        })
        .join("\n");
    }
    return out;
  }

  if (name === "terminal_read") {
    if (parsed.success === false) {
      out.summary = asStr(parsed.error) ?? "Terminal not found";
      return out;
    }
    const title = asStr(parsed.title) ?? asStr(args.id) ?? "terminal";
    const lines = asNum(parsed.totalLines);
    // Says WHICH terminal and how much came back — the two things a reader
    // wants without expanding. The scope is named in words, not as the enum.
    const scope = parsed.scope === "all" ? "full scrollback" : "last command";
    out.summary =
      lines === undefined ? `${title} — ${scope}` : `${title} — ${scope}, ${lines} lines`;
    const text = asStr(parsed.text);
    if (text) out.code = text;
    return out;
  }

  // `code` — one tool, five questions, so the row has to say WHICH answer came
  // back. Without this it fell through to the generic "Done", which tells the
  // reader nothing and makes an expanded card show only the arguments.
  if (name === "code") {
    const op = asStr(parsed.op) ?? asStr(args.op) ?? "";
    const rows = (key: string): Record<string, unknown>[] =>
      Array.isArray(parsed[key])
        ? (parsed[key] as unknown[])
            .map(rec)
            .filter((r): r is Record<string, unknown> => Boolean(r))
        : [];
    const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

    if (op === "definition") {
      const defs = rows("definitions");
      const first = defs[0];
      out.summary = defs.length === 0
        ? "Not defined here"
        : defs.length === 1 && first
          ? `${asStr(first.file) ?? "?"}:${asNum(first.line) ?? "?"}`
          : plural(defs.length, "definition");
      if (defs.length > 0) {
        out.code = defs
          .map((d) => `${asStr(d.kind) ?? ""} ${asStr(d.symbol) ?? ""}\n  ${asStr(d.file) ?? ""}:${asNum(d.line) ?? ""}`)
          .join("\n");
      }
      return out;
    }

    if (op === "usages") {
      if (parsed.resolved === false) {
        const candidates = rows("candidates");
        out.summary = candidates.length > 0 ? `${plural(candidates.length, "candidate")} — ambiguous` : "No answer";
        if (candidates.length > 0) {
          out.code = candidates
            .map((c) => `${asStr(c.symbol) ?? ""}  (${asNum(c.callers) ?? 0} callers)\n  ${asStr(c.file) ?? ""}:${asNum(c.line) ?? ""}`)
            .join("\n");
        }
        return out;
      }
      const total = asNum(parsed.totalUsages) ?? 0;
      const files = asNum(parsed.acrossFiles);
      out.summary = total === 0
        ? "Nothing uses it"
        : `${plural(total, "use")}${files ? ` · ${plural(files, "file")}` : ""}`;
      const lines: string[] = [];
      for (const c of rows("coupling")) {
        lines.push(`${asNum(c.count) ?? 0}  ${asStr(c.kind) ?? ""}`);
      }
      if (lines.length > 0) lines.push("");
      for (const u of rows("usedBy")) {
        lines.push(`${asStr(u.caller) ?? ""}  ×${asNum(u.count) ?? 1}`);
      }
      if (lines.length > 0) out.code = lines.join("\n");
      return out;
    }

    if (op === "outline") {
      const symbols = asNum(parsed.symbols) ?? 0;
      out.summary = symbols === 0 ? "No symbols" : plural(symbols, "symbol");
      const items = rows("outline");
      if (items.length > 0) {
        out.code = items
          .map((s) => `${String(asNum(s.line) ?? "").padStart(5)}  ${asStr(s.kind) ?? ""} ${asStr(s.symbol) ?? ""}`)
          .join("\n");
        out.codePath = asStr(args.path) ?? null;
      }
      return out;
    }

    if (op === "modules") {
      const groups = asNum(parsed.groups) ?? 0;
      const cycles = rows("cycles");
      out.summary = `${plural(groups, "group")}${cycles.length > 0 ? ` · ${plural(cycles.length, "cycle")}` : ""}`;
      const lines = rows("mostDependedOn").map(
        (n) => `in ${String(asNum(n.fanIn) ?? 0).padStart(4)}  out ${String(asNum(n.fanOut) ?? 0).padStart(4)}   ${asStr(n.name) ?? ""}`,
      );
      for (const c of cycles) {
        const members = Array.isArray(c.members) ? (c.members as unknown[]).map(String) : [];
        lines.push(`cycle: ${members.join(" → ")}`);
      }
      if (lines.length > 0) out.code = lines.join("\n");
      return out;
    }

    if (op === "refresh") {
      const files = asNum(parsed.files) ?? 0;
      const ms = asNum(parsed.buildMs);
      out.summary = `${plural(files, "file")}${ms !== undefined ? ` · ${ms} ms` : ""}`;
      return out;
    }
  }

  const message = asStr(parsed.message);
  if (message) {
    const targetPaths = [
      asStr(parsed.path),
      asStr(parsed.fullPath),
      asStr(args.path),
      asStr(args.file_path),
    ].filter((path): path is string => Boolean(path));
    out.summary = targetPaths.some((path) => message.includes(path))
      ? null
      : message.length > 60
        ? "Done"
        : message;
    return out;
  }
  if (parsed.success === true) {
    out.summary = "Done";
    return out;
  }

  // A structured failure nothing above claimed. Show the tool's own sentence —
  // it names the file and the recovery step, which is the whole value of the
  // card. Falling through to the JSON dump below meant a refusal rendered as a
  // wall of braces the reader had to decode.
  if (parsed.success === false) {
    const error = asStr(parsed.error);
    const hint = asStr(parsed.hint);
    out.summary = error ?? "Failed";
    out.code = [error, hint].filter(Boolean).join("\n\n") || null;
    return out;
  }

  // Last resort: pretty-print the object so it's at least readable.
  if (!out.edit) out.code = clean(JSON.stringify(parsed, null, 2));
  return out;
}

export { baseName };
