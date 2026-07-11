/**
 * Agent Window — read-only file viewer [view].
 *
 * The Files tab's leaf surface. Per the agent-window vision the agent window
 * NEVER edits in place — it shows a file read-only and hands editing off to the
 * IDE ("Open in IDE"). It is, however, a FULL preview surface, not a raw dump:
 *
 *  - Images render natively (Tauri asset protocol) with fit / actual-size zoom
 *    and a dimensions readout — never a "can't preview" placeholder.
 *  - Markdown renders as RICH preview by default (the same engine as the chat),
 *    with a Preview / Raw toggle since the file isn't editable here.
 *  - Everything else is Shiki-highlighted source with a line-number gutter.
 *
 * Guards keep it robust on a real repo: oversized files and non-text/binary
 * extensions short-circuit to a friendly "open in IDE" note instead of dumping
 * garbage or janking the main thread.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

import { convertFileSrc } from "@tauri-apps/api/core";

import { isTauri, readFileContent } from "../../lib/tauri";
import { AgentIcon } from "../shared/AgentIcon";
import { FileIcon } from "../../components/explorer/FileIcons";
import {
  extToShikiLang,
  useShikiTokens,
  type ShikiThemeVariant,
} from "../../components/chat/useShikiTokens";
import { AgentMarkdown } from "./AgentMarkdown";
import { openInIde } from "../adapters/open-in-ide";
import { selectActiveAgentTheme, useAgentThemeStore } from "../store/useAgentThemeStore";

/** Bytes past which we refuse inline preview (Shiki janks; viewer scroll lags). */
const MAX_VIEW_BYTES = 1.5 * 1024 * 1024; // 1.5 MiB

/** Raster/vector images the webview can paint directly via the asset protocol. */
const IMAGE_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg",
]);

/** Markdown flavours that render as rich preview. */
const MARKDOWN_EXT = new Set(["md", "markdown", "mdown", "mkdn", "mkd", "mdx"]);

/** Extensions we know are not source text AND can't be previewed inline. */
const BINARY_EXT = new Set([
  "tiff", "icns", "psd", "sketch", "fig",
  "pdf", "zip", "gz", "tar", "rar", "7z", "exe", "dll", "so", "dylib", "bin",
  "wasm", "class", "jar", "mp3", "wav", "flac", "ogg", "mp4", "mov", "avi",
  "mkv", "webm", "woff", "woff2", "ttf", "otf", "eot",
  "db", "sqlite", "node",
]);

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

const Centered: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      flex: 1,
      minHeight: 0,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      padding: 28,
      textAlign: "center",
    }}
  >
    {children}
  </div>
);

/** Highlighted (or plain) file body with a line-number gutter. */
const CodeBody: React.FC<{ content: string; lang: string | null; variant: ShikiThemeVariant }> = ({
  content,
  lang,
  variant,
}) => {
  const tokens = useShikiTokens(content, lang, variant);
  const lines = useMemo(() => content.replace(/\n$/, "").split("\n"), [content]);

  return (
    <div className="agw-fv-code agw-scroll">
      <div className="agw-fv-gutter" aria-hidden="true">
        {lines.map((_, i) => (
          <div key={i} className="agw-fv-ln">
            {i + 1}
          </div>
        ))}
      </div>
      <pre className="agw-fv-pre">
        <code>
          {tokens
            ? tokens.map((line, i) => (
                <span key={i} className="agw-fv-line">
                  {line.length === 0 ? (
                    "\n"
                  ) : (
                    <>
                      {line.map((tok, j) => (
                        <span key={j} style={{ color: tok.color }}>
                          {tok.content}
                        </span>
                      ))}
                      {"\n"}
                    </>
                  )}
                </span>
              ))
            : lines.map((line, i) => (
                <span key={i} className="agw-fv-line">
                  {line}
                  {"\n"}
                </span>
              ))}
        </code>
      </pre>
    </div>
  );
};

