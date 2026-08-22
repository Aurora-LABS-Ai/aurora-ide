/**
 * Agent Window — OpenCode Go provider card.
 *
 * OpenCode Go is an ordinary OpenAI-compatible provider with an ordinary key,
 * so it gets the ordinary treatment: the standard connection fields and the
 * standard Models section handle everything below this card, and its models
 * are edited, priced and deleted with the same controls every other provider's
 * models use.
 *
 * This card carries only what is genuinely different about a **subscription**:
 *
 * 1. **How much of the plan is left.** There is no per-token price, so headroom
 *    is the honest figure — and OpenCode publishes it per window. All three are
 *    shown rather than the smallest: hitting the weekly cap on a Tuesday and
 *    hitting the rolling cap for ten minutes are different problems.
 * 2. **The key you already have.** OpenCode's own CLI stores it; a subscription
 *    someone has already set up should not have to be set up twice.
 * 3. **One button to add the plan's models**, so nobody types 29 ids by hand.
 */

import React, { useCallback, useEffect, useState } from "react";

import {
  fetchOpenCodeUsage,
  openCodeAuthPath,
  openCodeLocalKey,
  openCodeResetLabel,
  OPENCODE_KEY_URL,
  OPENCODE_PROVIDER_ID,
  type OpenCodeUsage,
} from "@/apps/agent/services/providers/opencode";
import { importOpenCodeModels } from "@/apps/agent/services/providers/opencode-sync";
import { AgentIcon } from "../shared/AgentIcon";
import { ProviderAvatar } from "./ProviderAvatar";
import { AgwButton, AgwSwitch } from "./primitives";

/** A percentage bar reads as pressure, so the tone has to match the reading. */
function toneFor(percent: number): "ok" | "warn" | "danger" {
  if (percent >= 90) return "danger";
  if (percent >= 70) return "warn";
  return "ok";
}

const WINDOWS: Array<{ key: keyof OpenCodeUsage; label: string }> = [
  { key: "rolling", label: "Right now" },
  { key: "weekly", label: "This week" },
  { key: "monthly", label: "This month" },
];

