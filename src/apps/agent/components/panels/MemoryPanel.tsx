/**
 * Agent Window — what Aurora remembers about you [view].
 *
 * A dock tab in Aurora Chat, opened from the rail. Lists every fact Aurora has
 * saved, and lets you pin, edit, delete, or write one yourself.
 *
 * This page is the reason the memory is trustworthy. A model that quietly
 * accumulates claims about you and never shows them is one you have no reason
 * to believe — the first time it repeats something wrong you have no way to
 * find it, let alone remove it. Everything the model saved is here, in the
 * order it will be handed back to it.
 *
 * Adding a fact by hand matters more than it sounds: the fastest way to correct
 * something the model got wrong is to write the right version yourself.
 */

import React, { useEffect, useRef, useState } from "react";
// `useState` is for the add-a-fact composer at the bottom, which is a normal
// controlled field. The per-row editor deliberately is not — see `FactRow`.

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import {
  useAgentMemoryStore,
  type MemoryFact,
} from "@/apps/agent/store/conversation/useAgentMemoryStore";

/**
 * How many facts ride in a conversation's first message.
 *
 * Mirrors `INJECTED_FACT_COUNT` in `chat_memory/facts.rs`, and is shown rather
 * than hidden: the list is ordered exactly as the model receives it, so the
 * line between "Aurora opens every chat knowing this" and "it has to go looking
 * for this" is the one thing a reader most wants to see.
 */
const INJECTED_COUNT = 5;

const FactRow: React.FC<{ fact: MemoryFact; injected: boolean }> = ({
  fact,
  injected,
}) => {
  const editingId = useAgentMemoryStore((s) => s.editingId);
  const beginEdit = useAgentMemoryStore((s) => s.beginEdit);
  const update = useAgentMemoryStore((s) => s.update);
  const setPinned = useAgentMemoryStore((s) => s.setPinned);
  const forget = useAgentMemoryStore((s) => s.forget);

  const editing = editingId === fact.id;
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // The textarea is UNCONTROLLED while open: `defaultValue` seeds it from the
  // fact, and the value is read back from the ref on commit. A controlled draft
  // would need seeding from an effect, which is both a lint error and the
  // actual bug behind it — an effect that writes state on every render of a
  // list that re-sorts under you when a row is pinned.
  //
  // Keyed by `updatedAt` so an edit committed elsewhere reseeds the field
  // rather than leaving a stale draft in an open editor.
  const commit = () => {
    const trimmed = inputRef.current?.value.trim() ?? "";
    // An edit that empties a fact is a delete typed the long way round, and
    // silently deleting is worse than declining. Cancel instead.
    if (!trimmed || trimmed === fact.text) {
      beginEdit(null);
      return;
    }
    void update(fact.id, trimmed);
  };

  return (
    <div className="agw-memory-row" data-pinned={fact.pinned || undefined}>
      <button
        type="button"
        className="agw-memory-pin"
        aria-pressed={fact.pinned}
        title={
          fact.pinned
            ? "Unpin — it will fall back to being remembered by recency"
            : "Pin — always among the first Aurora is told"
        }
        onClick={() => void setPinned(fact.id, !fact.pinned)}
      >
        <AgentIcon name="pin" size={13} />
      </button>

      <div className="agw-memory-body">
        {editing ? (
          <textarea
            key={fact.updatedAt}
            ref={inputRef}
            className="agw-memory-edit"
            defaultValue={fact.text}
            rows={2}
            autoFocus
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                commit();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                beginEdit(null);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="agw-memory-text"
            title="Click to edit"
            onClick={() => beginEdit(fact.id)}
          >
            {fact.text}
          </button>
        )}
        {injected && !editing && (
          <span className="agw-memory-badge">Told at the start of every chat</span>
        )}
      </div>

      <button
        type="button"
        className="agw-memory-forget"
        title="Forget this"
        aria-label={`Forget: ${fact.text}`}
        onClick={() => void forget(fact.id)}
      >
        <AgentIcon name="trash" size={13} />
      </button>
    </div>
  );
};

export const MemoryPanel: React.FC = () => {
  const facts = useAgentMemoryStore((s) => s.facts);
  const stats = useAgentMemoryStore((s) => s.stats);
  const loading = useAgentMemoryStore((s) => s.loading);
  const error = useAgentMemoryStore((s) => s.error);
  const rebuilding = useAgentMemoryStore((s) => s.rebuilding);
  const load = useAgentMemoryStore((s) => s.load);
  const add = useAgentMemoryStore((s) => s.add);
  const rebuildIndex = useAgentMemoryStore((s) => s.rebuildIndex);

  const [draft, setDraft] = useState("");

  useEffect(() => {
    void load();
  }, [load]);

  const submit = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setDraft("");
    void add(trimmed);
  };

  return (
    <div className="agw-memory">
      <div className="agw-memory-head">
        <div className="agw-memory-title">
          <AgentIcon name="database" size={14} />
          <span>What Aurora remembers</span>
        </div>
        {stats && (
          <span className="agw-memory-stats">
            {stats.facts} {stats.facts === 1 ? "fact" : "facts"} ·{" "}
            {stats.indexedChats} searchable{" "}
            {stats.indexedChats === 1 ? "chat" : "chats"}
          </span>
        )}
        <button
          type="button"
          className="agw-memory-rebuild"
          disabled={rebuilding}
          title="Re-read every conversation on disk and rebuild the search index. Nothing is lost — your facts are not touched."
          onClick={() => void rebuildIndex()}
        >
          {rebuilding ? "Rebuilding…" : "Rebuild search"}
        </button>
      </div>

      <div className="agw-memory-add">
        <textarea
          className="agw-memory-add-input"
          value={draft}
          rows={1}
          placeholder="Add something Aurora should know about you"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="button"
          className="agw-memory-add-btn"
          disabled={!draft.trim()}
          onClick={submit}
        >
          Add
        </button>
      </div>

      {error && (
        <div className="agw-memory-error" role="alert">
          {error}
        </div>
      )}

      <div className="agw-memory-list agw-scroll">
        {loading && facts.length === 0 ? (
          <div className="agw-memory-empty">Reading…</div>
        ) : facts.length === 0 ? (
          <div className="agw-memory-empty">
            Aurora has not saved anything yet. It will as you talk, and you can
            add something yourself above.
          </div>
        ) : (
          facts.map((fact, index) => (
            <FactRow key={fact.id} fact={fact} injected={index < INJECTED_COUNT} />
          ))
        )}
      </div>

      {facts.length > INJECTED_COUNT && (
        <p className="agw-memory-foot">
          The first {INJECTED_COUNT} are handed to Aurora at the start of every
          chat. It finds the rest by searching, when they are relevant. Pin
          anything you want kept in that first group.
        </p>
      )}
    </div>
  );
};

export default MemoryPanel;
