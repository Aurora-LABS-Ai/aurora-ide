/**
 * Agent Window — find in page.
 *
 * Its own row under the toolbar, like a browser's find bar; the page moves
 * down to make room rather than being covered. Matches are painted in the
 * page by `lib/browser/find-in-page.ts` without touching the page's DOM.
 *
 * Enter / Shift+Enter step through matches, Escape closes, and closing clears
 * every highlight.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import { clearFindScript, findScript, type FindResult } from "@/apps/agent/lib/browser/find-in-page";

/** Typing is searched after this pause, not on every key. */
const SEARCH_DELAY_MS = 150;

export const BrowserFindBar: React.FC<{ label: string; onClose: () => void }> = ({ label, onClose }) => {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<FindResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const indexRef = useRef(0);

  const run = useCallback(
    async (text: string, index: number) => {
      try {
        const found = await auroraInvoke<FindResult>("browser_eval_value", {
          label,
          script: findScript(text, index),
        });
        indexRef.current = found.index < 0 ? 0 : found.index;
        setResult(text ? found : null);
        setError(null);
      } catch (err) {
        setResult(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [label],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Search as you type, from the first match.
  useEffect(() => {
    const timer = window.setTimeout(() => void run(query, 0), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query, run]);

  // Closing — or switching away — leaves no highlight behind in the page.
  useEffect(
    () => () => {
      void auroraInvoke("browser_eval_value", { label, script: clearFindScript() }).catch(() => undefined);
    },
    [label],
  );

  const step = (direction: 1 | -1) => {
    if (!result || result.count === 0) return;
    void run(query, indexRef.current + direction);
  };

  const count = result?.count ?? 0;
  const summary = error
    ? "Can't search this page"
    : !query
      ? ""
      : count === 0
        ? "No matches"
        : `${(result?.index ?? 0) + 1} of ${count}${result?.capped ? "+" : ""}`;

  return (
    <div className="agw-br-find" role="search">
      <div className="agw-br-find-field">
        <AgentIcon name="search" size={13} style={{ color: "var(--agw-text-subtle)" }} />
        <input
          ref={inputRef}
          className="agw-br-input"
          placeholder="Find in page"
          aria-label="Find in page"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
      </div>
      <span className="agw-br-find-count" data-empty={query && count === 0 ? "true" : undefined} role="status">
        {summary}
      </span>
      <button
        type="button"
        className="agw-br-nav"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={count === 0}
        onClick={() => step(-1)}
      >
        <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}>
          <AgentIcon name="chevron-down" size={14} />
        </span>
      </button>
      <button
        type="button"
        className="agw-br-nav"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={count === 0}
        onClick={() => step(1)}
      >
        <AgentIcon name="chevron-down" size={14} />
      </button>
      <button type="button" className="agw-br-nav" aria-label="Close find" title="Close (Esc)" onClick={onClose}>
        <AgentIcon name="close" size={13} />
      </button>
    </div>
  );
};
