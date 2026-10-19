/**
 * Agent Window — the reply language's links: one page worth opening (a card)
 * and where a claim came from (source chips) [view].
 *
 * Asked for from a ChatGPT reply Alvan pasted (2026-10-16): a card with the
 * site, a line about it, a badge and an open button, and a "Music & Voic… +1"
 * chip under a claim. Drawn the Aurora way: the card's quiet frame, no brand
 * favicon (fetching one would call out to a third party on every render —
 * the site's first letter stands in), one open action.
 *
 * Every address was checked to be http(s) by the parser, and opening goes
 * through `openExternalUrl` into the user's browser, never this webview.
 */

import React, { useState } from "react";

import { openExternalUrl } from "@/apps/agent/adapters/open-external";
import type { UiSource } from "@/apps/agent/lib/reply-layout/ui";
import { Field } from "./Field";

/** Open in the real browser; a plain click on the anchor would navigate the app. */
function open(event: React.MouseEvent, url: string) {
  event.preventDefault();
  void openExternalUrl(url);
}

const SiteMark: React.FC<{ host: string }> = ({ host }) => (
  <span className="agw-rl-site-mark" aria-hidden="true">
    {host.charAt(0).toUpperCase()}
  </span>
);

export const LinkCard: React.FC<{ title: string; source: UiSource; caption?: string; badge?: string }> = ({ title, source, caption, badge }) => (
  <div className="agw-rl agw-rl-link">
    <SiteMark host={source.host} />
    <div className="agw-rl-link-body">
      <a className="agw-rl-link-title" href={source.url} onClick={(e) => open(e, source.url)}>
        <Field text={title} />
        <span className="agw-rl-ext" aria-hidden="true">↗</span>
      </a>
      {caption && (
        <div className="agw-rl-link-caption">
          <Field text={caption} />
        </div>
      )}
      <div className="agw-rl-link-host">{source.host}</div>
    </div>
    {badge && (
      <span className="agw-rl-link-badge">
        <Field text={badge} />
      </span>
    )}
    <button type="button" className="agw-rl-link-open" onClick={(e) => open(e, source.url)} aria-label={`Open ${source.host} in your browser`}>
      Open
      <span className="agw-rl-ext" aria-hidden="true">↗</span>
    </button>
  </div>
);

/** Chips shown before "+N"; the rest open in place. */
const SHOWN_SOURCES = 3;

export const SourceChips: React.FC<{ sources: UiSource[] }> = ({ sources }) => {
  const [all, setAll] = useState(false);
  const shown = all ? sources : sources.slice(0, SHOWN_SOURCES);
  const hidden = sources.length - shown.length;
  return (
    <div className="agw-rl agw-rl-sources" role="list" aria-label="Sources">
      {shown.map((source, i) => (
        <a
          key={i}
          role="listitem"
          className="agw-rl-source"
          href={source.url}
          title={source.title ? `${source.title} — ${source.url}` : source.url}
          onClick={(e) => open(e, source.url)}
        >
          <SiteMark host={source.host} />
          <span className="agw-rl-source-name">{source.title ?? source.host}</span>
        </a>
      ))}
      {hidden > 0 && (
        <button type="button" className="agw-rl-source agw-rl-source-more" onClick={() => setAll(true)} aria-label={`Show ${hidden} more sources`}>
          +{hidden}
        </button>
      )}
    </div>
  );
};
