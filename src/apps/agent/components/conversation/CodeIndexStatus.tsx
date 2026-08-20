/**
 * Agent Window — unindexed-project status [header control].
 *
 * A missing code index is a CONDITION, not an event: it is true of the project
 * until someone builds one, and it stays true across restarts. So it lives in
 * the header as a status light rather than arriving as a card that can be
 * dismissed forever. There is no close button, and that is only tolerable
 * because the resting state is one amber glyph — a persistent notice loud
 * enough to read from across the room would be nagging; a status light is just
 * information.
 *
 * Why it earns a place in the header at all: `repo_map_block` builds the index
 * inside the FIRST message of a session, so without this the cost is paid by
 * whoever presses send, as several seconds of apparent nothing. Offering it
 * beforehand moves that work to a moment when nobody is waiting.
 *
 * Four decisions worth keeping:
 *
 * 1. **It shows in both header states.** The task readout and the context ring
 *    describe a turn and are absent on the empty screen; this describes the
 *    project, which exists either way. It is mounted immediately before
 *    Settings so its distance from the right edge is identical in both.
 * 2. **The glyph holds its slot through the whole run** — amber, then a
 *    spinner, then a green tick for a beat, and only then does it unmount.
 *    Removing it the moment the build starts would mean a failure and a success
 *    look the same afterwards: an empty header.
 * 3. **Failure keeps the slot and turns red.** It is a condition too, and the
 *    reason has to be reachable.
 * 4. **Hover is not the only way in.** It is a real button: click and Enter
 *    open the panel, Escape closes it, and the accessible name carries the
 *    state so the glyph's colour is never the only thing saying it.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";

import { auroraInvoke as invoke } from "@/kernel/lib/ipc/runtime";
import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";

/** Mirrors Rust `code_index::IndexProbe` (serde camelCase). */
interface IndexProbe {
  ready: boolean;
  indexableFiles: number;
  overAutoCap: boolean;
}

/** Mirrors Rust `code_index::IndexStatus` (serde camelCase). */
interface IndexStatus {
  built: boolean;
  files: number;
  symbols: number;
}

type Phase = "hidden" | "offer" | "working" | "done" | "error";

/** How long the green tick stays before the control retires for good. */
const DONE_LINGER_MS = 2000;

/** Hover-open delay, so crossing the header does not flash the panel open. */
const HOVER_OPEN_MS = 90;

/** Hover-close delay, so a diagonal move to the button inside does not lose it. */
const HOVER_CLOSE_MS = 140;

const count = (n: number): string => n.toLocaleString();

export const CodeIndexStatus: React.FC = () => {
  const projectRoot = useAgentChatStore((s) => s.projectRoot);
  const [phase, setPhase] = useState<Phase>("hidden");
  const [probe, setProbe] = useState<IndexProbe | null>(null);
  const [built, setBuilt] = useState<IndexStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const hoverTimer = useRef<number | null>(null);
  // Guards a late probe answer from a project the user has already left.
  const askedFor = useRef<string | null>(null);

  // Switching project resets DURING RENDER rather than in an effect:
  // `react-hooks/set-state-in-effect` is an error here, and the effect form
  // would render the previous project's state for a frame first.
  const [seenRoot, setSeenRoot] = useState(projectRoot);
  if (seenRoot !== projectRoot) {
    setSeenRoot(projectRoot);
    setPhase("hidden");
    setProbe(null);
    setBuilt(null);
    setError(null);
    setOpen(false);
  }

  useEffect(() => {
    if (!projectRoot) return;
    askedFor.current = projectRoot;
    let cancelled = false;

    void (async () => {
      try {
        const next = await invoke<IndexProbe>("code_index_probe", {
          workspacePath: projectRoot,
        });
        if (cancelled || askedFor.current !== projectRoot) return;
        setProbe(next);
        // `ready` means a valid cache was adopted and the agent can already
        // answer. No readable source means an index would be empty, so there
        // is nothing here worth offering.
        if (!next.ready && next.indexableFiles > 0) setPhase("offer");
      } catch {
        // A failed probe is not worth a light in the header. The index is a
        // convenience, the agent still has grep, and the first turn retries.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectRoot]);

  // Retire the finished state on its own. Deliberately unmounts rather than
  // returning to `offer`: the project now HAS an index, so the condition this
  // control reports is over.
  useEffect(() => {
    if (phase !== "done") return;
    const timer = window.setTimeout(() => {
      setPhase("hidden");
      setOpen(false);
    }, DONE_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  // Close on a click anywhere else. Bound only while open, so the window is
  // not carrying a document listener for a control nobody has touched.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  useEffect(() => {
    return () => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    };
  }, []);

  const scheduleHover = useCallback((next: boolean) => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(
      () => setOpen(next),
      next ? HOVER_OPEN_MS : HOVER_CLOSE_MS,
    );
  }, []);

  const build = useCallback(async () => {
    if (!projectRoot) return;
    setPhase("working");
    setError(null);
    try {
      const status = await invoke<IndexStatus>("code_index_rebuild", {
        workspacePath: projectRoot,
      });
      if (askedFor.current !== projectRoot) return;
      setBuilt(status);
      setPhase("done");
      setOpen(false);
    } catch (e) {
      if (askedFor.current !== projectRoot) return;
      // Rust writes these for a person to read; replacing it with a generic
      // failure would say strictly less.
      setError(String(e));
      setPhase("error");
    }
  }, [projectRoot]);

  if (phase === "hidden") return null;

  const files = probe?.indexableFiles ?? 0;

  // The index mark carries every state but the finished one, which is the only
  // moment the control is reporting an outcome rather than a condition.
  const glyph = phase === "done" ? "check" : "code-index";

  let label = "";
  let title = "";
  let body = "";
  let meta = "";
  let action: string | null = null;

  if (phase === "offer") {
    label = `This project is not indexed. ${count(files)} files. Open index options.`;
    title = "Not indexed";
    body = probe?.overAutoCap
      ? "Too large for the agent to index on its own. Definitions and callers are searched as text until this is built."
      : "Definitions and callers are searched as text until this is built.";
    meta = `${count(files)} files`;
    action = "Index project";
  } else if (phase === "working") {
    label = "Indexing this project.";
    title = "Indexing…";
    body = `Reading ${count(files)} files.`;
  } else if (phase === "done") {
    label = "This project is indexed.";
    title = "Indexed";
    body = `${count(built?.files ?? 0)} files, ${count(built?.symbols ?? 0)} symbols.`;
  } else {
    label = "Indexing this project failed. Open for the reason.";
    title = "Indexing failed";
    body = error ?? "The index could not be built.";
    action = "Try again";
  }

  return (
    <span
      ref={wrapRef}
      className="agw-idxstat"
      data-phase={phase}
      onMouseEnter={() => scheduleHover(true)}
      onMouseLeave={() => scheduleHover(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="agw-idxstat-btn"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {phase === "working" ? (
          <span className="agw-rail-spin agw-idxstat-spin" aria-hidden="true" />
        ) : (
          <AgentIcon name={glyph} size={16} />
        )}
      </button>

      {open && (
        <span className="agw-idxstat-pop" role="group" aria-label={title}>
          <span className="agw-idxstat-title">{title}</span>
          <span className="agw-idxstat-body">{body}</span>
          <span className="agw-idxstat-row">
            <span className="agw-idxstat-meta">{meta}</span>
            {action && (
              <button
                type="button"
                className="agw-idxstat-go"
                onClick={() => void build()}
              >
                {action}
              </button>
            )}
          </span>
        </span>
      )}
    </span>
  );
};
