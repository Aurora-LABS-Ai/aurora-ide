//! Starting the engine: one function the desktop app and a host with no
//! window both call.
//!
//! Everything here is the engine's own: the usage ledger, the shell registry,
//! the MCP servers, the [`AgentRegistry`] with its session store, the native
//! tools and the permission gate. The host brings three things only it has:
//! the database (the desktop shares its managed connection, a server opens
//! its own), where named events go (the windows, or the server's clients),
//! and the browser manager when there is a browser.

use std::sync::Arc;

use super::{AgentRegistry, ApiFactory, DatabaseProviderLookup, HostIdeEventSink};
use crate::agent_runtime::api_client::StreamingApiClient;
use crate::agent_runtime::error::RuntimeError;
use crate::agent_runtime::tool_executor::Permitter;
use crate::db::DatabaseAccess;
use crate::host_events::{EventSink, Events};
use crate::tools::permissions::{
    DatabaseSettingsResolver, EventPermissionEmitter, PermissionEmitter, PermissionRouter,
    SettingsAwarePermitter, SettingsResolver, TauriPermitter,
};
use crate::tools::BrowserSupport;
use crate::usage_ledger::UsageLedger;
use crate::{logging, mcp, paths, shell, tools};

/// The production [`ApiFactory`]: the provider adapters in [`crate::api`].
///
/// The factory takes the `ProviderConfigSnapshot` carried by the turn and
/// forwards it verbatim to `crate::api::build_api_client`. The adapter layer
/// is the only place that interprets `api_key`, `base_url`, `custom_headers`
/// and `custom_params`; this must NOT add provider routing of its own.
pub struct ApiAdapters;

impl ApiFactory for ApiAdapters {
    fn build(
        &self,
        config: &crate::api::ProviderConfigSnapshot,
    ) -> Result<Arc<dyn StreamingApiClient>, RuntimeError> {
        Ok(crate::api::build_api_client(config))
    }
}

/// What the host gives the engine.
pub struct EngineHost {
    /// The settings database, read per call.
    pub db: Arc<dyn DatabaseAccess>,
    /// Where named events go.
    pub events: Events,
    /// The browser manager for the browser tools; `None` registers none.
    pub browser: Option<BrowserSupport>,
}

/// A started engine. The host keeps these alive for as long as it runs.
pub struct Engine {
    pub registry: Arc<AgentRegistry>,
    /// Resolves the approval prompts the permission gate raises
    /// (`agent_grant_permission`).
    pub permission_router: Arc<PermissionRouter>,
    pub usage_ledger: Arc<UsageLedger>,
}

/// Start the engine. Slow work (the usage import, a first-run shell scan, MCP
/// servers) goes to the background; this returns as soon as a turn can run.
pub fn start_engine(host: EngineHost) -> anyhow::Result<Engine> {
    let EngineHost {
        db,
        events,
        browser,
    } = host;

    let usage_events = events.clone();
    let usage_ledger = Arc::new(
        UsageLedger::open(&paths::db_file(), paths::root())?.with_notifier(Arc::new(move || {
            usage_events.emit_value("usage-updated", serde_json::Value::Null);
        })),
    );
    // Import retained history off the startup thread. Profile also
    // reconciles changed sources before reading, so interrupted imports retry.
    let usage_import = usage_ledger.clone();
    std::thread::Builder::new()
        .name("usage-import".into())
        .spawn(move || {
            if let Err(error) = usage_import.reconcile() {
                logging::log_error(
                    "usage_ledger",
                    &format!("historical import failed: {error:#}"),
                );
            }
        })?;

    // Populate the shell registry. On a first run this scans the machine so
    // the agent has a verified, correctly configured shell before the user
    // ever opens settings.
    shell::stored::bootstrap(db.clone());

    // Terminal sessions announce agent-opened tabs and their endings to every
    // front end (`terminal-opened`, `terminal-exited`).
    let pty_events = events.clone();
    crate::pty_sessions::install(Arc::new(move |notice| {
        pty_events.emit_value(notice.event_name(), notice.payload());
    }));

    // MCP servers start here, once per process. Global config only; a client
    // adds its project's `.mcp.json` through `mcp_set_workspace`.
    let mcp_events = events.clone();
    std::thread::Builder::new()
        .name("mcp-start".into())
        .spawn(move || {
            mcp::manager::MCP_MANAGER.init(Arc::new(move |servers| {
                if let Err(e) =
                    <dyn EventSink>::emit(mcp_events.as_ref(), mcp::manager::SERVERS_CHANGED_EVENT, servers)
                {
                    logging::log_warn("mcp", &format!("could not send server list: {e}"));
                }
            }));
        })?;

    // The single owner of all chat-history persistence: project chats under
    // `projects/`, Aurora Chat under `chats/`. A sibling of `projects/`, never
    // inside it — the two products' histories are separate stores and
    // deleting one must not reach the other.
    let registry = Arc::new(
        AgentRegistry::new(Arc::new(ApiAdapters), paths::projects_dir())
            .with_chat_dir(paths::chats_dir())
            .with_usage_ledger(usage_ledger.clone())
            // Sub-agents may run on any configured model; the pin is resolved
            // against the same provider rows the Providers page edits.
            .with_provider_lookup(Arc::new(DatabaseProviderLookup::new(db.clone())))
            // A turn whose prompt the engine composes reads Settings here.
            .with_settings_source(db.clone()),
    );

    tools::register_builtin_tools(
        &registry.tools(),
        Arc::new(HostIdeEventSink::new(events.clone(), &registry)),
        browser,
    );

    // The permission gate, outer → inner:
    //   SettingsAwarePermitter → TauriPermitter → the client's prompt
    //
    // 1. `SettingsAwarePermitter` consults the `tool_settings` table on every
    //    call: `auto` approves and `deny` denies without asking; `always_ask`
    //    (or unset) falls through.
    // 2. `TauriPermitter` registers a oneshot in the router, sends
    //    `agent_permission_request`, and parks until a client posts a verdict
    //    through `agent_grant_permission`.
    // 3. `PermissionGuardedExecutor` wraps every native tool whose
    //    `requires_permission()` is true, so the runtime's gate-free
    //    `tool.execute(...)` path consults the chain.
    //
    // The resolver re-reads on every call, so a toggled setting applies to
    // the next tool dispatch.
    let permission_router = Arc::new(PermissionRouter::new());
    let permission_emitter: Arc<dyn PermissionEmitter> =
        Arc::new(EventPermissionEmitter::new(events));
    let prompt_permitter: Arc<dyn Permitter> = Arc::new(TauriPermitter::new(
        permission_router.clone(),
        permission_emitter,
    ));
    let resolver: Arc<dyn SettingsResolver> = Arc::new(DatabaseSettingsResolver::new(db));
    let settings_aware: Arc<dyn Permitter> =
        Arc::new(SettingsAwarePermitter::new(resolver, prompt_permitter));
    // Order is load-bearing: the timeout guard goes on FIRST so the
    // permission gate ends up outside it. Reversed, the clock would start
    // ticking while the approval prompt is still on screen and a command
    // approved after a minute's thought would be killed for taking a minute.
    tools::install_timeout_guards(&registry.tools());
    tools::install_permission_gate(&registry.tools(), settings_aware);

    Ok(Engine {
        registry,
        permission_router,
        usage_ledger,
    })
}
