/**
 * Agent Window — the folder and file picker in a browser [view].
 *
 * The desktop window uses the OS dialog. A browser tab cannot show one for
 * paths on the machine Aurora runs on, so `openFileDialog` resolves through
 * this instead (registered with `setWebFilePicker` while the agent window is
 * mounted in a browser). It is the command center's dialog, not a second
 * design: the same search field, grouped rows, keyboard and footer.
 *
 * - Empty field: recent projects (picking a folder; same order as the rail),
 *   then Home and the drives.
 * - Text without a path: filters the recent projects.
 * - A path (`E:\`, `C:\Users\…`, `/home/…`): browses it. The first row opens
 *   the folder typed; the next rows are its subfolders (and files, when
 *   choosing a file), narrowed by the part after the last separator. Enter on
 *   a folder goes into it; Enter on "Open …" or a recent project picks it.
 *
 * Folders are read through `read_directory`, the same command the explorer
 * uses, and the drives through `list_filesystem_roots`.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { fuzzyCommandScore } from "@/apps/agent/lib/command/command-search";
import {
  compactParentPath,
  folderName,
  loadPinnedProjects,
  loadProjectSort,
  orderProjects,
} from "@/apps/agent/lib/workspace/project-order";
import { AgentIcon, type AgentIconName } from "@/apps/agent/shared/AgentIcon";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { auroraInvoke, isDesktopRuntime } from "@/kernel/lib/ipc/runtime";
import { readDirectory } from "@/kernel/lib/ipc/tauri";
import {
  matchesPickerFilters,
  setWebFilePicker,
  type WebFilePickerRequest,
} from "@/kernel/lib/ipc/web-file-picker";

interface Roots {
  home: string | null;
  roots: string[];
}

interface Pending {
  request: WebFilePickerRequest;
  resolve: (path: string | null) => void;
}

interface Row {
  id: string;
  group: string;
  icon: AgentIconName;
  title: string;
  subtitle?: string;
  /** `pick` returns the path; `browse` puts it in the field. */
  action: { kind: "pick"; path: string } | { kind: "browse"; path: string };
}

/** One folder's contents; the field is "reading" while its `dir` is not this one. */
interface Listing {
  dir: string;
  entries: { name: string; path: string; isDir: boolean }[];
  error: string | null;
}

const SEPARATOR = /[\\/]/;

/** Does the field hold a path (drive, root, or home-relative)? */
const looksLikePath = (text: string): boolean =>
  /^[A-Za-z]:/.test(text) || text.startsWith("/") || text.startsWith("\\") || text.startsWith("~");

/** The folder to list for `text`, and the part after it that narrows the list. */
const splitPath = (text: string): { dir: string; filter: string } => {
  const cut = Math.max(text.lastIndexOf("\\"), text.lastIndexOf("/"));
  if (cut < 0) return { dir: text, filter: "" };
  const head = text.slice(0, cut + 1);
  return { dir: /^[A-Za-z]:$/.test(head) ? `${head}\\` : head, filter: text.slice(cut + 1) };
};

const withSeparator = (path: string): string =>
  SEPARATOR.test(path.slice(-1)) ? path : `${path}${path.includes("/") && !path.includes("\\") ? "/" : "\\"}`;

const stripSeparator = (path: string): string =>
  /^[A-Za-z]:[\\/]?$/.test(path) || path === "/" ? path : path.replace(/[\\/]+$/, "");

export const WebFilePickerHost: React.FC = () => {
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    if (isDesktopRuntime()) return;
    return setWebFilePicker(
      (request) =>
        new Promise<string | null>((resolve) => {
          setPending((previous) => {
            previous?.resolve(null);
            return { request, resolve };
          });
        }),
    );
  }, []);

  const finish = useCallback(
    (path: string | null) => {
      pending?.resolve(path);
      setPending(null);
    },
    [pending],
  );

  if (!pending) return null;
  return <WebFilePickerDialog request={pending.request} onDone={finish} />;
};

