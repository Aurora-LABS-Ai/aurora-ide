/**
 * Settings › Providers — a category heading in the rail.
 *
 * The same disclosure the rail already uses for Built-in and Custom, with three
 * things added: a colour dot so a category is findable by shape as well as by
 * reading, a plus that adds a provider INTO this category, and a pencil that
 * opens one strip holding every edit a category has.
 *
 * ## Why the plus lives on the heading
 *
 * Because that is where you are already looking. The rail established this with
 * the Images group (`.agw-prov-group-add`): quiet until the group is hovered or
 * focused, then a plus that adds one of THIS kind of thing. A category has the
 * same job, so it gets the same control rather than a new one.
 *
 * It matters more here than it did there. A provider now has to live in a
 * category, so "add a provider" is never a question on its own — it is always
 * "add a provider to something", and a button that cannot say which one would
 * have to guess.
 *
 * ## Why one edit strip instead of a menu
 *
 * Rename, recolour, reorder and delete are all "edit this category", and they
 * are all rare. Five hover-revealed icons on a heading turns a quiet rail into
 * a control panel; a popover menu is a whole new surface to build, place and
 * dismiss. One pencil that swaps the heading for a strip costs neither, and it
 * puts the name field where the name already was.
 *
 * Delete confirms in place inside that strip, the way the kenari card's
 * Disconnect does, and it says where the providers go — nothing is deleted with
 * the category, and someone about to click Delete should not have to guess that.
 */

import React, { useEffect, useRef, useState } from "react";

import {
  CATEGORY_COLORS,
  CATEGORY_NAME_MAX,
  type CategoryColor,
  type ProviderCategory,
} from "@/apps/agent/services/providers/provider-categories";
import { AgentIcon } from "../shared/AgentIcon";

/** Token per colour name, so a category cannot paint outside the theme. */
const COLOR_VAR: Record<CategoryColor, string> = {
  neutral: "var(--agw-text-subtle)",
  accent: "var(--agw-accent)",
  added: "var(--agw-added)",
  warning: "var(--agw-warning)",
  removed: "var(--agw-removed)",
  info: "var(--agw-info)",
};

export interface ProviderCategoryHeaderProps {
  category: ProviderCategory;
  /** How many providers are in it. Drawn even when zero. */
  count: number;
  open: boolean;
  /** True when this is the category the footer's Add provider will fill. */
  selected: boolean;
  /**
   * Whether a provider can be created here at all.
   *
   * False for Built-in: those rows come from Aurora's catalogue and are
   * re-seeded every launch, so anything created under that heading would be a
   * custom provider filed under a name that says otherwise.
   */
  canAddProviders: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onAddProvider: () => void;
  /** Returns false when the name was refused, which keeps the field open. */
  onRename: (name: string) => boolean;
  onRecolor: (color: CategoryColor) => void;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}

