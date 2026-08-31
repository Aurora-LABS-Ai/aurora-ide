/**
 * Agent Window — Codex account switcher.
 *
 * Several ChatGPT accounts pool their credits; one of them — "main" — serves
 * requests, and Aurora falls through to another only while main's window is
 * spent (`api/codex/accounts.rs`).
 *
 * Two rules drive the whole layout:
 *
 * 1. **The headline number has to be true.** It is the pooled total *because*
 *    the pool is genuinely reachable — failover is real. Where it cannot be
 *    (an account whose usage would not load, or one reporting unlimited), the
 *    summary says which rather than quietly summing what it happened to get.
 * 2. **Collapsed by default, and complete when open.** Someone with one
 *    account should never see a switcher; someone with four needs every
 *    account's own headroom, which is exactly what the collapsed line cannot
 *    show. So the summary is the control that opens it.
 *
 * Lives beside `CodexUsageCard` rather than inside it: the card was already
 * 364 lines of sign-in phases and meters, and this is a self-contained concern
 * with its own loading and error states.
 */

import React, { useCallback, useEffect, useState } from "react";

import {
  codexAccountClearLimit,
  codexAccountImportCli,
  codexAccountRemove,
  codexAccountSetMain,
  codexAccountsList,
  codexFmtCredits,
  codexPlanLabel,
  type CodexAccountRow,
  type CodexAccountsSnapshot,
} from "@/apps/agent/services/providers/codex";
import { AgentIcon } from "../shared/AgentIcon";
import { AgwPill } from "./primitives";

/** Credits for one row, or `null` when its usage could not be read. */
function rowCredits(row: CodexAccountRow): string | null {
  const credits = row.usage?.credits;
  if (!credits?.hasCredits) return null;
  if (credits.unlimited) return "unlimited";
  return credits.balance;
}

/** The heaviest-used window, which is the one about to run out. */
function rowUsedPercent(row: CodexAccountRow): number | null {
  const windows = [row.usage?.primary, row.usage?.secondary].filter(Boolean);
  if (windows.length === 0) return null;
  return Math.max(...windows.map((w) => w!.usedPercent));
}

/**
 * One line that has to answer "how much have I got, really".
 *
 * The qualifier is not padding. A total over 3 of 4 accounts read as a total
 * over 4 is the card lying about capacity the user is deciding against.
 */
function summaryLabel(snapshot: CodexAccountsSnapshot): string {
  const { totalCredits, anyUnlimited, counted, total } = snapshot;
  if (total === 0) return "No accounts yet";
  if (anyUnlimited && totalCredits != null) {
    return `${codexFmtCredits(totalCredits)} credits + unlimited on one account`;
  }
  if (anyUnlimited) return "Unlimited credits";
  if (totalCredits == null) return `${total} ${total === 1 ? "account" : "accounts"}`;
  const noun = `${codexFmtCredits(totalCredits)} credits`;
  if (counted < total) {
    return `${noun} across ${counted} of ${total} accounts`;
  }
  return total === 1 ? noun : `${noun} across ${total} accounts`;
}

const AccountRow: React.FC<{
  row: CodexAccountRow;
  onSetMain: () => void;
  onRemove: () => void;
  onClearLimit: () => void;
  busy: boolean;
}> = ({ row, onSetMain, onRemove, onClearLimit, busy }) => {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const credits = rowCredits(row);
  const used = rowUsedPercent(row);
  const spent = row.spent;
  const plan = codexPlanLabel(row.planType);

  return (
    <li className="agw-codex-acct" data-main={row.isMain || undefined} data-spent={spent || undefined}>
      {/* The whole row is the control that makes this account main — a
          hairline target beside four other hairline targets would be a
          precision test for something with no downside to getting right. */}
      <button
        type="button"
        className="agw-codex-acct-main"
        onClick={onSetMain}
        disabled={row.isMain || busy}
        title={row.isMain ? "Already the main account" : "Use this account"}
      >
        <span className="agw-codex-acct-dot" aria-hidden="true" />
        <span className="agw-codex-acct-id">
          <span className="agw-codex-acct-email">{row.email ?? row.accountId}</span>
          {plan && <span className="agw-codex-acct-plan">{plan}</span>}
        </span>
        <span className="agw-codex-acct-stats">
          {credits != null && <span className="agw-codex-acct-credits">{credits}</span>}
          {used != null && (
            <span className="agw-codex-acct-used">{Math.round(used)}% used</span>
          )}
          {row.usageError && (
            <span className="agw-codex-acct-used" title={row.usageError}>
              usage unavailable
            </span>
          )}
        </span>
      </button>

      <span className="agw-codex-acct-badges">
        {row.isMain && <AgwPill tone="success">Main</AgwPill>}
        {/* Only worth saying when it contradicts the badge above — otherwise
            every row would carry a status nobody needs to read. */}
        {row.isActive && !row.isMain && <AgwPill tone="warning">In use</AgwPill>}
        {spent && (
          <button
            type="button"
            className="agw-codex-link"
            onClick={onClearLimit}
            disabled={busy}
            title="Mark this account as available again"
          >
            Spent · reset
          </button>
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
          <button
            type="button"
            className="agw-codex-link"
            onClick={() => setConfirmingRemove(false)}
          >
            Keep
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="agw-prov-icon-btn agw-codex-acct-remove"
          onClick={() => setConfirmingRemove(true)}
          disabled={busy}
          title={`Remove ${row.email ?? row.accountId} from Aurora`}
          aria-label={`Remove ${row.email ?? row.accountId} from Aurora`}
        >
          <AgentIcon name="trash" size={13} />
        </button>
      )}
    </li>
  );
};