const WebFilePickerDialog: React.FC<{
  request: WebFilePickerRequest;
  onDone: (path: string | null) => void;
}> = ({ request, onDone }) => {
  const knownProjects = useAgentChatStore((s) => s.knownProjects);
  const allThreads = useAgentChatStore((s) => s.allThreads);
  const projectRoot = useAgentChatStore((s) => s.projectRoot);
  const [roots, setRoots] = useState<Roots>({ home: null, roots: [] });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [listing, setListing] = useState<Listing | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
    let cancelled = false;
    void auroraInvoke<Roots>("list_filesystem_roots")
      .then((found) => {
        if (!cancelled) setRoots(found);
      })
      .catch((error: unknown) => console.warn("[web-file-picker] could not list drives", error));
    return () => {
      cancelled = true;
    };
  }, []);

  const browsing = looksLikePath(query);
  const { dir, filter } = splitPath(query);

  // Read the folder the field points into, once per folder.
  useEffect(() => {
    if (!browsing || !dir) return;
    if (listing?.dir === dir) return;
    let cancelled = false;
    void readDirectory(dir, { includeHidden: false })
      .then((found) => {
        if (cancelled) return;
        setListing({
          dir,
          entries: found.map((e) => ({ name: e.name, path: e.path, isDir: e.is_dir })),
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setListing({ dir, entries: [], error: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [browsing, dir, listing?.dir]);

  const recent = useMemo(
    () =>
      request.directory
        ? orderProjects({
            knownProjects,
            threads: allThreads,
            projectRoot,
            sortMode: loadProjectSort(),
            pinned: new Set(loadPinnedProjects()),
          })
        : [],
    [allThreads, knownProjects, projectRoot, request.directory],
  );

  const rows = useMemo<Row[]>(() => {
    if (browsing) {
      const out: Row[] = [];
      const typedFolder = filter === "" ? stripSeparator(dir) : null;
      if (request.directory && typedFolder && listing?.dir === dir && !listing.error) {
        out.push({
          id: `open:${typedFolder}`,
          group: "Open",
          icon: "check",
          title: `Open ${folderName(typedFolder) || typedFolder}`,
          subtitle: typedFolder,
          action: { kind: "pick", path: typedFolder },
        });
      }
      const needle = filter.toLowerCase();
      for (const entry of listing?.dir === dir ? listing.entries : []) {
        if (!entry.isDir && (request.directory || !matchesPickerFilters(entry.name, request))) continue;
        if (needle && !entry.name.toLowerCase().includes(needle)) continue;
        out.push({
          id: `entry:${entry.path}`,
          group: request.directory ? "Folders" : "In this folder",
          icon: entry.isDir ? "folder" : "file-read",
          title: entry.name,
          action: entry.isDir
            ? { kind: "browse", path: withSeparator(entry.path) }
            : { kind: "pick", path: entry.path },
        });
      }
      // Starts-with matches first, so typing "src" lands on `src` before `docs-src`.
      if (needle) {
        out.sort((a, b) => {
          if (a.group !== b.group) return a.group === "Open" ? -1 : b.group === "Open" ? 1 : 0;
          return (
            Number(!a.title.toLowerCase().startsWith(needle)) -
            Number(!b.title.toLowerCase().startsWith(needle))
          );
        });
      }
      return out.slice(0, 200);
    }

    const projects = recent
      .map((root) => ({
        root,
        score: fuzzyCommandScore(
          { title: folderName(root), subtitle: root, keywords: "project", group: "Recent projects" },
          query,
        ),
      }))
      .filter((entry) => entry.score >= 0)
      .map<Row>(({ root }) => ({
        id: `recent:${root}`,
        group: "Recent projects",
        icon: "folder",
        title: folderName(root),
        subtitle: compactParentPath(root) || root,
        action: { kind: "pick", path: root },
      }));
    const places: Row[] = query.trim()
      ? []
      : [
          ...(roots.home
            ? [{
                id: "place:home",
                group: "Places",
                icon: "home" as const,
                title: "Home",
                subtitle: roots.home,
                action: { kind: "browse" as const, path: withSeparator(roots.home) },
              }]
            : []),
          ...roots.roots.map<Row>((root) => ({
            id: `place:${root}`,
            group: "Places",
            icon: "folder",
            title: root.replace(/[\\/]$/, ""),
            subtitle: "Drive",
            action: { kind: "browse", path: root },
          })),
        ];
    return [...projects, ...places];
  }, [browsing, dir, filter, listing, query, recent, request, roots]);

  const activeIndex = rows.length === 0 ? 0 : Math.min(selected, rows.length - 1);

  useEffect(() => {
    resultsRef.current
      ?.querySelector<HTMLElement>("[data-selected]")
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, rows]);

  const run = (row: Row) => {
    if (row.action.kind === "pick") {
      onDone(row.action.path);
      return;
    }
    setQuery(row.action.path);
    setSelected(0);
    inputRef.current?.focus();
  };

  const portalTarget =
    typeof document !== "undefined"
      ? ((document.querySelector(".agw-root") as HTMLElement | null) ?? document.body)
      : null;
  if (!portalTarget) return null;

  const title = request.directory ? "Open a folder" : "Choose a file";
  const loading = browsing && listing?.dir !== dir;
  const failed = browsing && listing?.dir === dir ? listing.error : null;

  return createPortal(
    <div className="agw-command-overlay" role="presentation" onMouseDown={() => onDone(null)}>
      <section
        className="agw-command-center"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="agw-command-search">
          <AgentIcon name={browsing ? "folder" : "search"} size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onDone(null);
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                if (rows.length > 0) setSelected((value) => Math.min(rows.length - 1, value + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((value) => Math.max(0, value - 1));
              } else if (event.key === "Enter" && rows[activeIndex]) {
                event.preventDefault();
                run(rows[activeIndex]);
              } else if (event.key === "Tab" && rows[activeIndex]?.action.kind === "browse") {
                event.preventDefault();
                run(rows[activeIndex]);
              }
            }}
            placeholder={
              request.directory
                ? "Search recent projects, or type a folder path…"
                : "Type a folder path to look in…"
            }
            aria-label={
              request.directory ? "Search projects or type a folder path" : "Type a folder path"
            }
            aria-controls="agw-file-picker-results"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div
          id="agw-file-picker-results"
          ref={resultsRef}
          className="agw-command-results agw-scroll"
          role="listbox"
        >
          {rows.map((row, index) => {
            const showGroup = index === 0 || rows[index - 1].group !== row.group;
            return (
              <React.Fragment key={row.id}>
                {showGroup && <div className="agw-command-group">{row.group}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className="agw-command-item"
                  data-selected={index === activeIndex || undefined}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => run(row)}
                >
                  <span className="agw-command-icon"><AgentIcon name={row.icon} size={16} /></span>
                  <span className="agw-command-copy">
                    <span className="agw-command-title">{row.title}</span>
                    {row.subtitle && <span className="agw-command-subtitle">{row.subtitle}</span>}
                  </span>
                  {index === activeIndex && <kbd className="agw-command-enter">Enter</kbd>}
                </button>
              </React.Fragment>
            );
          })}
          {rows.length === 0 && (
            <div className="agw-command-empty">
              <AgentIcon name={failed ? "alert" : "search"} size={20} />
              <span>
                {loading
                  ? "Reading the folder…"
                  : failed
                    ? failed
                    : browsing
                      ? `Nothing in ${dir} matches “${filter}”.`
                      : `No recent project matches “${query}”. Type a path to browse.`}
              </span>
            </div>
          )}
        </div>
        <footer className="agw-command-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>Enter</kbd> {browsing ? "Open or go into" : "Open"}</span>
          <span><kbd>Esc</kbd> Close</span>
        </footer>
      </section>
    </div>,
    portalTarget,
  );
};

export default WebFilePickerHost;
