/**
 * Taking a report out of Aurora.
 *
 * Chat mode has no file access — that rule is about the MODEL. The user saving
 * their own document is a different act, and it goes through the OS save
 * dialog, so the destination is chosen by the person, not by the agent, and
 * nothing about it reaches the conversation.
 *
 * Two formats, for two different afterwards. **Markdown** is the source
 * verbatim, so the report stays editable and diffable and can be pasted into
 * anything. **PDF** is the read-only copy you send to someone who will not
 * open a Markdown file, so it is paginated, printed light, and carries the
 * contents and the sources as part of the document.
 */

import { saveFileDialog } from "@/kernel/lib/ipc/tauri";

export type ExportOutcome = "saved" | "cancelled" | "failed";

/**
 * A filename from a title. Windows refuses `\\ / : * ? " < > |` outright, and a
 * trailing dot or space produces a file that exists but cannot be opened.
 */
export function reportFileName(title: string, extension: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "");
  return `${cleaned || "report"}.${extension}`;
}

export async function saveReportMarkdown(
  title: string,
  source: string,
): Promise<ExportOutcome> {
  const path = await saveFileDialog({
    defaultPath: reportFileName(title, "md"),
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!path) return "cancelled";
  try {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(path, source);
    return "saved";
  } catch (error) {
    console.error("[report-export] could not write the Markdown file:", error);
    return "failed";
  }
}

/**
 * Print styles for the PDF copy.
 *
 * The panel is a dark surface in a narrow column; a page is white, wide and
 * paginated. Colours are forced rather than inherited because the report's own
 * markup carries theme tokens and syntax-highlighting colours chosen to sit on
 * a dark background — carried onto paper they range from low-contrast to
 * invisible.
 */
const PRINT_STYLES = `
  @page { margin: 18mm 16mm; }
  * { background: transparent !important; box-shadow: none !important; }
  html, body {
    margin: 0;
    background: #ffffff;
    color: #16181d;
    font: 11pt/1.55 "Georgia", "Times New Roman", serif;
  }
  h1, h2, h3, h4 {
    font-family: "Helvetica Neue", Arial, sans-serif;
    color: #0b0c0f;
    line-height: 1.25;
    page-break-after: avoid;
  }
  h1 { font-size: 20pt; margin: 0 0 4pt; }
  h2 { font-size: 14pt; margin: 20pt 0 6pt; }
  h3 { font-size: 12pt; margin: 14pt 0 4pt; }
  p, li { orphans: 3; widows: 3; }
  a { color: #16181d; text-decoration: none; }
  blockquote {
    margin: 12pt 0;
    padding-left: 10pt;
    border-left: 2pt solid #c8ccd4;
    color: #3a3f4a;
    font-style: italic;
  }
  pre, code {
    background: #f4f5f7 !important;
    color: #16181d !important;
    font-family: "Consolas", "Courier New", monospace;
    font-size: 9.5pt;
  }
  /* Syntax highlighting is inline colour chosen for a dark panel. */
  pre span, code span { color: inherit !important; }
  pre { padding: 8pt; border-radius: 3pt; page-break-inside: avoid; }
  table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  th, td { padding: 4pt 6pt; border: 0.5pt solid #c8ccd4; text-align: left; }
  img { max-width: 100%; page-break-inside: avoid; }
  figure { margin: 12pt 0; }
  .rp-contents { margin: 0 0 18pt; padding: 0 0 10pt; border-bottom: 0.5pt solid #c8ccd4; }
  .rp-contents-label,
  .rp-sources h2 { font-family: "Helvetica Neue", Arial, sans-serif; font-size: 9pt; letter-spacing: 0.08em; text-transform: uppercase; color: #6a707c; }
  .rp-contents ol, .rp-sources ol { margin: 6pt 0 0; padding-left: 16pt; }
  .rp-contents li { font-size: 10pt; }
  .rp-contents li[data-level="3"] { padding-left: 12pt; }
  .rp-sources { margin-top: 22pt; padding-top: 10pt; border-top: 0.5pt solid #c8ccd4; page-break-before: auto; }
  .rp-sources li { margin-bottom: 5pt; font-size: 9.5pt; }
  .rp-sources-href { display: block; color: #4a5060; font-family: "Consolas", monospace; font-size: 8.5pt; word-break: break-all; }
`;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export interface PrintableReport {
  title: string;
  /** The body as it is rendered on screen — markup, not Markdown. */
  bodyHtml: string;
  headings: Array<{ level: 2 | 3; text: string }>;
  sources: Array<{ n: number; label: string; href: string | null }>;
}

/** The complete print document, as a string. Exported so a test can read it. */
export function buildPrintableDocument(report: PrintableReport): string {
  const contents =
    report.headings.length > 1
      ? `<nav class="rp-contents"><div class="rp-contents-label">Contents</div><ol>${report.headings
          .map(
            (heading) =>
              `<li data-level="${heading.level}">${escapeHtml(heading.text)}</li>`,
          )
          .join("")}</ol></nav>`
      : "";

  const sources =
    report.sources.length > 0
      ? `<section class="rp-sources"><h2>Sources</h2><ol>${report.sources
          .map(
            (entry) =>
              `<li value="${entry.n}">${escapeHtml(entry.label)}${
                entry.href
                  ? `<span class="rp-sources-href">${escapeHtml(entry.href)}</span>`
                  : ""
              }</li>`,
          )
          .join("")}</ol></section>`
      : "";

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(
    report.title,
  )}</title><style>${PRINT_STYLES}</style></head><body>${contents}<main>${
    report.bodyHtml
  }</main>${sources}</body></html>`;
}

/**
 * Hand the report to the OS print dialog, where "Save as PDF" is a destination.
 *
 * Aurora writes no PDF of its own. Doing so means either a PDF library and a
 * second layout engine to keep in step with this one, or a Rust renderer that
 * would have to be taught the same typography — and the webview under the app
 * already lays this document out correctly and can print it. What the user sees
 * in the preview is what the panel rendered.
 *
 * The frame is off-screen rather than hidden: `display: none` has no layout, so
 * a page printed from it comes out blank.
 */
export async function printReport(report: PrintableReport): Promise<ExportOutcome> {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("title", `${report.title} print copy`);
  // A4 at 96dpi, so the preview paginates the way the page will.
  frame.style.cssText =
    "position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0;";
  document.body.appendChild(frame);

  const remove = () => {
    if (frame.parentNode) frame.parentNode.removeChild(frame);
  };

  try {
    const doc = frame.contentDocument;
    const view = frame.contentWindow;
    if (!doc || !view) {
      remove();
      return "failed";
    }
    doc.open();
    doc.write(buildPrintableDocument(report));
    doc.close();

    // Images and web fonts are still arriving when `close()` returns, and a
    // print started before they land prints the gaps.
    await new Promise<void>((resolve) => {
      if (doc.readyState === "complete") {
        resolve();
        return;
      }
      view.addEventListener("load", () => resolve(), { once: true });
      window.setTimeout(resolve, 1500);
    });

    view.addEventListener("afterprint", () => window.setTimeout(remove, 0), { once: true });
    // The dialog is the user's; if it never reports back (dismissed in a way the
    // event misses) the frame still goes away rather than accumulating.
    window.setTimeout(remove, 120_000);
    view.focus();
    view.print();
    return "saved";
  } catch (error) {
    console.error("[report-export] could not print:", error);
    remove();
    return "failed";
  }
}
