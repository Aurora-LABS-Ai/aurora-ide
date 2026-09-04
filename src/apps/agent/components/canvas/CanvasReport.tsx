/**
 * Agent Window — a research report on the Canvas [view].
 *
 * The other canvases are things you look at. A report is a thing you read down,
 * so it gets what a long document needs and a dashboard does not: a contents
 * strip that says where you are, citations that reach the source rather than
 * the bottom of the page, and prose that stays selectable.
 *
 * The body goes through the same Markdown renderer as the transcript, so code
 * fences, tables and lists behave exactly as they do everywhere else. What this
 * component adds around it is derived from the source on every render
 * (`report-document.ts`), which is why a patched report cannot end up with a
 * contents strip describing the version before it.
 */

import React, { useCallback, useMemo } from "react";

import { AgentIcon } from "@/apps/agent/shared";
import { AgentMarkdown } from "@/apps/agent/components/conversation/AgentMarkdown";
import { openExternalUrl } from "@/apps/agent/adapters/open-external";
import {
  CITE_SCHEME,
  parseReportDocument,
} from "@/apps/agent/services/artifacts/report-document";

interface CanvasReportProps {
  source: string;
  title: string;
  /**
   * The rendered body, held by the panel rather than by this component.
   *
   * Saving as PDF prints the markup that is on screen — the alternative is a
   * second Markdown-to-HTML path that would drift from this one — and the Save
   * controls live on the panel's toolbar with the rest of the artifact-level
   * actions. So the panel owns the handle.
   */
  bodyRef: React.RefObject<HTMLDivElement>;
}

export const CanvasReport: React.FC<CanvasReportProps> = ({ source, title, bodyRef }) => {
  const report = useMemo(() => parseReportDocument(source), [source]);

  const scrollToHeading = useCallback(
    (index: number) => {
      const body = bodyRef.current;
      if (!body) return;
      const heading = body.querySelectorAll<HTMLElement>("h2, h3")[index];
      heading?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [bodyRef],
  );

  /**
   * One handler for every link in the body, because none of them work on their
   * own: this is a webview, so an anchor that navigates replaces the product,
   * and a citation's href is our own `aurora-cite:` scheme that no browser
   * knows. Delegated rather than injected into the Markdown renderer, which is
   * shared with the transcript and should not grow a report-shaped special
   * case.
   */
  const onBodyClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const anchor = (event.target as HTMLElement | null)?.closest?.("a");
      const href = anchor?.getAttribute("href");
      if (!href) return;
      event.preventDefault();
      if (href.startsWith(CITE_SCHEME)) {
        const key = href.slice(CITE_SCHEME.length);
        const cited = report.sources.find((entry) => entry.key === key);
        if (cited?.href) void openExternalUrl(cited.href);
        return;
      }
      void openExternalUrl(href);
    },
    [report.sources],
  );

  return (
    <article className="agw-report agw-scroll" aria-label={`${title} report`}>
      {report.headings.length > 1 && (
        <nav className="agw-report-contents" aria-label="Contents">
          <span className="agw-report-contents-label">Contents</span>
          <ol>
            {report.headings.map((heading) => (
              <li key={`${heading.index}:${heading.text}`} data-level={heading.level}>
                <button type="button" onClick={() => scrollToHeading(heading.index)}>
                  {heading.text}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )}

      {/* `AgentMarkdown` renders its own `.agw-md` root inside this one, so the
          transcript's markdown rules apply here unchanged. */}
      <div className="agw-report-body" ref={bodyRef} onClick={onBodyClick}>
        <AgentMarkdown content={report.body} />
      </div>

      {report.sources.length > 0 && (
        <section className="agw-report-sources" aria-label="Sources">
          <h2>Sources</h2>
          <ol>
            {report.sources.map((entry) => (
              <li key={entry.key} value={entry.n}>
                {entry.href ? (
                  <button type="button" onClick={() => void openExternalUrl(entry.href!)}>
                    <span className="agw-report-source-label">{entry.label}</span>
                    <span className="agw-report-source-href">{entry.href}</span>
                    <AgentIcon name="external" size={12} />
                  </button>
                ) : (
                  // A source with no link is still a source — a book, an
                  // interview, a paper behind a wall. Saying so beats dropping
                  // it, and beats rendering a link that goes nowhere.
                  <span className="agw-report-source-label">{entry.label}</span>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </article>
  );
};
