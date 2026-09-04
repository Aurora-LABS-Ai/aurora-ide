/**
 * Agent Window — Settings · Agent · the connection block for outside agents.
 *
 * Shown once the switch is on, because that is the moment the answer to "and
 * now what?" is needed. Before it, this is a block of JSON explaining a thing
 * the reader has not agreed to yet.
 *
 * The command is Aurora's own executable path, read from Rust rather than
 * assembled here. The short name `aurora` only works after the CLI has been put
 * on PATH, and an agent launched from a desktop shortcut does not necessarily
 * inherit the user's PATH at all — so the copyable form is the one that works
 * everywhere.
 */

import React, { useEffect, useRef, useState } from "react";

import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import { writeClipboardText } from "@/kernel/lib/clipboard";
import { AgwButton } from "./primitives";

/** Mirrors Rust's `McpClientConfig`. */
interface ClientConfig {
  command: string;
  args: string[];
  snippet: string;
}

/** How long the copy button stays confirmed. */
const COPIED_MS = 1600;

export const AgentBridgeCard: React.FC = () => {
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    void auroraInvoke<ClientConfig>("aurora_mcp_client_config")
      .then((next) => live && setConfig(next))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const copy = async () => {
    if (!config) return;
    const ok = await writeClipboardText(config.snippet);
    if (!ok) return;
    setCopied(true);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
  };

  if (failed) {
    return (
      <p className="agw-set-connect-note">
        Aurora could not work out its own location, so there is no configuration to
        show. Anything that can run <code className="agw-code">aurora mcp</code> will
        still connect.
      </p>
    );
  }

  return (
    <div className="agw-set-connect">
      <div className="agw-set-connect-head">
        <div className="agw-set-connect-title">Add this to the other agent</div>
        <AgwButton
          variant={copied ? "success" : "secondary"}
          icon={copied ? "check" : "copy"}
          onClick={() => void copy()}
          disabled={!config}
        >
          {copied ? "Copied" : "Copy"}
        </AgwButton>
      </div>

      <pre className="agw-set-connect-code">
        {config ? config.snippet : "Reading Aurora's location…"}
      </pre>

      <p className="agw-set-connect-note">
        It connects to <em>this</em> Aurora, and only while this window is open. The
        tools stay listed either way, so an agent that finds the window closed can
        tell you to open it rather than reporting that Aurora is broken.
      </p>
    </div>
  );
};
