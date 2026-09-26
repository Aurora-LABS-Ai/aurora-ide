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
import { buildProgress, isIndexBuilding, readIndexBuild, startIndexBuild } from "@/apps/agent/services/code-index/code-index";

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

/** Shortest gap between two probes triggered by opening the panel. */
const RECHECK_MIN_GAP_MS = 10_000;

const count = (n: number): string => n.toLocaleString();

const ProjectCodeIndexStatus: React.FC<{ projectRoot: string }> = ({ projectRoot }) => {
  const [phase, setPhase] = useState<Phase>("hidden");
  const [probe, setProbe] = useState<IndexProbe | null>(null);
  const [built, setBuilt] = useState<IndexStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState("");
  const watchingJob = useRef<string | null>(null);
  // The last finished build this control has already reacted to, and when it
  // mounted. Together they separate "a build finished while I was here" from
  // "a build finished before I existed", which the first probe already covers.
  const settledJob = useRef<string | null>(null);
  // Set by the effect below rather than here, because reading the clock during
  // render is impure. Zero until then, and the effect writes it before
  // anything can read it.
  const mountedAt = useRef(0);
  const lastRecheck = useRef(0);
  // The phase as it is NOW, readable from inside an in-flight probe. A probe
  // takes as long as hashing the project takes, and pressing Index project
  // during one must not be undone by its answer arriving afterwards.
  const phaseNow = useRef<Phase>("hidden");

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
    // What this control has already reacted to belongs to the other project;
    // the effect below resets it when it re-runs for the new root.
  }

  /**
   * Ask again whether this project still needs an index.
   *
   * The offer is a claim about the project, and this control is not the only
   * thing that can make it false. Settings builds one, and the agent's own
   * first message builds one without ever creating a job. Probing once at
   * mount and never again left the header offering to index a project that
   * had been indexed minutes earlier, with no way back except switching
   * project or reopening the window.
   *
   * Not on a timer: the probe hashes every source file to answer, which is not
   * something to repeat every second in the background. It runs when something
   * has actually happened, or when someone opens the panel to read it.
   */
  const recheck = useCallback(async () => {
    if (!projectRoot) return;
    lastRecheck.current = Date.now();
    const from = phaseNow.current;
    try {
      const [probed, snapshot] = await Promise.all([
        invoke<IndexProbe>("code_index_probe", { workspacePath: projectRoot }),
        readIndexBuild(projectRoot),
      ]);
      if (askedFor.current !== projectRoot) return;
      setProbe(probed);
      // This answers a question asked about one phase. If the control has
      // since started a build, failed, or finished, that is newer than this
      // and this has nothing to add.
      if (phaseNow.current !== from) return;
      if (probed.ready) {
        // It has one now. Report that rather than vanishing under the cursor:
        // `done` retires itself after a beat.
        setBuilt(snapshot.index);
        setPhase("done");
      } else if (probed.indexableFiles > 0 && !watchingJob.current) {
        setPhase("offer");
      }
    } catch {
      // Leave the phase alone. A failed probe is not news, and replacing a
      // truthful offer with an error would be worse than saying nothing.
    }
  }, [projectRoot]);

  useEffect(() => {
    if (!projectRoot) return;
    askedFor.current = projectRoot;
    // Everything this control has already reacted to is about the previous
    // root. A finished build of another project is not news here, and its
    // timestamp would make this project's first build look like old news.
    mountedAt.current = Date.now();
    settledJob.current = null;
    lastRecheck.current = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const observe = async () => {
      try {
        const next = await readIndexBuild(projectRoot);
        if (cancelled) return;
        if (next.job && isIndexBuilding(next.job)) {
          watchingJob.current = next.job.id;
          setProgress(buildProgress(next.job));
          setPhase("working");
        } else if (next.job && watchingJob.current === next.job.id) {
          watchingJob.current = null;
          settledJob.current = next.job.id;
          setBuilt(next.index);
          if (next.job.phase === "complete") {
            setPhase("done");
            setOpen(false);
          } else {
            setError(buildProgress(next.job));
            setPhase("error");
          }
        } else if (next.job && settledJob.current !== next.job.id) {
          // A build this control did not start, already finished by the time
          // the poll saw it. A full index of a normal project takes under a
          // second, so a build begun in Settings routinely starts and finishes
          // inside one tick of this one-second poll and is never observed as
          // running — which is exactly how the header ends up offering to
          // index a project that has just been indexed.
          settledJob.current = next.job.id;
          // A build that finished before this control existed is already
          // accounted for by the mount probe, so only react to a newer one.
          // `settledJob` then keeps this to one re-check per build rather than
          // one per tick for as long as that job stays the latest.
          if ((next.job.finishedAt ?? 0) >= mountedAt.current) void recheck();
        }
      } catch (e) {
        if (!cancelled && watchingJob.current) {
          setError(`Could not read build progress: ${String(e)}`);
          setPhase("error");
        }
      }
      if (!cancelled) timer = setTimeout(() => void observe(), 1000);
    };
    void observe();

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
        if (!next.ready && next.indexableFiles > 0 && !watchingJob.current) setPhase("offer");
      } catch {
        // A failed probe is not worth a light in the header. The index is a
        // convenience, the agent still has grep, and the first turn retries.
      }
    })();

    return () => {
      cancelled = true;
      askedFor.current = null;
      clearTimeout(timer);
    };
  }, [projectRoot, recheck]);

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

  // What an in-flight probe compares itself against when it answers. Written
  // after commit rather than during render, which is the rule for a ref.
  useEffect(() => {
    phaseNow.current = phase;
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

  /**
   * Showing the panel is the moment its claim has to be true, so it is checked
   * here rather than only when something else happens to notice.
   *
   * Rate-limited, and that is not a nicety: the probe hashes every source file
   * in the project to answer, and hover is one of the two ways this panel
   * opens. Crossing the header repeatedly must not re-read the project each
   * time.
   */
  const revealed = useCallback(() => {
    if (phaseNow.current !== "offer") return;
    if (Date.now() - lastRecheck.current < RECHECK_MIN_GAP_MS) return;
    void recheck();
  }, [recheck]);

  const scheduleHover = useCallback(
    (next: boolean) => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
      hoverTimer.current = window.setTimeout(
        () => {
          setOpen(next);
          if (next) revealed();
        },
        next ? HOVER_OPEN_MS : HOVER_CLOSE_MS,
      );
    },
    [revealed],
  );

  const build = useCallback(async () => {
    if (!projectRoot) return;
    setPhase("working");
    setError(null);
    try {
      const job = await startIndexBuild(projectRoot);
      if (askedFor.current !== projectRoot) return;
      watchingJob.current = job.id;
      setProgress(buildProgress(job));
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
    body = `${progress || `Reading ${count(files)} files.`} You can switch projects. Keep Aurora open.`;
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
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) revealed();
        }}
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

export const CodeIndexStatus: React.FC = () => {
  const projectRoot = useAgentChatStore((s) => s.projectRoot);
  return projectRoot ? <ProjectCodeIndexStatus key={projectRoot} projectRoot={projectRoot} /> : null;
};
