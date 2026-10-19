/**
 * Agent Window — the reply language's diagram: columns of parts, each feeding
 * the next [view].
 *
 * What the fences could not draw: a fan in (four surfaces into one gate) and
 * a fan out (one gate into three checks). Nodes are words, not boxes — the
 * reply layout's rule from two live rounds is rows and rails, never box grids
 * — and the lines between them are hairlines that take the accent only while
 * the reader traces a path.
 *
 * Selecting a node lights everything reachable from it in both directions.
 * That is view state only: nothing is saved and nothing reaches the model.
 * In a narrow reply (the docked chat) the columns stack and the lines run
 * down; they leave from under the whole column so a line from the first row
 * never crosses the rows beneath it.
 */

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { traceDiagram, type DiagramColumn, type DiagramEdge } from "@/apps/agent/lib/reply-layout/ui";
import { Field } from "./Field";

/** Below this width the columns stack. */
const NARROW_WIDTH = 520;

export const Diagram: React.FC<{ title: string; columns: DiagramColumn[]; edges: DiagramEdge[] }> = ({ title, columns, edges }) => {
  const frame = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [paths, setPaths] = useState<string[]>([]);
  const [traced, setTraced] = useState<[number, number] | null>(null);

  // A node that streamed away (the model rewrote the column) drops the trace.
  const trace = useMemo(() => {
    if (!traced || !columns[traced[0]]?.nodes[traced[1]]) return null;
    return traceDiagram(traced, edges);
  }, [traced, columns, edges]);

  const measure = useCallback(() => {
    const box = frame.current;
    if (!box) return;
    const isNarrow = box.clientWidth < NARROW_WIDTH;
    setNarrow(isNarrow);
    const origin = box.getBoundingClientRect();
    const node = (c: number, n: number) => box.querySelector<HTMLElement>(`[data-node="${c}:${n}"]`);
    const next: string[] = [];
    for (const edge of edges) {
      const a = node(...edge.from);
      const b = node(...edge.to);
      if (!a || !b) {
        next.push("");
        continue;
      }
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      if (isNarrow) {
        // Out from under the whole column, in at the top of the next one, so
        // no line crosses a row of nodes when a column wraps to two rows.
        const out = a.closest(".agw-rl-dia-nodes")?.getBoundingClientRect() ?? ra;
        const into = b.closest(".agw-rl-dia-nodes")?.getBoundingClientRect() ?? rb;
        const x1 = ra.left + ra.width / 2 - origin.left;
        const y1 = out.bottom - origin.top;
        const x2 = rb.left + rb.width / 2 - origin.left;
        const y2 = into.top - origin.top;
        const mid = (y1 + y2) / 2;
        next.push(`M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`);
      } else {
        // Level with the title's first line, just outside the words.
        const x1 = ra.right + 2 - origin.left;
        const y1 = ra.top + 17 - origin.top;
        const x2 = rb.left - 2 - origin.left;
        const y2 = rb.top + 17 - origin.top;
        const mid = (x1 + x2) / 2;
        next.push(`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`);
      }
    }
    setPaths(next);
  }, [edges]);

  // Re-measure when the parts change (streaming) and when the reply resizes.
  useLayoutEffect(() => {
    measure();
  }, [measure, columns, narrow]);
  useLayoutEffect(() => {
    const box = frame.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(box);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <figure className="agw-rl agw-rl-diagram" data-tracing={trace ? "" : undefined}>
      {title && (
        <figcaption className="agw-rl-block-title">
          <Field text={title} />
        </figcaption>
      )}
      <div ref={frame} className="agw-rl-dia" data-narrow={narrow ? "" : undefined}>
        <div className="agw-rl-dia-cols">
          {columns.map((column, c) => (
            <section key={c} className="agw-rl-dia-col" aria-label={column.label || undefined}>
              {column.label && (
                <div className="agw-rl-dia-label" aria-hidden="true">
                  <Field text={column.label} />
                </div>
              )}
              <div className="agw-rl-dia-nodes">
                {column.nodes.map((node, n) => {
                  const on = trace?.nodes.has(`${c}:${n}`) ?? false;
                  const chosen = traced?.[0] === c && traced?.[1] === n;
                  return (
                    <button
                      key={n}
                      type="button"
                      className="agw-rl-dia-node"
                      data-node={`${c}:${n}`}
                      data-on={on ? "" : undefined}
                      aria-pressed={chosen}
                      onClick={() => setTraced(chosen ? null : [c, n])}
                    >
                      <span className="agw-rl-dia-title">
                        <Field text={node.title} />
                      </span>
                      {node.caption && (
                        <span className="agw-rl-dia-caption">
                          <Field text={node.caption} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
        <svg className="agw-rl-dia-lines" aria-hidden="true">
          {paths.map((d, i) => d && <path key={i} d={d} data-on={trace?.edges.has(i) ? "" : undefined} />)}
        </svg>
      </div>
    </figure>
  );
};