/** Rendered markdown preview (same engine as the chat), in a centered column. */
const MarkdownBody: React.FC<{ content: string }> = ({ content }) => (
  <div className="agw-fv-mdwrap agw-scroll">
    <div className="agw-fv-mdinner">
      <AgentMarkdown content={content} />
    </div>
  </div>
);

/** Native image preview: fit-to-view by default, click toggles actual size. */
const ImageBody: React.FC<{ path: string; name: string }> = ({ path, name }) => {
  const [dim, setDim] = useState<{ w: number; h: number } | null>(null);
  const [actual, setActual] = useState(false);
  const [errored, setErrored] = useState(false);

  const src = useMemo(() => (isTauri() ? convertFileSrc(path) : path), [path]);

  // Each file opens as its OWN dock tab (keyed remount in RightDock), so `path`
  // is stable for this instance's life — transient state needs no manual reset.

  if (errored) {
    return (
      <Centered>
        <FileIcon name={name} path={path} className="agw-fv-bigicon" />
        <div style={{ fontSize: 13, color: "var(--agw-text-muted)", fontWeight: 600 }}>
          Couldn't load this image
        </div>
        <div style={{ fontSize: 12, color: "var(--agw-text-subtle)", maxWidth: 240 }}>
          Open it in the IDE to view it full size.
        </div>
        <button type="button" className="agw-fv-openide" onClick={() => void openInIde(path)}>
          <AgentIcon name="external" size={13} />
          <span>Open in IDE</span>
        </button>
      </Centered>
    );
  }

  return (
    <div className="agw-fv-imagewrap agw-scroll">
      <img
        className="agw-fv-image"
        data-actual={actual || undefined}
        src={src}
        alt={name}
        draggable={false}
        onLoad={(e) =>
          setDim({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
        }
        onError={() => setErrored(true)}
        onClick={() => setActual((a) => !a)}
        title={actual ? "Click to fit" : "Click to view actual size"}
      />
      {dim && (
        <div className="agw-fv-imagemeta">
          {dim.w} × {dim.h}
        </div>
      )}
    </div>
  );
};

/** Placeholder for files that can't be shown inline (binary / oversized). */
const BinaryNote: React.FC<{ path: string; name: string }> = ({ path, name }) => (
  <Centered>
    <FileIcon name={name} path={path} className="agw-fv-bigicon" />
    <div style={{ fontSize: 13, color: "var(--agw-text-muted)", fontWeight: 600 }}>
      Can't preview this file here
    </div>
    <div style={{ fontSize: 12, color: "var(--agw-text-subtle)", maxWidth: 240 }}>
      It's a binary or oversized file. Open it in the IDE to view or edit.
    </div>
    <button type="button" className="agw-fv-openide" onClick={() => void openInIde(path)}>
      <AgentIcon name="external" size={13} />
      <span>Open in IDE</span>
    </button>
  </Centered>
);

export const FileViewer: React.FC<{
  /** Absolute path of the file to show. */
  path: string;
  /** Display name (basename). */
  name: string;
  /** Path shown in the header relative to the root (for the breadcrumb). */
  rel?: string;
  /** Optional "back" affordance (only when shown as a drill-in, not a tab). */
  onBack?: () => void;
}> = ({ path, name, rel, onBack }) => {
  const appearance = useAgentThemeStore((s) => selectActiveAgentTheme(s).appearance);
  const syntaxOn = useAgentThemeStore((s) => s.syntaxHighlighting);
  const variant: ShikiThemeVariant = appearance === "light" ? "light" : "dark";

  const ext = useMemo(() => extOf(name), [name]);
  const lang = useMemo(() => (syntaxOn ? extToShikiLang(ext) : null), [ext, syntaxOn]);
  const isMarkdown = MARKDOWN_EXT.has(ext);

  // Classify purely from the extension during render. `path` is stable for this
  // instance (each file is its own keyed dock tab in RightDock), so image and
  // binary need no state at all — only the async text read does.
  const mode: "image" | "binary" | "text" = IMAGE_EXT.has(ext)
    ? "image"
    : BINARY_EXT.has(ext)
      ? "binary"
      : "text";

  const [text, setText] = useState<
    | { kind: "loading" }
    | { kind: "ready"; content: string }
    | { kind: "unsupported" }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  // Markdown renders as rich preview by default (it isn't editable here); the
  // toggle lets you drop to the raw source. Non-markdown ignores this.
  const [mdRaw, setMdRaw] = useState(false);

  const reqId = useRef(0);

  // Read the bytes for text files. The effect body calls no setState directly
  // (only its async callbacks do), so a fresh instance starts on "loading" from
  // the initializer and settles once the read resolves.
  useEffect(() => {
    if (mode !== "text") return;
    const id = ++reqId.current;
    void readFileContent(path)
      .then((content) => {
        if (id !== reqId.current) return;
        // Oversized, or a NUL byte (never present in source text) -> unviewable.
        if (content.length > MAX_VIEW_BYTES || content.includes(String.fromCharCode(0))) {
          setText({ kind: "unsupported" });
          return;
        }
        setText({ kind: "ready", content });
      })
      .catch((err) => {
        if (id !== reqId.current) return;
        setText({ kind: "error", message: String(err?.message ?? err) });
      });
  }, [mode, path]);

  // The markdown toggle only makes sense once we have text to show.
  const showMdToggle = isMarkdown && mode === "text" && text.kind === "ready";

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* Header: back · breadcrumb · [md toggle] · open-in-IDE */}
      <div className="agw-fv-head">
        {onBack && (
          <button type="button" className="agw-fv-back" onClick={onBack} title="Back to files" aria-label="Back to files">
            <span style={{ display: "inline-flex", transform: "rotate(90deg)" }}>
              <AgentIcon name="chevron-down" size={15} />
            </span>
          </button>
        )}
        <FileIcon name={name} path={path} className="agw-file-ico" />
        <span className="agw-fv-crumb">
          {rel && rel !== name && (
            <span className="agw-fv-crumb-dir">{rel.slice(0, rel.length - name.length)}</span>
          )}
          <span className="agw-fv-crumb-name">{name}</span>
        </span>
        <span style={{ flex: 1 }} />

        {showMdToggle && (
          <div className="agw-fv-seg" role="group" aria-label="Markdown view">
            <button
              type="button"
              data-active={!mdRaw || undefined}
              onClick={() => setMdRaw(false)}
              title="Rendered preview"
            >
              Preview
            </button>
            <button
              type="button"
              data-active={mdRaw || undefined}
              onClick={() => setMdRaw(true)}
              title="Raw source"
            >
              Raw
            </button>
          </div>
        )}

        <button
          type="button"
          className="agw-fv-openide"
          onClick={() => void openInIde(path)}
          title="Open in the IDE editor to make changes"
        >
          <AgentIcon name="external" size={13} />
          <span>Open in IDE</span>
        </button>
      </div>

      {/* Body */}
      {mode === "image" && <ImageBody path={path} name={name} />}
      {mode === "binary" && <BinaryNote path={path} name={name} />}
      {mode === "text" && (
        <>
          {text.kind === "loading" && (
            <Centered>
              <div className="agw-fv-spinner" />
              <div style={{ fontSize: 12.5, color: "var(--agw-text-subtle)" }}>Loading…</div>
            </Centered>
          )}
          {text.kind === "ready" &&
            (isMarkdown && !mdRaw ? (
              <MarkdownBody content={text.content} />
            ) : (
              <CodeBody content={text.content} lang={lang} variant={variant} />
            ))}
          {text.kind === "unsupported" && <BinaryNote path={path} name={name} />}
          {text.kind === "error" && (
            <Centered>
              <AgentIcon name="close" size={20} style={{ color: "var(--agw-removed)" }} />
              <div style={{ fontSize: 13, color: "var(--agw-text-muted)", fontWeight: 600 }}>
                Couldn't open this file
              </div>
              <div style={{ fontSize: 12, color: "var(--agw-text-subtle)", maxWidth: 260, wordBreak: "break-word" }}>
                {text.message}
              </div>
            </Centered>
          )}
        </>
      )}
    </div>
  );
};
