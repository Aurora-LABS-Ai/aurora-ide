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

/** Mirrors Rust's `McpClientSession`. */
interface McpClientSession {
  sessionId: string;
  pid: number;
  /** What the agent called itself. `null` when it sent no `clientInfo`. */
  clientName: string | null;
  clientVersion: string | null;
  connectedAtMs: number;
  lastSeenMs: number;
}

/** How long the copy button stays confirmed. */
const COPIED_MS = 1600;

/**
 * How often the connected list is re-read.
 *
 * Faster than the 20-second heartbeat behind it, so a connection that arrives
 * mid-read shows up within one beat rather than two. Slower than a second,
 * because this is a settings page nobody is watching for latency — and each
 * poll walks a directory.
 */
const CLIENTS_POLL_MS = 5000;

/** "connected 4m ago", from the timestamp the session file carries. */
function connectedFor(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export const AgentBridgeCard: React.FC = () => {
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [clients, setClients] = useState<McpClientSession[]>([]);
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

  /**
   * Who is connected, polled while this page is open.
   *
   * Polled rather than pushed because there is nothing to push from: each
   * connection is a separate `aurora mcp` process that this one never talks
   * to, and it announces itself by writing a file. The interval is cleared on
   * unmount, so a settings page nobody is looking at costs nothing.
   *
   * A failed read leaves the previous list alone rather than emptying it. The
   * count is a display, and blinking to "none connected" because one poll
   * failed would report a disconnection that never happened.
   */
  useEffect(() => {
    let live = true;
    const read = () => {
      void auroraInvoke<McpClientSession[]>("aurora_mcp_clients")
        .then((next) => live && setClients(next))
        .catch(() => {
          /* keep whatever was last known good */
        });
    };
    read();
    const timer = window.setInterval(read, CLIENTS_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

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

      {/* Who is actually on the other end.
        *
        * The card explained how to connect an agent and could not say whether
        * one ever had — the wrong way round for a switch that lets another
        * program drive your editor. "None connected" is stated rather than
        * left as a gap: an empty space here reads as a feature that is not
        * working, which is the same shape as a feature nobody is using. */}
      <div className="agw-set-connect-live">
        <div className="agw-set-connect-live-head">
          <span
            className="agw-set-connect-dot"
            data-on={clients.length > 0 ? "" : undefined}
            aria-hidden="true"
          />
          <span>
            {clients.length === 0
              ? "Nothing connected"
              : `${clients.length} connected`}
          </span>
        </div>

        {clients.length === 0 ? (
          <p className="agw-set-connect-note">
            An agent shows up here within a few seconds of connecting, whether or
            not it has sent Aurora any work.
          </p>
        ) : (
          <ul className="agw-set-connect-list">
            {clients.map((client) => (
              <li key={client.sessionId} className="agw-set-connect-item">
                {/* An agent naming itself is optional in the protocol, so a
                  * nameless one is still counted and still listed — the pid
                  * is what is left to identify it by. */}
                <span className="agw-set-connect-name">
                  {client.clientName ?? "Unnamed agent"}
                  {client.clientVersion ? (
                    <span className="agw-set-connect-ver">{client.clientVersion}</span>
                  ) : null}
                </span>
                <span className="agw-set-connect-meta">
                  pid {client.pid} · connected {connectedFor(client.connectedAtMs)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
