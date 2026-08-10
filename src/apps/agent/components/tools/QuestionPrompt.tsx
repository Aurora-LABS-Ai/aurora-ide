/**
 * Agent Window — interactive question prompt [view].
 *
 * Renders the live `ask_question` request as a card docked above the composer
 * (it "rises" from the input toward the transcript). Modelled on Cursor's
 * Questions card:
 *
 *   ┌ ⍰ Questions                                   2 of 3  ⌄ ┐
 *   │ 1. <prompt>                                              │
 *   │    A  <option>                                           │
 *   │    B  <option>                                           │   ← inline scroller
 *   │    C  Other…                                             │
 *   │ 2. <prompt> …                                            │
 *   └                                       Skip Esc  Continue ┘
 *
 * Single- or multi-select per question (radio vs checkbox), plus an always-
 * present "Other…" free-text entry. Blocks the turn until Continue/Skip; the
 * resolver lives in `useAgentQuestionStore`. Themed entirely with `--agw-*`.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import type {
  AskQuestionAnswer,
  AskQuestionItem,
  AskQuestionRequest,
} from "@/apps/agent/services/tools/question-bridge";
import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { useAgentQuestionStore } from "@/apps/agent/store/tools/useAgentQuestionStore";

const OTHER_ID = "__other__";

/** Per-question working selection. */
interface Draft {
  selected: string[];
  other: string;
  otherActive: boolean;
}

const letterFor = (index: number): string => String.fromCharCode(65 + index);

function emptyDraft(): Draft {
  return { selected: [], other: "", otherActive: false };
}

function hasAnswer(draft: Draft): boolean {
  return draft.selected.length > 0 || (draft.otherActive && draft.other.trim() !== "");
}

/** One question block — prompt, lettered options, and an "Other…" entry. */
const QuestionItem: React.FC<{
  index: number;
  question: AskQuestionItem;
  draft: Draft;
  onChange: (next: Draft) => void;
}> = ({ index, question, draft, onChange }) => {
  const otherRef = useRef<HTMLInputElement>(null);
  const multi = question.allowMultiple === true;

  const pick = useCallback(
    (optionId: string) => {
      if (multi) {
        const selected = draft.selected.includes(optionId)
          ? draft.selected.filter((id) => id !== optionId)
          : [...draft.selected, optionId];
        onChange({ ...draft, selected });
      } else {
        onChange({ selected: [optionId], other: draft.other, otherActive: false });
      }
    },
    [draft, multi, onChange],
  );

  const pickOther = useCallback(() => {
    if (multi) {
      onChange({ ...draft, otherActive: !draft.otherActive });
    } else {
      onChange({ selected: [], other: draft.other, otherActive: true });
    }
    requestAnimationFrame(() => otherRef.current?.focus());
  }, [draft, multi, onChange]);

  const rows = useMemo(
    () => [
      ...question.options.map((opt, i) => ({
        id: opt.id,
        label: opt.label,
        letter: letterFor(i),
        selected: draft.selected.includes(opt.id),
        isOther: false,
      })),
      {
        id: OTHER_ID,
        label: "Other…",
        letter: letterFor(question.options.length),
        selected: draft.otherActive,
        isOther: true,
      },
    ],
    [question.options, draft.selected, draft.otherActive],
  );

  return (
    <div className="agw-qp-q">
      <div className="agw-qp-prompt">
        <span className="agw-qp-num">{index + 1}.</span>
        <span>{question.prompt}</span>
      </div>

      <div className="agw-qp-opts" role={multi ? "group" : "radiogroup"}>
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            className={`agw-qp-opt${row.selected ? " is-selected" : ""}`}
            role={multi ? "checkbox" : "radio"}
            aria-checked={row.selected}
            onClick={() => (row.isOther ? pickOther() : pick(row.id))}
          >
            <span className="agw-qp-letter">{row.letter}</span>
            <span className="agw-qp-opt-label">{row.label}</span>
            {row.selected && (
              <AgentIcon name="check" size={13} className="agw-qp-opt-check" />
            )}
          </button>
        ))}

        {draft.otherActive && (
          <input
            ref={otherRef}
            type="text"
            className="agw-qp-other"
            placeholder="Type your answer…"
            value={draft.other}
            onChange={(e) => onChange({ ...draft, other: e.target.value })}
          />
        )}
      </div>
    </div>
  );
};