export const ProviderCategoryHeader: React.FC<ProviderCategoryHeaderProps> = ({
  category,
  count,
  open,
  selected,
  canAddProviders,
  onToggle,
  onSelect,
  onAddProvider,
  onRename,
  onRecolor,
  onMove,
  onDelete,
  canMoveUp,
  canMoveDown,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(category.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [refused, setRefused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * The strip itself, so leaving the name field can tell "moved to another
   * control in here" from "left the strip entirely".
   *
   * Without it the strip was a trap: every control inside it — Delete, the
   * colour swatches, move up and down — takes focus off the name input first,
   * which committed the rename and closed the strip before the click could
   * land. Delete was therefore unreachable, and the two obvious readings of
   * that are "the button is broken" and "there is no way to delete a
   * category". Both were effectively true.
   */
  const stripRef = useRef<HTMLDivElement>(null);

  // Seeded when editing BEGINS rather than on every render, so a rename in
  // flight is not overwritten by a store update landing underneath it.
  const beginEdit = () => {
    setDraft(category.name);
    setRefused(false);
    setConfirmingDelete(false);
    setEditing(true);
  };

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    // Unchanged, or emptied and abandoned: leave without complaint. Only a
    // real attempt at a new name can be refused.
    if (next === category.name || next.length === 0) {
      setEditing(false);
      setRefused(false);
      return;
    }
    if (onRename(next)) {
      setEditing(false);
      setRefused(false);
    } else {
      // Taken, or empty after normalizing. The field stays open with the text
      // intact — retyping it from scratch is the wrong thing to ask for.
      setRefused(true);
      inputRef.current?.focus();
    }
  };

  const cancel = () => {
    setDraft(category.name);
    setEditing(false);
    setRefused(false);
  };

  if (editing) {
    return (
      <div
        ref={stripRef}
        className="agw-prov-cat-edit"
        data-tone={refused ? "error" : undefined}
      >
        <div className="agw-prov-cat-edit-row">
          <input
            ref={inputRef}
            className="agw-prov-cat-name-input"
            value={draft}
            maxLength={CATEGORY_NAME_MAX}
            aria-label={`Rename ${category.name}`}
            aria-invalid={refused || undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              setRefused(false);
            }}
            // The three rules every inline rename in this window follows:
            // Enter saves, Escape restores what was there, leaving saves too.
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              }
            }}
            onBlur={(e) => {
              // Focus moving to another control inside this strip is not
              // "done editing" — it is the next step of editing. Committing
              // there closes the strip under the click that caused it.
              // `relatedTarget` is the element receiving focus, so this works
              // for Tab as well as for a mouse.
              if (stripRef.current?.contains(e.relatedTarget as Node | null)) return;
              commit();
            }}
          />
          <button
            type="button"
            className="agw-prov-cat-edit-done"
            onClick={commit}
            title="Done"
            aria-label="Done renaming"
          >
            <AgentIcon name="check" size={13} />
          </button>
        </div>

        {refused && (
          <p className="agw-prov-cat-edit-note">
            There is already a category with that name.
          </p>
        )}

        <div className="agw-prov-cat-edit-row">
          <div className="agw-prov-cat-swatches" role="radiogroup" aria-label="Category colour">
            {CATEGORY_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className="agw-prov-cat-swatch"
                role="radio"
                aria-checked={category.color === color}
                aria-label={color}
                title={color}
                data-on={category.color === color || undefined}
                style={{ ["--sw" as string]: COLOR_VAR[color] }}
                onClick={() => onRecolor(color)}
              />
            ))}
          </div>
          <div className="agw-prov-cat-edit-actions">
            <button
              type="button"
              className="agw-prov-cat-edit-btn"
              onClick={() => onMove(-1)}
              disabled={!canMoveUp}
              title="Move up"
              aria-label="Move category up"
            >
              <AgentIcon name="chevron-down" size={12} style={{ transform: "rotate(180deg)" }} />
            </button>
            <button
              type="button"
              className="agw-prov-cat-edit-btn"
              onClick={() => onMove(1)}
              disabled={!canMoveDown}
              title="Move down"
              aria-label="Move category down"
            >
              <AgentIcon name="chevron-down" size={12} />
            </button>
          </div>
        </div>

        {confirmingDelete ? (
          <div className="agw-prov-cat-confirm">
            {/* Says where the providers go. Nothing is deleted with a category,
                and someone about to press this should not have to guess. */}
            <span>
              {count === 0
                ? "Delete this category?"
                : `${count} provider${count === 1 ? "" : "s"} move back to Built-in or Custom. Nothing is deleted.`}
            </span>
            <div className="agw-prov-cat-confirm-actions">
              <button
                type="button"
                className="agw-prov-cat-link"
                data-tone="danger"
                onClick={onDelete}
              >
                Delete
              </button>
              <button
                type="button"
                className="agw-prov-cat-link"
                onClick={() => setConfirmingDelete(false)}
              >
                Keep
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="agw-prov-cat-link"
            data-tone="danger"
            onClick={() => setConfirmingDelete(true)}
          >
            Delete category
          </button>
        )}
      </div>
    );
  }

  /** A nested icon action. A real <button> inside a <button> is invalid HTML,
   *  so these are spans with a button's role and keyboard handling — the same
   *  shape the Images group's plus already uses. */
  const iconAction = (
    key: string,
    icon: "plus" | "pencil",
    label: string,
    run: () => void,
  ) => (
    <span
      key={key}
      className="agw-prov-group-add"
      role="button"
      tabIndex={0}
      title={label}
      aria-label={label}
      onClick={(e) => {
        // Without this the heading's own click fires too and the category
        // folds shut around the row that just arrived.
        e.preventDefault();
        e.stopPropagation();
        run();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        run();
      }}
    >
      <AgentIcon name={icon} size={icon === "plus" ? 13 : 12} />
    </span>
  );

  return (
    // ONE button for the whole heading, doing ONE thing: fold it, and make it
    // the add target on the way.
    //
    // It was two overlapping controls — a chevron that folded and a name that
    // targeted — and that is unusable. The outcome depended on which pixel you
    // hit, so the same heading appeared to expand, collapse, or do nothing at
    // random. A row that behaves differently across its own width is broken
    // even when every branch is individually correct.
    <button
      type="button"
      className="agw-prov-group-label agw-prov-cat-label"
      data-on={selected || undefined}
      aria-expanded={open}
      onClick={() => {
        onToggle();
        onSelect();
      }}
      title={open ? `Collapse ${category.name}` : `Expand ${category.name}`}
    >
      <span className="agw-prov-group-name">
        <AgentIcon
          name="chevron-down"
          size={11}
          className="agw-prov-group-caret"
          style={{ transform: open ? undefined : "rotate(-90deg)" }}
        />
        <span
          className="agw-prov-cat-dot"
          style={{ background: COLOR_VAR[category.color] }}
          aria-hidden="true"
        />
        <span className="agw-prov-cat-name">{category.name}</span>
      </span>
      <span className="agw-prov-group-count">{count}</span>

      {/* Built-in carries NO plus. Its rows are seeded from Aurora's own
          catalogue and re-seeded on every launch, so "add a provider here"
          is not a thing that can happen — the row you made would be a custom
          provider sitting under a heading that says it shipped with Aurora.
          Custom keeps its plus: an unfiled new provider genuinely does live
          there, so the offer is real. */}
      {canAddProviders &&
        iconAction("add", "plus", `Add a provider to ${category.name}`, onAddProvider)}

      {/* The seeds carry no pencil: their names state where their rows came
          from, so a renamed one would describe rows it does not match. */}
      {/* Names what is behind it, rather than just "Edit". Delete lives inside
          this strip and nothing on the resting heading said so, which made
          removing a category look impossible. */}
      {!category.system &&
        iconAction(
          "edit",
          "pencil",
          `${category.name}: rename, recolour, reorder or delete`,
          beginEdit,
        )}
    </button>
  );
};