export const CodexAccountSwitcher: React.FC<{
  /** Re-poll trigger: bumped by the card when sign-in or a refresh lands. */
  refreshToken: number;
  onAddAccount: () => void;
  /** Told when the account list changes so the card can re-read its own state. */
  onChanged: () => void;
}> = ({ refreshToken, onAddAccount, onChanged }) => {
  const [snapshot, setSnapshot] = useState<CodexAccountsSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    codexAccountsList()
      .then((next) => {
        setSnapshot(next);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }, []);

  useEffect(load, [load, refreshToken]);

  const act = useCallback(
    (run: () => Promise<unknown>) => {
      setBusy(true);
      setNote(null);
      run()
        .then(() => {
          load();
          onChanged();
        })
        .catch((err) => setError(String(err)))
        .finally(() => setBusy(false));
    },
    [load, onChanged],
  );

  const importFromCli = useCallback(() => {
    setBusy(true);
    setError(null);
    codexAccountImportCli()
      .then(() => {
        setNote("Added the account Codex CLI is signed into.");
        load();
        onChanged();
      })
      .catch((err) => setError(String(err)))
      .finally(() => setBusy(false));
  }, [load, onChanged]);

  if (error && !snapshot) {
    return <div className="agw-codex-note" data-tone="error">{error}</div>;
  }
  if (!snapshot) return null;

  const { accounts } = snapshot;

  return (
    <div className="agw-codex-accounts" data-open={open || undefined}>
      <button
        type="button"
        className="agw-codex-accounts-summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <AgentIcon name="chevron-down" size={13} />
        <span className="agw-codex-accounts-total">{summaryLabel(snapshot)}</span>
        <span className="agw-codex-accounts-hint">
          {open ? "Hide accounts" : accounts.length > 1 ? "Per account" : "Manage"}
        </span>
      </button>

      {open && (
        <div className="agw-codex-accounts-body">
          {accounts.length > 0 ? (
            <ul className="agw-codex-acct-list">
              {accounts.map((row) => (
                <AccountRow
                  key={row.accountId}
                  row={row}
                  busy={busy}
                  onSetMain={() => act(() => codexAccountSetMain(row.accountId))}
                  onRemove={() => act(() => codexAccountRemove(row.accountId))}
                  onClearLimit={() => act(() => codexAccountClearLimit(row.accountId))}
                />
              ))}
            </ul>
          ) : (
            <div className="agw-atlas-note">
              No accounts stored yet. Add one below — each keeps its own limits
              and credits, and Aurora moves to the next when one runs out.
            </div>
          )}

          {error && <div className="agw-codex-note" data-tone="error">{error}</div>}
          {note && <div className="agw-codex-note">{note}</div>}

          <div className="agw-codex-accounts-actions">
            <button
              type="button"
              className="agw-codex-link"
              onClick={onAddAccount}
              disabled={busy}
            >
              <AgentIcon name="plus" size={12} /> Add account
            </button>
            <button
              type="button"
              className="agw-codex-link"
              onClick={importFromCli}
              disabled={busy}
              title="Copy the account Codex CLI is signed into. The CLI is not signed out."
            >
              Import from Codex CLI
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default CodexAccountSwitcher;
