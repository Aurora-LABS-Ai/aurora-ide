/**
 * Agent Window — Claude Code account list.
 *
 * Several Claude accounts can be stored; one of them — "main" — serves chats
 * (`api/claude_code/accounts.rs`). Same shape and classes as the Codex
 * switcher so the two subscription cards read as one system: collapsed to one
 * line by default, every account's own headroom when open.
 *
 * Unlike Codex there is no automatic failover yet, so the collapsed line
 * states a count rather than a pooled figure. Adding a total would promise
 * capacity Aurora does not reach on its own.
 */

import React, { useCallback, useEffect, useState } from "react";

import {
  claudeCodeAccountImportCli,
  claudeCodeAccountRemove,
  claudeCodeAccountSetMain,
  claudeCodeAccountsList,
  claudeCodeHighestUsedPercent,
  claudeCodePlanLabel,
  type ClaudeCodeAccountRow,
} from "@/apps/agent/services/providers/claude-code";
import { AgentIcon } from "../shared/AgentIcon";
import { AgwPill } from "./primitives";

const errorText = (err: unknown): string => (err as Error)?.message || String(err);

function accountName(row: ClaudeCodeAccountRow): string {
  return row.status.email || row.status.displayName || row.id;
}

const AccountRow: React.FC<{
  row: ClaudeCodeAccountRow;
  busy: boolean;
  onSetMain: () => void;
  onRemove: () => void;
}> = ({ row, busy, onSetMain, onRemove }) => {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const plan = claudeCodePlanLabel(row.status.plan);
  const used = claudeCodeHighestUsedPercent(row.usage);
  const name = accountName(row);
  const imported = row.source === "claude-code-import";

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
          {used != null && <span className="agw-codex-acct-used">{Math.round(used)}% used</span>}
          {row.usageError && (
            <span className="agw-codex-acct-used" title={row.usageError}>
              usage unavailable
            </span>
          )}
        </span>
      </button>

      <span className="agw-codex-acct-badges">
        {row.isMain && <AgwPill tone="success">Main</AgwPill>}
        {/* Says why this account can log Claude Code out (or the reverse):
            the two apps hold one sign-in between them. */}
        {imported && (
          <span
            className="agw-codex-acct-plan"
            title="Copied from Claude Code on this machine. The two share one sign-in."
          >
            From Claude Code
          </span>
        )}
        {!row.status.canInfer && <AgwPill tone="warning">Can't chat</AgwPill>}
        {row.status.signInAgainInDays != null && (
          <span title="This sign-in ends soon. Sign in to this account again to keep it.">
            <AgwPill tone="warning">
              {row.status.signInAgainInDays <= 1
                ? "Ends within a day"
                : `Ends in ${row.status.signInAgainInDays} days`}
            </AgwPill>
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

export const ClaudeCodeAccountSwitcher: React.FC<{
  /** Re-poll trigger: bumped by the card when a sign-in or refresh lands. */
  refreshToken: number;
  onAddAccount: () => void;
  /** Told when the list changes so the card can re-read the main account. */
  onChanged: () => void;
}> = ({ refreshToken, onAddAccount, onChanged }) => {
  const [rows, setRows] = useState<ClaudeCodeAccountRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    claudeCodeAccountsList()
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
                onSetMain={() => act(() => claudeCodeAccountSetMain(row.id))}
                onRemove={() => act(() => claudeCodeAccountRemove(row.id))}
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
                act(claudeCodeAccountImportCli, "Added the account Claude Code is signed into.")
              }
              disabled={busy}
              title="Copy the account Claude Code is signed into. Claude Code stays signed in."
            >
              Import from Claude Code
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ClaudeCodeAccountSwitcher;
