/**
 * Agent Window — Settings · MCP Servers (view).
 *
 * agw-native. Reads/writes the SAME shared `useMcpStore` (the Rust MCP manager
 * is a single backend shared across windows, so servers managed here are the
 * IDE's servers — one source of truth).
 *
 * Layout: a stacked list of self-contained **server cards** (deliberately NOT
 * the Providers master–detail split). Each card carries its own status, controls
 * and an inline expand for connection details / edit. Adding a server drops an
 * expanded "draft" card at the top (form or raw-JSON import).
 *
 * Palette: intentionally restrained — status reads as green / amber / red, and
 * the only accent is the themeable enable switch. No primary-accent buttons, no
 * info-blue pills (the Appearance page will own accent theming next).
 */

import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import {
  resolveServerUrl,
  resolveTransport,
  useMcpStore,
  type McpServerConfig,
  type McpServerState,
  type McpServerStatus,
  type McpTransportType,
} from "@/apps/agent/store/tools/useMcpStore";
import { writeClipboardText } from "@/kernel/lib/clipboard";
import { AgentIcon, type AgentIconName } from "../shared/AgentIcon";
import { AgwButton, AgwPill, AgwSegmented, AgwSwitch, AgwTextInput } from "./primitives";

// Three transports fit the pill only with short labels, so the segmented
// control carries the name each server's own docs use and the field below
// carries the explanation.
const TRANSPORT_OPTIONS = [
  { value: "stdio" as const, label: "Stdio" },
  { value: "http" as const, label: "HTTP" },
  { value: "sse" as const, label: "SSE" },
];

/** A local process; everything else talks to a server over HTTP. */
const isRemote = (transport: McpTransportType): boolean => transport !== "stdio";

const URL_PLACEHOLDER: Record<string, string> = {
  http: "https://example.com/api/mcp",
  sse: "http://localhost:3000/sse",
};

// Picking the wrong one of these two fails with a bare HTTP status, so the
// difference has to be readable at the moment of choosing rather than
// discoverable afterwards.
// Shown on the collapsed card. The two HTTP transports are named apart so a
// server's transport is legible without opening the editor.
const TRANSPORT_SUMMARY: Record<McpTransportType, string> = {
  stdio: "Local process",
  http: "Streamable HTTP",
  sse: "HTTP+SSE",
};

const TRANSPORT_HINT: Record<string, string> = {
  http: "Streamable HTTP. Most hosted servers use this — their setup snippets call it httpUrl.",
  sse: "Legacy HTTP+SSE. Only for older servers that publish a separate event stream.",
};

const EXAMPLE_JSON = `{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-git"],
      "env": {}
    },
    "hosted-server": {
      "httpUrl": "https://example.com/api/mcp"
    }
  }
}`;

// ── status → presentation (no accent/blue — green / amber / red / grey) ───────