export const OpenCodeProviderCard: React.FC<{
  apiKey: string;
  enabled: boolean;
  onToggleEnabled: (next: boolean) => void;
  /** Write the imported key into the provider row. */
  onKeyImported: (key: string) => void;
}> = ({ apiKey, enabled, onToggleEnabled, onKeyImported }) => {
  const [usage, setUsage] = useState<OpenCodeUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // A key sitting in the OpenCode CLI's own credential store. `undefined`
  // while we are still looking, `null` once we know there is none.
  const [localKey, setLocalKey] = useState<string | null | undefined>(undefined);
  const [authPath, setAuthPath] = useState<string | null>(null);

  const key = apiKey.trim();

  const loadUsage = useCallback(async () => {
    if (!key) {
      setUsage(null);
      setError(null);
      return;
    }
    try {
      setUsage(await fetchOpenCodeUsage(key));
      setError(null);
    } catch (err) {
      setUsage(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [key]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  // Only looked for while there is no key to replace: an offer to import one
  // over a working key is a control that can only do harm.
  useEffect(() => {
    if (key) {
      setLocalKey(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const found = await openCodeLocalKey();
        if (!alive) return;
        setLocalKey(found);
        if (!found) setAuthPath(await openCodeAuthPath());
      } catch {
        // A missing install is the ordinary case, not an error worth showing.
        if (alive) setLocalKey(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [key]);

  const addPlanModels = async () => {
    setImporting(true);
    setNote(null);
    setError(null);
    try {
      const { added, skipped } = await importOpenCodeModels();
      setNote(
        added === 0
          ? `Your plan's ${skipped} models are already listed below.`
          : `Added ${added} model${added === 1 ? "" : "s"} below — remove any you don't want.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <section className="agw-atlas" aria-label="OpenCode Go">
      <div className="agw-atlas-head">
        <ProviderAvatar provider={{ id: OPENCODE_PROVIDER_ID, name: "OpenCode" }} />
        <div className="agw-atlas-head-titles">
          <div className="agw-atlas-title">
            OpenCode Go
            {key && !error && <span className="agw-sub-plan">Subscription</span>}
          </div>
          <div className="agw-atlas-sub">
            {key
              ? "Your plan's models, and how much of the plan is left"
              : "Add your subscription key below to start"}
          </div>
        </div>
        <div className="agw-atlas-head-actions">
          {key && (
            <button
              type="button"
              className="agw-prov-icon-btn"
              title="Refresh plan usage"
              aria-label="Refresh plan usage"
              onClick={() => void loadUsage()}
            >
              <AgentIcon name="retry" size={14} />
            </button>
          )}
          <a
            className="agw-prov-icon-btn"
            href={OPENCODE_KEY_URL}
            target="_blank"
            rel="noreferrer"
            title="Open your OpenCode key page"
            aria-label="Open your OpenCode key page"
          >
            <AgentIcon name="external" size={14} />
          </a>
          <span className="agw-atlas-head-sep" aria-hidden="true" />
          <AgwSwitch
            checked={enabled}
            onChange={onToggleEnabled}
            ariaLabel="Enable OpenCode Go"
          />
        </div>
      </div>

      <div className="agw-atlas-body agw-opencode-body">
        {!key ? (
          <div className="agw-opencode-connect">
            <p>
              OpenCode Go is the subscription plan — a flat rate rather than
              credits.
            </p>
            {localKey ? (
              <>
                <p>
                  You're already signed in to OpenCode on this machine. Aurora
                  can use that same subscription key — nothing is sent anywhere
                  and the OpenCode CLI keeps working.
                </p>
                <AgwButton
                  variant="primary"
                  icon="plug"
                  onClick={() => onKeyImported(localKey)}
                >
                  Use my OpenCode key
                </AgwButton>
              </>
            ) : (
              <>
                <p>
                  Paste your subscription key below and your plan's models
                  appear here.
                </p>
                {localKey === null && authPath && (
                  <p className="agw-opencode-hint">
                    No OpenCode sign-in found. Looked in <code>{authPath}</code>.
                  </p>
                )}
              </>
            )}
          </div>
        ) : (
          <>
            {error ? (
              <div className="agw-opencode-error" role="status">
                {error}
              </div>
            ) : usage ? (
              <div className="agw-opencode-windows">
                {WINDOWS.map(({ key: windowKey, label }) => {
                  const w = usage[windowKey];
                  if (!w) return null;
                  const reset = openCodeResetLabel(w);
                  return (
                    <div key={windowKey} className="agw-opencode-window">
                      <div className="agw-opencode-window-head">
                        <span className="agw-opencode-window-label">{label}</span>
                        <span className="agw-opencode-window-meta">
                          {/* The number people act on is what is LEFT, not what
                              is spent — both carry the same fact, but only one
                              answers "can I keep going". */}
                          {Math.round(100 - w.percent)}% left
                          {reset ? ` · ${reset}` : ""}
                        </span>
                      </div>
                      <div className="agw-atlas-meter">
                        <div
                          className="agw-atlas-meter-fill"
                          data-tone={toneFor(w.percent)}
                          style={{ width: `${Math.max(w.percent, 1)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="agw-atlas-skeleton" />
            )}

            {/* Saves typing 29 ids by hand. Everything after this happens in
                the standard Models section below, with the standard controls. */}
            <div className="agw-opencode-import">
              <AgwButton icon="plus" onClick={() => void addPlanModels()} disabled={importing}>
                {importing ? "Adding…" : "Add my plan's models"}
              </AgwButton>
              <span>
                {note ??
                  "Adds every model your plan reaches to the list below, with its details filled in. Edit or remove them there."}
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  );
};