/** The card itself, keyed per request so drafts reset on a new prompt. */
const QuestionCard: React.FC<{ request: AskQuestionRequest }> = ({ request }) => {
  const submit = useAgentQuestionStore((s) => s.submit);
  const skip = useAgentQuestionStore((s) => s.skip);

  const [collapsed, setCollapsed] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => {
    const seed: Record<string, Draft> = {};
    for (const q of request.questions) seed[q.id] = emptyDraft();
    return seed;
  });

  const answeredCount = useMemo(
    () => request.questions.filter((q) => hasAnswer(drafts[q.id] ?? emptyDraft())).length,
    [request.questions, drafts],
  );

  const onContinue = useCallback(() => {
    const answers: AskQuestionAnswer[] = [];
    for (const q of request.questions) {
      const draft = drafts[q.id] ?? emptyDraft();
      const otherText = draft.otherActive ? draft.other.trim() : "";
      if (draft.selected.length === 0 && !otherText) continue;
      answers.push({
        questionId: q.id,
        selectedIds: draft.selected,
        otherText: otherText || undefined,
      });
    }
    submit({ skipped: false, answers });
  }, [request.questions, drafts, submit]);

  // Esc skips; Cmd/Ctrl+Enter continues. Scoped to the card so it doesn't fight
  // the composer's own key handling.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        skip();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onContinue();
      }
    },
    [skip, onContinue],
  );

  return (
    <div className="agw-qp" role="dialog" aria-label="Questions" onKeyDown={onKeyDown}>
      <div className="agw-qp-head">
        <div className="agw-qp-title">
          <AgentIcon name="help" size={15} />
          <span>{request.title?.trim() || "Questions"}</span>
        </div>
        <div className="agw-qp-meta">
          <span className="agw-qp-count">
            {answeredCount} of {request.questions.length}
          </span>
          {/* Actions live in the head as compact icons (Skip ✕ / Continue ✓)
              instead of a full-width footer bar that wasted the panel's bottom. */}
          <button
            type="button"
            className="agw-icon-btn agw-qp-skip"
            title="Skip (Esc)"
            aria-label="Skip"
            onClick={skip}
          >
            <AgentIcon name="close" size={15} />
          </button>
          <button
            type="button"
            className="agw-icon-btn agw-qp-go"
            title="Continue (⌘↵)"
            aria-label="Continue"
            onClick={onContinue}
          >
            <AgentIcon name="check" size={16} strokeWidth={2.2} />
          </button>
          <span className="agw-qp-sep" aria-hidden />
          <button
            type="button"
            className="agw-icon-btn agw-qp-collapse"
            title={collapsed ? "Expand" : "Collapse"}
            aria-label={collapsed ? "Expand" : "Collapse"}
            onClick={() => setCollapsed((c) => !c)}
          >
            <AgentIcon
              name="chevron-down"
              size={15}
              style={{
                transform: collapsed ? "rotate(180deg)" : "none",
                transition: "transform 120ms ease",
              }}
            />
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="agw-qp-body agw-scroll">
          {request.questions.map((q, i) => (
            <QuestionItem
              key={q.id}
              index={i}
              question={q}
              draft={drafts[q.id] ?? emptyDraft()}
              onChange={(next) => setDrafts((prev) => ({ ...prev, [q.id]: next }))}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/** Renders the live prompt (if any). Keyed so a new request remounts cleanly. */
export const QuestionPrompt: React.FC = () => {
  const pending = useAgentQuestionStore((s) => s.pending);

  // Focus the card on appear so Esc/⌘↵ work without a click first.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pending) rootRef.current?.focus();
  }, [pending]);

  const key = pending ? pending.questions.map((q) => q.id).join("|") : "none";

  // Glide open/close by animating HEIGHT — the same pattern the task panel and
  // rail sections use, so it reads as one system. AnimatePresence keeps the card
  // mounted through the close so it collapses down behind the composer instead
  // of vanishing. The -12px bottom margin carries the composer tuck (the card no
  // longer owns it); overflow:hidden clips the height collapse.
  return (
    <AnimatePresence initial={false}>
      {pending && (
        <motion.div
          key={key}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          style={{ overflow: "hidden", marginBottom: -12 }}
        >
          <div ref={rootRef} tabIndex={-1} style={{ outline: "none" }}>
            <QuestionCard request={pending} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