/**
 * The dashed row that makes a category.
 *
 * Present at all times rather than behind a button, because on this page it is
 * the first thing a new install has to do: with no category there is nowhere to
 * put a provider, and a rail whose only affordance is hidden reads as finished.
 */
export const NewCategoryRow: React.FC<{
  /** Returns false when the name was refused, which keeps the field open. */
  onCreate: (name: string) => boolean;
}> = ({ onCreate }) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [refused, setRefused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const commit = () => {
    const name = draft.trim();
    if (name.length === 0) {
      setOpen(false);
      setRefused(false);
      return;
    }
    if (onCreate(name)) {
      setDraft("");
      setRefused(false);
      // Left open: naming two or three categories in a row is the normal way
      // this page gets set up, and reopening the field each time is friction
      // for no gain.
      inputRef.current?.focus();
    } else {
      setRefused(true);
    }
  };

  if (!open) {
    return (
      <button type="button" className="agw-prov-cat-new" onClick={() => setOpen(true)}>
        <AgentIcon name="plus" size={12} />
        New category
      </button>
    );
  }

  return (
    <div className="agw-prov-cat-new-open" data-tone={refused ? "error" : undefined}>
      <input
        ref={inputRef}
        className="agw-prov-cat-name-input"
        value={draft}
        maxLength={CATEGORY_NAME_MAX}
        placeholder="Coding plans"
        aria-label="New category name"
        aria-invalid={refused || undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          setRefused(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft("");
            setRefused(false);
            setOpen(false);
          }
        }}
        onBlur={() => {
          if (draft.trim().length === 0) setOpen(false);
          else commit();
        }}
      />
      {refused && (
        <p className="agw-prov-cat-edit-note">There is already a category with that name.</p>
      )}
    </div>
  );
};

export default ProviderCategoryHeader;
