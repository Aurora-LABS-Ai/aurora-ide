/**
 * Agent Window — composer: the `@` and `/` pickers.
 *
 * Two lists that share one shell (`ComposerMenu`) and one row style. The
 * composer owns the state (query, highlight, what a pick does); these draw it.
 * Moved out of `AgentComposer.tsx` on 2026-10-19.
 */

import React, { type RefObject } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { FileIcon, FolderIcon } from "@/kernel/ui/FileIcons";
import { ComposerMenu } from "@/apps/agent/components/composer/ComposerMenu";
import type { MentionGroup, MentionRow } from "@/apps/agent/components/composer/mention-groups";
import type { PromptCommand } from "@/apps/agent/adapters/prompt-commands";
import { COMMAND_ICON, titleMatches } from "./composer-pills";

/** A name with its matched letters picked out, so the reader sees why it is listed. */
export const MatchedName: React.FC<{ text: string; matches: number[] }> = ({ text, matches }) => {
  if (matches.length === 0) return <>{text}</>;
  const hit = new Set(matches);
  const parts: React.ReactNode[] = [];
  let run = "";
  let runHit = hit.has(0);
  const flush = (i: number) => {
    if (!run) return;
    parts.push(runHit ? <mark key={i} className="agw-mention-hit">{run}</mark> : run);
    run = "";
  };
  [...text].forEach((ch, i) => {
    if (hit.has(i) !== runHit) {
      flush(i);
      runHit = hit.has(i);
    }
    run += ch;
  });
  flush(text.length);
  return <>{parts}</>;
};

/** The picker's foot: the keys it answers to, and how many rows it holds. */
export const MenuKeys: React.FC<{ count: number }> = ({ count }) => (
  <div className="agw-mention-foot" aria-hidden>
    <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
    <span><kbd>↵</kbd> add</span>
    <span><kbd>esc</kbd> close</span>
    <span className="agw-mention-foot-count">
      {count} {count === 1 ? "match" : "matches"}
    </span>
  </div>
);

interface PickerShellProps {
  placement: "up" | "down";
  anchorRef: RefObject<HTMLDivElement>;
}

interface MentionPickerProps extends PickerShellProps {
  query: string;
  groups: MentionGroup[];
  /** Every row across groups, in order — what ↑ ↓ move through. */
  rowCount: number;
  /** True when the query matched nothing and the list has loaded. */
  empty: boolean;
  selected: number;
  onHighlight: (index: number) => void;
  onPick: (row: MentionRow) => void;
  activeRef: RefObject<HTMLButtonElement>;
}

/** Files, folders, terminals, grouped (probe: aurora-mention-picker-designs.html, 02). */
export const MentionPicker: React.FC<MentionPickerProps> = ({
  query,
  groups,
  rowCount,
  empty,
  selected,
  onHighlight,
  onPick,
  activeRef,
  placement,
  anchorRef,
}) => {
  // Rows are numbered across groups, because ↑ ↓ move through all of them.
  let index = 0;
  return (
    <ComposerMenu
      resetKey={query}
      placement={placement}
      anchorRef={anchorRef}
      footer={<MenuKeys count={rowCount} />}
    >
      {empty && (
        <div className="agw-mention-empty">
          No file, folder or terminal matches “{query.trim()}”.
        </div>
      )}
      {groups.map((group) => (
        <React.Fragment key={group.label}>
          <div className="agw-mention-group" role="presentation">
            {group.label}
          </div>
          {group.rows.map((row) => {
            const i = index++;
            const active = i === selected;
            const common = {
              ref: active ? activeRef : undefined,
              type: "button" as const,
              className: "agw-mention-item",
              "data-active": active || undefined,
              // `onMouseMove`, not `onMouseEnter`: scrolling the list
              // under a stationary cursor fires enter and would drag the
              // highlight back to whatever row slid beneath the pointer.
              onMouseMove: () => onHighlight(i),
              onMouseDown: (e: React.MouseEvent) => {
                e.preventDefault();
                onPick(row);
              },
            };
            if (row.kind === "terminal") {
              const { session } = row;
              return (
                <button key={`term-${session.id}`} {...common}>
                  <AgentIcon name="terminal" size={13} className="agw-file-ico" />
                  <span className="agw-mention-name">{session.title}</span>
                  <span className="agw-mention-where">
                    {session.running ? session.cwd ?? session.shell : "exited"}
                  </span>
                </button>
              );
            }
            const { file, matches } = row;
            const folder = file.rel.includes("/")
              ? file.rel.slice(0, file.rel.lastIndexOf("/"))
              : "";
            return (
              <button key={`${row.kind}-${file.rel}`} {...common}>
                {row.kind === "folder" ? (
                  <FolderIcon name={file.name} path={file.path} className="agw-file-ico" />
                ) : (
                  <FileIcon name={file.name} path={file.path} className="agw-file-ico" />
                )}
                <span className="agw-mention-name">
                  <MatchedName text={file.name} matches={matches} />
                </span>
                {folder && (
                  // Read from its END: the last folders are what tell two
                  // `index.ts` apart, so the start is what gets cut.
                  <span className="agw-mention-where" dir="rtl">
                    <bdi>{folder}</bdi>
                  </span>
                )}
              </button>
            );
          })}
        </React.Fragment>
      ))}
    </ComposerMenu>
  );
};

interface CommandPickerProps extends PickerShellProps {
  query: string;
  groups: Array<{ label: string; rows: PromptCommand[] }>;
  rowCount: number;
  selected: number;
  onHighlight: (index: number) => void;
  onPick: (command: PromptCommand) => void;
  activeRef: RefObject<HTMLButtonElement>;
}

/** Skills · rules · MCP · actions — same shell and rows as `@`; grouped by kind when nothing is typed. */
export const CommandPicker: React.FC<CommandPickerProps> = ({
  query,
  groups,
  rowCount,
  selected,
  onHighlight,
  onPick,
  activeRef,
  placement,
  anchorRef,
}) => {
  let index = 0;
  return (
    <ComposerMenu
      resetKey={query}
      placement={placement}
      anchorRef={anchorRef}
      footer={<MenuKeys count={rowCount} />}
    >
      {groups.map((group) => (
        <React.Fragment key={group.label}>
          <div className="agw-mention-group" role="presentation">
            {group.label}
          </div>
          {group.rows.map((c) => {
            const i = index++;
            return (
              <button
                key={c.key}
                ref={i === selected ? activeRef : undefined}
                type="button"
                className="agw-mention-item"
                data-active={i === selected || undefined}
                // See the mention list: movement, not mere entry, changes
                // the highlight, so keyboard navigation is never undone by
                // a cursor that simply happens to be resting over the menu.
                onMouseMove={() => onHighlight(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(c);
                }}
              >
                <AgentIcon name={COMMAND_ICON[c.kind]} size={14} className="agw-file-ico" />
                <span className="agw-mention-name">
                  <MatchedName text={c.title} matches={titleMatches(c.title, query)} />
                </span>
                <span className="agw-cmd-source">{c.sourceLabel}</span>
                <span className="agw-mention-path">{c.subtitle}</span>
              </button>
            );
          })}
        </React.Fragment>
      ))}
    </ComposerMenu>
  );
};
