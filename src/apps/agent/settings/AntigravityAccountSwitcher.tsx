/**
 * Agent Window — Antigravity account list.
 *
 * Several Google accounts can be stored; one of them — "main" — serves chats
 * (`api/antigravity/accounts.rs`). Same shape and classes as the Claude Code
 * and Codex switchers, so the subscription cards read as one system:
 * collapsed to one line by default, each account's own quota when open.
 *
 * No automatic failover yet, so the collapsed line states a count, not a
 * pooled figure.
 */

import React, { useCallback, useEffect, useState } from "react";

import {
  antigravityAccountImportIde,
  antigravityAccountRemove,
  antigravityAccountSetMain,
  antigravityAccountsList,
  antigravityPlanLabel,
  type AntigravityAccountRow,
} from "@/apps/agent/services/providers/antigravity";
import { AgentIcon } from "../shared/AgentIcon";
import { AgwPill } from "./primitives";

const errorText = (err: unknown): string => (err as Error)?.message || String(err);

function accountName(row: AntigravityAccountRow): string {
  return row.status.email || row.status.name || row.id;
}

const AccountRow: React.FC<{
  row: AntigravityAccountRow;
  busy: boolean;
  onSetMain: () => void;
  onRemove: () => void;
}> = ({ row, busy, onSetMain, onRemove }) => {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const plan = antigravityPlanLabel(row.status);
  const name = accountName(row);
  const imported = row.source === "antigravity-import";

  return (
    <li className="agw-codex-acct" data-main={row.isMain || undefined}>
      <button
        type="button"
        className="agw-codex-acct-main"
        onClick={onSetMain}
        disabled={row.isMain || busy}
        title={row.isMain ? "Chats already use this account" : "Use this account for chats"}
      >
        <span className="agw-codex-acct-dot" aria-hidden="true" />
        <span className="agw-codex-acct-id">
          <span className="agw-codex-acct-email">{name}</span>
          {plan && <span className="agw-codex-acct-plan">{plan}</span>}
        </span>
        <span className="agw-codex-acct-stats">
          {row.lowestRemainingPercent != null && (
            <span
              className="agw-codex-acct-used"
              title="Quota left on the model pool closest to running out"
            >
              {Math.round(row.lowestRemainingPercent)}% left
            </span>
          )}
          {row.quotaError && (
            <span className="agw-codex-acct-used" title={row.quotaError}>
              quota unavailable
            </span>
          )}
        </span>
      </button>

      <span className="agw-codex-acct-badges">
        {row.isMain && <AgwPill tone="success">Main</AgwPill>}
        {imported && (
          <span
            className="agw-codex-acct-plan"
            title="Copied from Antigravity IDE on this machine. Both keep working independently."
          >
            From Antigravity IDE
          </span>
        )}
      </span>

      {confirmingRemove ? (
        <span className="agw-codex-acct-confirm">
          <button
            type="button"
            className="agw-codex-link"
            data-tone="danger"
            onClick={onRemove}
            disabled={busy}
          >
            Remove
          </button>
          <button type="button" className="agw-codex-link" onClick={() => setConfirmingRemove(false)}>
            Keep
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="agw-prov-icon-btn agw-codex-acct-remove"
          onClick={() => setConfirmingRemove(true)}
          disabled={busy}
          title={`Remove ${name} from Aurora`}
          aria-label={`Remove ${name} from Aurora`}
        >
          <AgentIcon name="trash" size={13} />
        </button>
      )}
    </li>
  );
};

export const AntigravityAccountSwitcher: React.FC<{
  /** Re-poll trigger: bumped by the card when a sign-in or refresh lands. */
  refreshToken: number;
  onAddAccount: () => void;
  /** Told when the list changes so the card can re-read the main account. */
  onChanged: () => void;
}> = ({ refreshToken, onAddAccount, onChanged }) => {
  const [rows, setRows] = useState<AntigravityAccountRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    antigravityAccountsList()
      .then((next) => {
        setRows(next);
        setError(null);
      })
      .catch((err) => setError(errorText(err)));
  }, []);

  useEffect(load, [load, refreshToken]);

  const act = useCallback(
    (run: () => Promise<unknown>, done?: string) => {
      setBusy(true);
      setError(null);
      setNote(null);
      run()
        .then(() => {
          if (done) setNote(done);
          load();
          onChanged();
        })
        .catch((err) => setError(errorText(err)))
        .finally(() => setBusy(false));
    },
    [load, onChanged],
  );

  if (error && !rows) {
    return (
      <div className="agw-codex-note" data-tone="error">
        {error}
      </div>
    );
  }
  if (!rows) return null;

  const count = rows.length;

  return (
    <div className="agw-codex-accounts" data-open={open || undefined}>
      <button
        type="button"
        className="agw-codex-accounts-summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <AgentIcon name="chevron-down" size={13} />
        <span className="agw-codex-accounts-total">
          {count === 1 ? "1 account" : `${count} accounts`}
        </span>
        <span className="agw-codex-accounts-hint">
          {open ? "Hide accounts" : count > 1 ? "Per account" : "Manage"}
        </span>
      </button>

      {open && (
        <div className="agw-codex-accounts-body">
          <ul className="agw-codex-acct-list">
            {rows.map((row) => (
              <AccountRow
                key={row.id}
                row={row}
                busy={busy}
                onSetMain={() => act(() => antigravityAccountSetMain(row.id))}
                onRemove={() => act(() => antigravityAccountRemove(row.id))}
              />
            ))}
          </ul>

          {error && (
            <div className="agw-codex-note" data-tone="error">
              {error}
            </div>
          )}
          {note && <div className="agw-codex-note">{note}</div>}

          <div className="agw-codex-accounts-actions">
            <button type="button" className="agw-codex-link" onClick={onAddAccount} disabled={busy}>
              <AgentIcon name="plus" size={12} /> Add account
            </button>
            <button
              type="button"
              className="agw-codex-link"
              onClick={() =>
                act(antigravityAccountImportIde, "Added the account Antigravity IDE is signed into.")
              }
              disabled={busy}
              title="Copy the account Antigravity IDE is signed into. The IDE stays signed in."
            >
              Import from Antigravity IDE
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default AntigravityAccountSwitcher;
