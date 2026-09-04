/**
 * Agent Window — Settings · Preferences · reaching Aurora from outside it.
 *
 * Putting `aurora` on PATH, and putting Aurora in Explorer's right-click menu.
 *
 * ## Why it lives here
 *
 * This was on the IDE window's General settings tab, next to editor font size,
 * from when the IDE was the only window and `aurora .` was the only command.
 * Neither is true now: the CLI's reason to exist is `aurora agent` and
 * `aurora mcp`, both of which run in the Agent Window, and this window is where
 * people configure the agent. A setting two windows away from the thing it
 * configures is a setting nobody finds.
 *
 * It sits under Preferences → General beside Startup for the same reason —
 * "which window opens when you launch Aurora" and "how you launch it at all"
 * are one question asked twice.
 */

import React, { useEffect, useState } from "react";

import {
  installAuroraCli,
  installAuroraContextMenu,
  isAuroraCliInstalled,
  isAuroraContextMenuInstalled,
  isTauri,
  uninstallAuroraCli,
  uninstallAuroraContextMenu,
} from "@/kernel/lib/ipc/tauri";
import { AgwButton, AgwPill, SettingsBlock, SettingsRow, SettingsSection } from "./primitives";

/** Where an integration is in its lifecycle. */
type Phase = "checking" | "idle" | "working";

/** The commands installing the CLI actually gives you, in the order they matter.
 *
 * Agent commands first. `aurora .` opens the editor and is the oldest thing
 * here, but it is no longer the reason anybody installs this — and a usage list
 * that leads with it teaches the wrong tool. */
const USAGE: { command: string; what: string }[] = [
  { command: "agw", what: "Open the Agent Window on this folder" },
  { command: 'aurora agent "fix the failing test"', what: "Send it a task and watch it run" },
  { command: "aurora --cli", what: "Browse models, conversations and tasks" },
  { command: "aurora mcp", what: "Serve Aurora to another agent" },
  { command: "aurora .", what: "Open the editor on this folder" },
];

