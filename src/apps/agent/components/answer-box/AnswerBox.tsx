/**
 * Agent Window — an answer box: a small working tool inside a reply [view].
 *
 * Probe: Documents/aurora-chat-interactive-answer-designs.html, variant 03
 * ("one quiet box"). The model writes an `aurora-box` fence (format:
 * `lib/answer-box/parse.ts`); this draws it.
 *
 * The box is only the frame. Everything inside it is the canvas SDK
 * (`src/canvas-sdk`) — the same `Stepper`, `Row` and `BarChart` a live canvas
 * in the dock is built from — so a tool in a reply and a canvas beside it are
 * one product, not two lookalikes.
 */

import React, { useEffect, useMemo, useState } from "react";

import "@/canvas-sdk/canvas.css";
import { BarChart, Choice, List, NumberField, Row, Stepper } from "@/canvas-sdk";
import {
  computeBox,
  defaultValues,
  rankItems,
  usableValues,
  type BoxBlock,
  type BoxValues,
  type ComputedCompare,
} from "@/apps/agent/lib/answer-box/compute";
import { formatBoxValue } from "@/apps/agent/lib/answer-box/format";
import { parseBox, type BoxInput, type BoxLineError } from "@/apps/agent/lib/answer-box/parse";
import { boxKey } from "@/apps/agent/lib/answer-box/split";
import { useConversationScope } from "@/apps/agent/lib/thread/conversation-scope";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { selectBoxValues, useAnswerBoxStore } from "@/apps/agent/store/answer-box/useAnswerBoxStore";

/** Errors past this are counted, not listed: the box is the point, not its faults. */
const MAX_LISTED_PROBLEMS = 4;

const InputPart: React.FC<{
  input: BoxInput;
  value: number;
  hero: boolean;
  onChange: (id: string, value: number) => void;
}> = ({ input, value, hero, onChange }) => {
  if (input.kind === "stepper") {
    return (
      <Stepper
        label={input.label}
        value={value}
        min={input.min}
        max={input.max}
        step={input.step}
        unit={input.unit}
        size={hero ? "large" : "default"}
        onChange={(next) => onChange(input.id, next)}
      />
    );
  }
  if (input.kind === "number") {
    return (
      <NumberField
        label={input.label}
        value={value}
        min={input.min}
        max={input.max}
        prefix={input.prefix}
        suffix={input.suffix}
        onChange={(next) => onChange(input.id, next)}
      />
    );
  }
  return (
    <Choice
      label={input.label}
      value={value}
      options={input.options}
      onChange={(next) => onChange(input.id, Number(next))}
    />
  );
};

/** A comparison: pick the measure, the bars re-rank best first. */
const ComparePart: React.FC<{ compare: ComputedCompare }> = ({ compare }) => {
  const [metricId, setMetricId] = useState(compare.metrics[0]?.id ?? "");
  const metric = compare.metrics.find((m) => m.id === metricId) ?? compare.metrics[0];
  if (!metric) return null;
  const ranked = rankItems(compare, metric.id).filter((item) => item.values[metric.id] !== undefined);
  return (
    <div className="agw-abox-compare">
      {compare.metrics.length > 1 ? (
        <Choice
          label="Sort by"
          value={metric.id}
          options={compare.metrics.map((m) => ({ label: m.label, value: m.id }))}
          onChange={(next) => setMetricId(String(next))}
        />
      ) : null}
      <BarChart
        title={`${metric.label}, ${metric.better === "low" ? "lowest" : "highest"} first`}
        unit={metric.unit}
        data={ranked.map((item, index) => ({
          label: item.name,
          value: item.values[metric.id],
          // One subject carries the tone; the rest are what it is compared against.
          tone: index === 0 ? "info" : undefined,
        }))}
      />
    </div>
  );
};

/** Draw the blocks in order; a title heads the rows that follow it. */
function renderBlocks(
  blocks: BoxBlock[],
  hero: boolean,
  onChange: (id: string, value: number) => void,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  blocks.forEach((block, index) => {
    switch (block.kind) {
      case "input":
        out.push(
          <InputPart key={index} input={block.input} value={block.value} hero={hero} onChange={onChange} />,
        );
        break;
      case "title":
        out.push(
          <h3 key={index} className="agw-abox-title">
            {block.text}
          </h3>,
        );
        break;
      case "rows":
        out.push(
          <List key={index}>
            {block.rows.map((row, i) => (
              <Row key={i} title={row.label} value={row.value} emphasis={row.emphasis} />
            ))}
          </List>,
        );
        break;
      case "compare":
        out.push(<ComparePart key={index} compare={block.compare} />);
        break;
      default:
        break;
    }
  });
  return out;
}