function statusDotTone(status: McpServerStatus): string {
  switch (status) {
    case "connected":
      return "ready";
    case "connecting":
      return "busy";
    case "error":
      return "error";
    case "disconnected":
      return "off";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function statusLabel(status: McpServerStatus): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "error":
      return "Error";
    case "disconnected":
      return "Disconnected";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

// ── KEY=VALUE (one per line) ⇄ Record<string,string> ─────────────────────────

function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text.trim()) return out;
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function stringifyKv(record: Record<string, string>): string {
  return Object.entries(record)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function parseArgs(text: string): string[] {
  return text.trim() ? text.trim().split(/\s+/) : [];
}

// ── Shared form fields (used by both add + edit) ─────────────────────────────

interface ServerForm {
  name: string;
  transport: McpTransportType;
  command: string;
  args: string;
  url: string;
  env: string;
  headers: string;
}

const ConnectionFields: React.FC<{
  form: ServerForm;
  patch: (p: Partial<ServerForm>) => void;
  withName?: boolean;
}> = ({ form, patch, withName = true }) => (
  <>
    <div className="agw-mcp-grid2">
      {withName && (
        <label className="agw-prov-edit-field">
          <span>Name</span>
          <AgwTextInput
            value={form.name}
            placeholder="My MCP server"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </label>
      )}
      <label className="agw-prov-edit-field">
        <span>Transport</span>
        <AgwSegmented
          ariaLabel="Transport"
          value={form.transport}
          options={TRANSPORT_OPTIONS}
          onChange={(transport) => patch({ transport })}
        />
      </label>
    </div>

    {form.transport === "stdio" ? (
      <>
        <label className="agw-prov-edit-field">
          <span>Command</span>
          <AgwTextInput
            value={form.command}
            placeholder="npx, uvx, node, python…"
            onChange={(e) => patch({ command: e.target.value })}
          />
        </label>
        <label className="agw-prov-edit-field">
          <span>Arguments (space-separated)</span>
          <AgwTextInput
            value={form.args}
            placeholder="-y @modelcontextprotocol/server-git"
            onChange={(e) => patch({ args: e.target.value })}
          />
        </label>
      </>
    ) : (
      <label className="agw-prov-edit-field">
        <span>URL</span>
        <AgwTextInput
          value={form.url}
          placeholder={URL_PLACEHOLDER[form.transport]}
          onChange={(e) => patch({ url: e.target.value })}
        />
        <span className="agw-set-row-hint">{TRANSPORT_HINT[form.transport]}</span>
      </label>
    )}

    <label className="agw-prov-edit-field">
      <span>Environment variables (KEY=VALUE, one per line)</span>
      <textarea
        className="agw-mcp-textarea"
        value={form.env}
        rows={2}
        spellCheck={false}
        placeholder={"API_KEY=your-key\nDEBUG=true"}
        onChange={(e) => patch({ env: e.target.value })}
      />
    </label>

    {isRemote(form.transport) && (
      <label className="agw-prov-edit-field">
        <span>Headers (KEY=VALUE, one per line)</span>
        <textarea
          className="agw-mcp-textarea"
          value={form.headers}
          rows={2}
          spellCheck={false}
          placeholder={"Authorization=Bearer token"}
          onChange={(e) => patch({ headers: e.target.value })}
        />
      </label>
    )}
  </>
);

// ── Add-server draft card (form + raw JSON) ──────────────────────────────────

const AddServerCard: React.FC<{
  onCancel: () => void;
  onAdded: (firstName: string) => void;
}> = ({ onCancel, onAdded }) => {
  const addServer = useMcpStore((s) => s.addServer);
  const [mode, setMode] = useState<"form" | "json">("form");
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState<ServerForm>({
    name: "",
    transport: "stdio",
    command: "",
    args: "",
    url: "",
    env: "",
    headers: "",
  });
  const patch = (p: Partial<ServerForm>) => setForm((f) => ({ ...f, ...p }));
  const [autoStart, setAutoStart] = useState(false);
  const [autoApprove, setAutoApprove] = useState(true);

  const [json, setJson] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);

  const formValid =
    form.name.trim().length > 0 &&
    (form.transport === "stdio" ? form.command.trim().length > 0 : form.url.trim().length > 0);

  const submitForm = async () => {
    if (!formValid || busy) return;
    setBusy(true);
    try {
      await addServer({
        name: form.name.trim(),
        transport: form.transport,
        command: form.transport === "stdio" ? form.command.trim() : undefined,
        args: parseArgs(form.args),
        url: isRemote(form.transport) ? form.url.trim() : undefined,
        env: parseKv(form.env),
        headers: isRemote(form.transport) ? parseKv(form.headers) : {},
        enabled: true,
        autoStart,
        autoApprove,
      });
      onAdded(form.name.trim());
    } finally {
      setBusy(false);
    }
  };

  const submitJson = async () => {
    if (busy) return;
    setJsonError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      setJsonError(`Invalid JSON: ${e instanceof Error ? e.message : "parse error"}`);
      return;
    }

    const toConfig = (
      serverName: string,
      raw: Record<string, unknown>,
    ): Omit<McpServerConfig, "id"> => {
      const t = resolveTransport(raw);
      return {
        name: serverName,
        transport: t,
        command: typeof raw.command === "string" ? raw.command : undefined,
        args: Array.isArray(raw.args) ? (raw.args as string[]) : [],
        env:
          typeof raw.env === "object" && raw.env !== null
            ? (raw.env as Record<string, string>)
            : {},
        url: resolveServerUrl(raw),
        headers:
          typeof raw.headers === "object" && raw.headers !== null
            ? (raw.headers as Record<string, string>)
            : {},
        enabled: raw.enabled !== false,
        autoStart: raw.autoStart === true,
        autoApprove: raw.autoApprove !== false,
      };
    };

    const root = parsed as Record<string, unknown>;
    const configs: Omit<McpServerConfig, "id">[] = [];

    if (root.mcpServers && typeof root.mcpServers === "object") {
      const entries = Object.entries(root.mcpServers as Record<string, unknown>);
      if (entries.length === 0) {
        setJsonError("No servers found in the mcpServers object.");
        return;
      }
      for (const [serverName, cfg] of entries) {
        configs.push(toConfig(serverName, cfg as Record<string, unknown>));
      }
    } else if (root.name || root.command || root.url || root.httpUrl) {
      configs.push(toConfig((root.name as string) || "Unnamed server", root));
    } else {
      setJsonError(
        'JSON needs an "mcpServers" object, or at least "name" plus "command", "url", or "httpUrl".',
      );
      return;
    }

    setBusy(true);
    try {
      for (const cfg of configs) await addServer(cfg);
      onAdded(configs[0].name);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agw-mcp-card" data-open data-draft>
      <div className="agw-mcp-card-head agw-mcp-card-head-static">
        <span className="agw-mcp-card-ico" data-draft>
          <AgentIcon name="plus" size={16} />
        </span>
        <div className="agw-mcp-card-titles">
          <div className="agw-mcp-card-name">Add MCP server</div>
          <div className="agw-mcp-card-sub">Fill the form, or paste a JSON config to import.</div>
        </div>
        <div className="agw-mcp-modeseg">
          <AgwSegmented
            ariaLabel="Add mode"
            value={mode}
            options={[
              { value: "form", label: "Form" },
              { value: "json", label: "Raw JSON" },
            ]}
            onChange={setMode}
          />
        </div>
      </div>

      <div className="agw-mcp-card-body">
        {mode === "form" ? (
          <div className="agw-mcp-form">
            <ConnectionFields form={form} patch={patch} />
            <div className="agw-mcp-flags">
              <label className="agw-mcp-flag">
                <AgwSwitch checked={autoStart} onChange={setAutoStart} ariaLabel="Auto-start" />
                <span>Auto-start on launch</span>
              </label>
              <label className="agw-mcp-flag">
                <AgwSwitch
                  checked={autoApprove}
                  onChange={setAutoApprove}
                  ariaLabel="Auto-approve tools"
                />
                <span>Auto-approve this server's tools</span>
              </label>
            </div>
            <div className="agw-mcp-actions">
              <AgwButton onClick={onCancel}>Cancel</AgwButton>
              <AgwButton variant="success" icon="plus" disabled={!formValid || busy} onClick={() => void submitForm()}>
                {busy ? "Adding…" : "Add server"}
              </AgwButton>
            </div>
          </div>
        ) : (
          <div className="agw-mcp-form">
            <label className="agw-prov-edit-field">
              <span>Paste MCP server JSON</span>
              <textarea
                className="agw-mcp-textarea agw-mcp-textarea-tall"
                value={json}
                rows={9}
                spellCheck={false}
                placeholder={EXAMPLE_JSON}
                onChange={(e) => {
                  setJson(e.target.value);
                  setJsonError(null);
                }}
              />
            </label>
            {jsonError && (
              <div className="agw-set-notice" data-tone="warning">
                <span>{jsonError}</span>
              </div>
            )}
            <div className="agw-mcp-actions">
              <AgwButton onClick={onCancel}>Cancel</AgwButton>
              <AgwButton variant="success" icon="plus" disabled={!json.trim() || busy} onClick={() => void submitJson()}>
                {busy ? "Importing…" : "Import"}
              </AgwButton>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ── Server card (collapsed row + expandable body with read / edit) ───────────

const ServerCard: React.FC<{
  server: McpServerState;
  open: boolean;
  onToggle: () => void;
}> = ({ server, open, onToggle }) => {
  const { config, status } = server;
  const updateServer = useMcpStore((s) => s.updateServer);
  const removeServer = useMcpStore((s) => s.removeServer);
  const connectServer = useMcpStore((s) => s.connectServer);
  const disconnectServer = useMcpStore((s) => s.disconnectServer);
  const toggleServer = useMcpStore((s) => s.toggleServer);

  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showEnv, setShowEnv] = useState(false);
  const [form, setForm] = useState<ServerForm>(() => ({
    name: config.name,
    transport: config.transport,
    command: config.command ?? "",
    args: config.args.join(" "),
    url: config.url ?? "",
    env: stringifyKv(config.env),
    headers: stringifyKv(config.headers),
  }));
  const patch = (p: Partial<ServerForm>) => setForm((f) => ({ ...f, ...p }));
  const [autoStart, setAutoStart] = useState(config.autoStart);

  const seed = () => {
    setForm({
      name: config.name,
      transport: config.transport,
      command: config.command ?? "",
      args: config.args.join(" "),
      url: config.url ?? "",
      env: stringifyKv(config.env),
      headers: stringifyKv(config.headers),
    });
    setAutoStart(config.autoStart);
  };

  const beginEdit = () => {
    seed();
    setEditing(true);
    if (!open) onToggle();
  };

  const saveEdit = async () => {
    setBusy(true);
    try {
      await updateServer({
        ...config,
        name: form.name.trim() || config.name,
        transport: form.transport,
        command: form.transport === "stdio" ? form.command.trim() : undefined,
        args: parseArgs(form.args),
        url: isRemote(form.transport) ? form.url.trim() : undefined,
        env: parseKv(form.env),
        headers: isRemote(form.transport) ? parseKv(form.headers) : {},
        autoStart,
      });
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const transportIcon: AgentIconName = config.transport === "stdio" ? "terminal" : "browser";
  const connecting = status === "connecting";
  const connected = status === "connected";
  const sub = `${TRANSPORT_SUMMARY[config.transport]} · ${
    config.enabled ? statusLabel(status) : "Disabled"
  }${server.tools.length > 0 ? ` · ${server.tools.length} tools` : ""}`;

  return (
    <div className="agw-mcp-card" data-open={open || undefined} data-status={status}>
      {/* Head row */}
      <div className="agw-mcp-card-head">
        <button type="button" className="agw-mcp-card-main" onClick={onToggle} aria-expanded={open}>
          <span className="agw-mcp-card-ico">
            <AgentIcon name={transportIcon} size={16} />
            <span className="agw-mcp-card-dot" data-tone={statusDotTone(status)} />
          </span>
          <span className="agw-mcp-card-titles">
            <span className="agw-mcp-card-name">{config.name}</span>
            <span className="agw-mcp-card-sub">{sub}</span>
          </span>
        </button>

        <div className="agw-mcp-card-actions">
          {config.autoApprove && <AgwPill tone="neutral">Auto-approve</AgwPill>}
          {config.enabled &&
            (connected ? (
              <AgwButton icon="stop" disabled={busy} onClick={() => void disconnectServer(config.id)}>
                Disconnect
              </AgwButton>
            ) : (
              <AgwButton
                variant="success"
                disabled={busy || connecting}
                onClick={() => void connectServer(config.id)}
              >
                {connecting ? "Connecting…" : "Connect"}
              </AgwButton>
            ))}
          <AgwSwitch
            checked={config.enabled}
            onChange={(v) => void toggleServer(config.id, v)}
            ariaLabel={`Enable ${config.name}`}
          />
          <button
            type="button"
            className="agw-prov-icon-btn"
            title={editing ? "Stop editing" : "Edit server"}
            aria-pressed={editing}
            onClick={() => (editing ? setEditing(false) : beginEdit())}
            data-on={editing || undefined}
          >
            <AgentIcon name="inspect" size={14} />
          </button>
          <button
            type="button"
            className="agw-prov-icon-btn"
            title="Remove server"
            onClick={() => void removeServer(config.id)}
          >
            <AgentIcon name="close" size={15} />
          </button>
          <button
            type="button"
            className="agw-mcp-chev"
            data-open={open || undefined}
            onClick={onToggle}
            aria-label={open ? "Collapse" : "Expand"}
          >
            <AgentIcon name="chevron-down" size={16} />
          </button>
        </div>
      </div>

      {/* Body */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            style={{ overflow: "hidden" }}
          >
            <div className="agw-mcp-card-body">
              {server.error && (
                <div className="agw-set-notice" data-tone="warning">
                  <span>{server.error}</span>
                </div>
              )}

              {editing ? (
                <div className="agw-mcp-form">
                  <ConnectionFields form={form} patch={patch} />
                  <div className="agw-mcp-flags">
                    <label className="agw-mcp-flag">
                      <AgwSwitch checked={autoStart} onChange={setAutoStart} ariaLabel="Auto-start" />
                      <span>Auto-start on launch</span>
                    </label>
                  </div>
                  <div className="agw-mcp-actions">
                    <AgwButton
                      onClick={() => {
                        seed();
                        setEditing(false);
                      }}
                    >
                      Cancel
                    </AgwButton>
                    <AgwButton variant="success" icon="check" disabled={busy} onClick={() => void saveEdit()}>
                      {busy ? "Saving…" : "Save changes"}
                    </AgwButton>
                  </div>
                </div>
              ) : (
                <>
                  {/* Connection summary */}
                  <div className="agw-mcp-field">
                    <span className="agw-mcp-field-label">
                      {config.transport === "stdio" ? "Command" : "URL"}
                    </span>
                    <div className="agw-mcp-code">
                      {config.transport === "stdio"
                        ? `${config.command ?? ""} ${config.args.join(" ")}`.trim() || "—"
                        : config.url || "—"}
                    </div>
                  </div>

                  {Object.keys(config.env).length > 0 && (
                    <div className="agw-mcp-field">
                      <span className="agw-mcp-field-label">
                        Environment variables
                        <button
                          type="button"
                          className="agw-prov-icon-btn agw-mcp-eye"
                          aria-label={
                            showEnv
                              ? "Hide environment variable values"
                              : "Show environment variable values"
                          }
                          aria-pressed={showEnv}
                          title={showEnv ? "Hide values" : "Show values"}
                          onClick={() => setShowEnv((v) => !v)}
                        >
                          <AgentIcon name={showEnv ? "eye-off" : "eye"} size={13} />
                        </button>
                      </span>
                      <div className="agw-mcp-code">
                        {Object.entries(config.env).map(([k, v]) => (
                          <div key={k}>
                            {k}={showEnv ? v : "••••••"}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Auto-approve control */}
                  <div className="agw-mcp-field">
                    <label className="agw-mcp-flag agw-mcp-flag-row">
                      <AgwSwitch
                        checked={config.autoApprove}
                        onChange={(v) => void updateServer({ ...config, autoApprove: v })}
                        ariaLabel="Auto-approve all tools"
                      />
                      <span>Auto-approve all tools from this server</span>
                    </label>
                  </div>

                  {/* Tools */}
                  <div className="agw-mcp-field">
                    <span className="agw-mcp-field-label">
                      Tools <span className="agw-mcp-count">{server.tools.length}</span>
                    </span>
                    {server.tools.length === 0 ? (
                      <div className="agw-mcp-muted">
                        {connected
                          ? "This server exposes no tools."
                          : "Connect to discover this server's tools."}
                      </div>
                    ) : (
                      <div className="agw-mcp-tools">
                        {server.tools.map((tool) => (
                          <span key={tool.name} className="agw-mcp-tool" title={tool.description || tool.name}>
                            {tool.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {server.resources.length > 0 && (
                    <div className="agw-mcp-field">
                      <span className="agw-mcp-field-label">Resources</span>
                      <div className="agw-mcp-tools">
                        {server.resources.map((r) => (
                          <span key={r.uri} className="agw-mcp-tool" title={r.description || r.uri}>
                            {r.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// ── Page ─────────────────────────────────────────────────────────────────────

export const McpSettings: React.FC = () => {
  const servers = useMcpStore((s) => s.servers);
  const isLoading = useMcpStore((s) => s.isLoading);
  const configPath = useMcpStore((s) => s.configPath);
  const loadServers = useMcpStore((s) => s.loadServers);
  const refreshServers = useMcpStore((s) => s.refreshServers);
  const getConfigPath = useMcpStore((s) => s.getConfigPath);

  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState(false);
  const didLoad = useRef(false);

  useEffect(() => {
    if (didLoad.current) return;
    didLoad.current = true;
    void loadServers();
    void getConfigPath();
  }, [loadServers, getConfigPath]);

  const connectedCount = servers.filter((s) => s.status === "connected").length;
  const enabledCount = servers.filter((s) => s.config.enabled).length;

  const copyPath = async () => {
    if (!configPath) return;
    await writeClipboardText(configPath);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="agw-set-wide">
      <header className="agw-set-section-head" style={{ marginBottom: 2 }}>
        <div className="agw-set-section-title-wrap">
          <span className="agw-set-section-ico">
            <AgentIcon name="plug" size={15} />
          </span>
          <div style={{ minWidth: 0 }}>
            <h3 className="agw-set-section-title">MCP Servers</h3>
            <p className="agw-set-section-desc">
              Connect Model Context Protocol servers to extend the agent with external tools and
              resources. Shared with the IDE — one backend, one source of truth.
            </p>
          </div>
        </div>
        <div className="agw-mcp-headtools">
          <AgwButton icon="retry" onClick={() => void refreshServers()} disabled={isLoading}>
            Refresh
          </AgwButton>
          <AgwButton icon="plus" onClick={() => setAdding(true)} disabled={adding}>
            Add server
          </AgwButton>
        </div>
      </header>

      {/* Stat strip */}
      {servers.length > 0 && (
        <div className="agw-mcp-stats">
          <span className="agw-mcp-stat">
            <span className="agw-mcp-card-dot" data-tone="ready" />
            {connectedCount} connected
          </span>
          <span className="agw-mcp-stat-sep" />
          <span className="agw-mcp-stat">
            {enabledCount} of {servers.length} enabled
          </span>
        </div>
      )}

      <div className="agw-mcp-list">
        {adding && (
          <AddServerCard
            onCancel={() => setAdding(false)}
            onAdded={(firstName) => {
              setAdding(false);
              const match = useMcpStore.getState().servers.find((s) => s.config.name === firstName);
              if (match) setOpenId(match.config.id);
            }}
          />
        )}

        {servers.length === 0 && !isLoading && !adding ? (
          <div className="agw-mcp-empty">
            <AgentIcon name="plug" size={26} style={{ color: "var(--agw-text-subtle)" }} />
            <div className="agw-mcp-empty-title">No MCP servers yet</div>
            <div className="agw-mcp-empty-sub">
              Add a server to give the agent extra tools and resources.
            </div>
            <AgwButton variant="success" icon="plus" onClick={() => setAdding(true)}>
              Add server
            </AgwButton>
          </div>
        ) : (
          servers.map((s) => (
            <ServerCard
              key={s.config.id}
              server={s}
              open={openId === s.config.id}
              onToggle={() => setOpenId((cur) => (cur === s.config.id ? null : s.config.id))}
            />
          ))
        )}
      </div>

      {configPath && (
        <button type="button" className="agw-mcp-path" onClick={() => void copyPath()} title="Copy config path">
          <AgentIcon name={copied ? "check" : "copy"} size={13} />
          <span className="agw-mcp-path-text">{configPath}</span>
          {copied && <span className="agw-mcp-path-copied">Copied</span>}
        </button>
      )}
    </div>
  );
};