export const SystemIntegrationSettings: React.FC = () => {
  const desktop = isTauri();
  const windows =
    desktop && typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");

  const [cliInstalled, setCliInstalled] = useState<boolean | null>(null);
  const [cliPhase, setCliPhase] = useState<Phase>(desktop ? "checking" : "idle");
  const [cliMessage, setCliMessage] = useState("");

  const [menuInstalled, setMenuInstalled] = useState<boolean | null>(null);
  const [menuPhase, setMenuPhase] = useState<Phase>(windows ? "checking" : "idle");
  const [menuMessage, setMenuMessage] = useState("");

  useEffect(() => {
    if (!desktop) return;
    let live = true;
    void isAuroraCliInstalled()
      .then((installed) => live && setCliInstalled(installed))
      .catch(() => live && setCliInstalled(null))
      .finally(() => live && setCliPhase("idle"));
    return () => {
      live = false;
    };
  }, [desktop]);

  useEffect(() => {
    if (!windows) return;
    let live = true;
    void isAuroraContextMenuInstalled()
      .then((installed) => live && setMenuInstalled(installed))
      .catch(() => live && setMenuInstalled(null))
      .finally(() => live && setMenuPhase("idle"));
    return () => {
      live = false;
    };
  }, [windows]);

  /** Run one install/uninstall, reporting whatever it says. */
  const run = async (
    action: () => Promise<string>,
    setPhase: (phase: Phase) => void,
    setMessage: (message: string) => void,
    setInstalled: (installed: boolean) => void,
    installed: boolean,
    fallback: string,
  ) => {
    setPhase("working");
    setMessage("");
    try {
      const said = await action();
      setInstalled(installed);
      setMessage(said || fallback);
    } catch (error) {
      // The real reason, not a generic failure. These fail for one of two
      // specific causes — no permission to write the registry, or a PATH that
      // could not be read — and both are things the user can act on.
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPhase("idle");
    }
  };

  if (!desktop) {
    return null;
  }

  return (
    <SettingsSection
      icon="terminal"
      title="Aurora outside its window"
      description="Reaching Aurora from a terminal, and from Explorer's right-click menu."
    >
      {/* `last` suppresses a row's bottom divider, so it has to name whatever
          is actually rendered last — which changes with the platform, whether
          the CLI is installed, and whether an action just reported something.
          Guessing leaves a rule under nothing. */}
      <SettingsRow
        alignTop
        last={!windows && !cliMessage && !cliInstalled}
        label="Command line"
        searchTerms="cli install path terminal aurora agw command shell mcp uninstall"
        hint="Puts aurora and agw on your PATH, so you can open this window, send it work, or serve it to another agent from any folder. Points at this build — reinstall after moving Aurora."
      >
        {cliPhase === "checking" ? (
          <AgwPill tone="neutral" dot={false}>
            Checking
          </AgwPill>
        ) : cliInstalled ? (
          <AgwButton
            variant="danger"
            onClick={() =>
              void run(
                uninstallAuroraCli,
                setCliPhase,
                setCliMessage,
                setCliInstalled,
                false,
                "Removed from PATH.",
              )
            }
            disabled={cliPhase === "working"}
          >
            {cliPhase === "working" ? "Removing" : "Remove"}
          </AgwButton>
        ) : (
          <AgwButton
            variant="primary"
            onClick={() =>
              void run(
                installAuroraCli,
                setCliPhase,
                setCliMessage,
                setCliInstalled,
                true,
                "Installed. Open a new terminal for it to appear.",
              )
            }
            disabled={cliPhase === "working"}
          >
            {cliPhase === "working" ? "Installing" : "Install"}
          </AgwButton>
        )}
      </SettingsRow>

      {cliMessage && (
        <SettingsBlock last={!windows && !cliInstalled}>
          <p className="agw-set-connect-note">{cliMessage}</p>
        </SettingsBlock>
      )}

      {cliInstalled && (
        <SettingsBlock
          last={!windows}
          searchTerms="aurora agent agw cli mcp usage commands examples"
        >
          <div className="agw-set-usage">
            {USAGE.map((row) => (
              <div className="agw-set-usage-row" key={row.command}>
                <code className="agw-set-usage-cmd">{row.command}</code>
                <span className="agw-set-usage-what">{row.what}</span>
              </div>
            ))}
          </div>
        </SettingsBlock>
      )}

      {windows && (
        <SettingsRow
          alignTop
          last={!menuMessage}
          label="Explorer right-click menu"
          searchTerms="context menu explorer right click open with aurora shell registry folder"
          hint="Adds “Open with Aurora” when you right-click a folder, or the empty space inside one."
        >
          {menuPhase === "checking" ? (
            <AgwPill tone="neutral" dot={false}>
              Checking
            </AgwPill>
          ) : menuInstalled ? (
            <AgwButton
              variant="danger"
              onClick={() =>
                void run(
                  uninstallAuroraContextMenu,
                  setMenuPhase,
                  setMenuMessage,
                  setMenuInstalled,
                  false,
                  "Removed from the right-click menu.",
                )
              }
              disabled={menuPhase === "working"}
            >
              {menuPhase === "working" ? "Removing" : "Remove"}
            </AgwButton>
          ) : (
            <AgwButton
              variant="primary"
              onClick={() =>
                void run(
                  installAuroraContextMenu,
                  setMenuPhase,
                  setMenuMessage,
                  setMenuInstalled,
                  true,
                  "Added to the right-click menu.",
                )
              }
              disabled={menuPhase === "working"}
            >
              {menuPhase === "working" ? "Adding" : "Add"}
            </AgwButton>
          )}
        </SettingsRow>
      )}

      {menuMessage && (
        <SettingsBlock last>
          <p className="agw-set-connect-note">{menuMessage}</p>
        </SettingsBlock>
      )}
    </SettingsSection>
  );
};