export interface AnswerBoxProps {
  /** The fence's body, as written so far. */
  source: string;
  /** False while the model is still writing the box. */
  closed: boolean;
  /** What to show instead when nothing in the box can be drawn. */
  fallback: React.ReactNode;
}

const AnswerBoxImpl: React.FC<AnswerBoxProps> = ({ source, closed, fallback }) => {
  const spec = useMemo(() => parseBox(source, { complete: closed }), [source, closed]);
  const key = useMemo(() => (closed ? boxKey(source) : null), [source, closed]);
  // The conversation this reply belongs to: a docked chat or a sub-agent's view
  // says so through the scope; otherwise it is the open chat.
  const scope = useConversationScope();
  const openThreadId = useAgentChatStore((s) => s.currentThreadId);
  const threadId = scope ? scope.threadId : openThreadId;
  const saved = useAnswerBoxStore(selectBoxValues(threadId, key ?? ""));
  const hydrate = useAnswerBoxStore((s) => s.hydrate);
  const setBox = useAnswerBoxStore((s) => s.setBox);
  // What was changed here before the save round-trip; saved values otherwise.
  const [local, setLocal] = useState<BoxValues | null>(null);

  useEffect(() => {
    if (threadId && closed) void hydrate(threadId);
  }, [threadId, closed, hydrate]);

  const defaults = useMemo(() => defaultValues(spec), [spec]);
  const values = useMemo(() => usableValues(spec, local ?? saved), [spec, local, saved]);
  const box = useMemo(() => computeBox(spec, values), [spec, values]);

  const changedIds = Object.keys(defaults).filter((id) => values[id] !== defaults[id]);

  const save = (next: BoxValues) => {
    setLocal(next);
    if (!threadId || !key) return;
    const changed: BoxValues = {};
    for (const id of Object.keys(defaults)) if (next[id] !== defaults[id]) changed[id] = next[id];
    setBox(threadId, key, Object.keys(changed).length > 0 ? changed : null);
  };
  const onChange = (id: string, value: number) => save({ ...values, [id]: value });
  const reset = () => save(defaults);

  const problems: BoxLineError[] = closed ? [...spec.errors, ...box.problems] : [];

  if (closed && box.blocks.length === 0) {
    return (
      <div className="agw-abox-failed">
        <p className="agw-abox-failed-note">
          This answer box couldn't be drawn
          {problems[0] ? `: line ${problems[0].line}, ${problems[0].message}.` : "."}
        </p>
        {fallback}
      </div>
    );
  }

  // "Back to 6" names the number when there is one input to put back.
  const inputs = spec.parts.filter((p): p is BoxInput & { line: number } =>
    p.kind === "stepper" || p.kind === "number" || p.kind === "choice",
  );
  const lone = inputs.length === 1 ? inputs[0] : null;
  const resetLabel =
    lone?.kind === "stepper"
      ? `Back to ${formatBoxValue(lone.value)}`
      : lone?.kind === "choice"
        ? `Back to ${lone.options.find((o) => o.value === lone.value)?.label ?? "the start"}`
        : "Reset";

  return (
    <section className="agw-abox" aria-busy={!closed || undefined}>
      {box.blocks.length === 0 ? (
        <p className="agw-abox-pending">Writing the box…</p>
      ) : (
        renderBlocks(box.blocks, box.heroInput, onChange)
      )}
      {problems.length > 0 ? (
        <ul className="agw-abox-problems" aria-label="Lines this box skipped">
          {problems.slice(0, MAX_LISTED_PROBLEMS).map((p, i) => (
            <li key={i}>
              Line {p.line}: {p.message}
            </li>
          ))}
          {problems.length > MAX_LISTED_PROBLEMS ? (
            <li>and {problems.length - MAX_LISTED_PROBLEMS} more</li>
          ) : null}
        </ul>
      ) : null}
      {box.note || changedIds.length > 0 ? (
        <div className="agw-abox-foot">
          <span className="agw-abox-note">{box.note}</span>
          {changedIds.length > 0 ? (
            <button type="button" className="agw-abox-reset" onClick={reset}>
              {resetLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
};

/** Memoized: a reply re-renders on every streamed token, a finished box does not need to. */
export const AnswerBox = React.memo(AnswerBoxImpl);
