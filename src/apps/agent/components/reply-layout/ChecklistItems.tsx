/**
 * Agent Window — a checklist's items, with a status filter [view].
 *
 * Statuses are written facts, never task controls: nothing here can be
 * ticked. Four or more items in at least two statuses get a filter (All,
 * then each status present, with its count), so "what is still pending"
 * is one press. Each status carries a mark AND its word; colour alone never
 * says done or blocked. The filter is view state only.
 */

import React, { useState } from "react";

import { CHECKLIST_STATUSES, type ChecklistItem, type ChecklistStatus } from "@/apps/agent/lib/reply-layout/structures";
import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { Field } from "./Field";

const FILTER_FROM = 4;
/** Finished first, then what needs attention, then what has not started. */
const FILTER_ORDER: ChecklistStatus[] = ["done", "doing", "blocked", "todo"];

const StatusMark: React.FC<{ status: ChecklistStatus }> = ({ status }) =>
  status === "done" ? <AgentIcon name="check" size={14} className="agw-rl-mark" />
  : status === "blocked" ? <AgentIcon name="alert" size={14} className="agw-rl-mark" />
  : <span className="agw-rl-mark agw-rl-mark-ring" aria-hidden="true" />;

type Filter = "all" | ChecklistStatus;

export const ChecklistItems: React.FC<{ items: ChecklistItem[] }> = ({ items }) => {
  const [filter, setFilter] = useState<Filter>("all");
  const present = FILTER_ORDER.filter((status) => items.some((item) => item.status === status));
  const filterable = items.length >= FILTER_FROM && present.length >= 2;
  // A streamed-in change can remove the chosen status; fall back to All.
  const active: Filter = filterable && (filter === "all" || present.includes(filter)) ? filter : "all";
  const shown = active === "all" ? items : items.filter((item) => item.status === active);

  return (
    <>
      {filterable && (
        <div className="agw-rl-pills" role="group" aria-label="Show items">
          {(["all", ...present] as Filter[]).map((option) => (
            <button
              key={option}
              type="button"
              className="agw-rl-pill"
              aria-pressed={active === option}
              onClick={() => setFilter(option)}
            >
              {option === "all" ? "All" : CHECKLIST_STATUSES[option]}
              <span className="agw-rl-pill-count">
                {option === "all" ? items.length : items.filter((item) => item.status === option).length}
              </span>
            </button>
          ))}
        </div>
      )}
      <ul className="agw-rl-status-list" role="list">
        {shown.map((item, i) => (
          <li key={i} className="agw-rl-status-row" data-status={item.status}>
            <span className="agw-rl-status">
              <StatusMark status={item.status} />
              {CHECKLIST_STATUSES[item.status]}
            </span>
            <div className="agw-rl-item-body">
              <div className="agw-rl-node-title"><Field text={item.title} /></div>
              {item.caption && <div className="agw-rl-node-caption"><Field text={item.caption} /></div>}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
};
