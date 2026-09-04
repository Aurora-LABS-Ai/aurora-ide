//! Command Code (subscription gateway) provider.
//!
//! Lets Aurora drive the ~70 models Command Code resells on one plan
//! (`deepseek/deepseek-v4-pro`, `zai-org/GLM-5.3`, `moonshotai/Kimi-K3`,
//! `claude-sonnet-5`, `gpt-5.6-terra`, …), billed against the user's
//! Command Code subscription instead of a per-vendor API key.
//!
//! ## How it fits together
//!
//! - [`auth`] — credential lifecycle. `~/.commandcode/auth.json` (the
//!   Command Code CLI's own file) is the **single source of truth**, the
//!   same arrangement Aurora uses for Codex: an existing `cmd login` is
//!   picked up automatically, and Aurora's own browser sign-in writes that
//!   same file, which signs the CLI in too. There is no refresh token and
//!   no expiry: the key is long-lived, so there is nothing to rotate and
//!   nothing for the two clients to fight over.
//! - [`adapter`] — [`CommandCodeAdapter`], a [`StreamingApiClient`] that
//!   speaks the backend's own dialect. Nothing here could be delegated to
//!   the OpenAI or Anthropic builders, because the wire is neither.
//! - [`usage`] — the plan, the two rolling spend windows and the credit
//!   balance, for the settings card.
//!
//! ## Why this needs its own adapter
//!
//! Three things rule out reusing an existing one:
//!
//! 1. **The body is not a chat-completions body.** The model parameters
//!    are nested under `params`, and four sibling keys ride alongside
//!    them: `config` (working directory, date, git state), `memory`,
//!    `taste`, `skills`, `permissionMode`. `config` is not decorative.
//!    Omitting `isGitRepo`, `currentBranch`, `mainBranch` or `gitStatus`
//!    is a hard 400 that names each missing field.
//! 2. **The response is not SSE.** It is newline-delimited JSON: no
//!    `data:` prefix, no blank-line frame separator, no `[DONE]`. The
//!    shared [`crate::api::sse_shared::SseFrameBuffer`] splits on blank
//!    lines and would buffer the whole stream into one frame, so this
//!    module reads lines itself.
//! 3. **The event names are its own.** `text-delta`, `reasoning-delta`,
//!    `tool-input-start` / `-delta` / `-end`, `tool-call`, `finish-step`,
//!    `finish`. Tool arguments arrive already parsed on `tool-call`,
//!    so unlike every OpenAI-shaped adapter there is no partial-JSON
//!    assembly to get right.
//!
//! ## What the gateway hands back for free
//!
//! Every response carries `providerMetadata` and the upstream's own
//! response headers, which name who actually served the request:
//! `zai-org/GLM-5.2` came back `{"alibaba": {}}` with `x-dashscope-*`
//! headers, `meituan/LongCat-2.0:free` came back `{"longcat": {}}`.
//! [`adapter`] surfaces that as the served-by route so a relabelled model
//! is visible rather than guessed at.
//!
//! ## Plan gating
//!
//! Model access is decided per plan (Go < GOAT < Pro < Max) and enforced
//! at request time, not at listing time: `/provider/v1/models` returns the
//! full catalog on every plan, and an out-of-plan model answers
//! `403 MODEL_NOT_IN_PLAN` naming the tier it needs. Aurora therefore
//! lists everything and lets the error explain itself, because a model
//! that silently vanishes from the picker reads as a bug.
//!
//! The `/alpha/generate` endpoint is not a documented public API. The
//! shape can change without notice, so everything provider-specific is
//! contained here.
//!
//! [`StreamingApiClient`]: crate::agent_runtime::api_client::StreamingApiClient
//! [`CommandCodeAdapter`]: adapter::CommandCodeAdapter

pub mod adapter;
pub mod auth;
pub mod usage;

/// API root the billing and account routes hang off.
pub const COMMANDCODE_API_ROOT: &str = "https://api.commandcode.ai";

/// Streaming chat endpoint. Fixed rather than taken from the provider
/// row's base URL, for the same reason Codex fixes its own: a stale
/// preset should not be able to misroute a subscription call.
pub const COMMANDCODE_GENERATE_URL: &str = "https://api.commandcode.ai/alpha/generate";

/// Model catalog. Answers `{id, name, context_length}` per model, and
/// returns the whole catalog regardless of the caller's plan.
pub const COMMANDCODE_MODELS_URL: &str = "https://api.commandcode.ai/provider/v1/models";

/// Studio sign-in page. Takes `callback` and `state` query parameters and
/// POSTs the issued key back to the callback.
pub const COMMANDCODE_STUDIO_AUTH_URL: &str = "https://commandcode.ai/studio/auth/cli";

/// Where a user creates an API key by hand. Linked from the provider card
/// so the paste path never requires the CLI or the browser sign-in.
pub const COMMANDCODE_STUDIO_KEYS_URL: &str = "https://commandcode.ai/studio";

/// Origin the Studio sign-in page calls the loopback callback from. Sent
/// back as `Access-Control-Allow-Origin`; the browser drops the response
/// without it.
pub const COMMANDCODE_STUDIO_ORIGIN: &str = "https://commandcode.ai";

/// First loopback port tried for the sign-in callback, matching the one
/// the Command Code CLI itself uses.
pub const COMMANDCODE_CALLBACK_PORT: u16 = 5959;

/// How many consecutive ports to try before giving up.
pub const COMMANDCODE_CALLBACK_PORT_RANGE: u16 = 10;

/// `x-command-code-version` floor used when the installed CLI cannot be
/// found on disk.
///
/// The header is **required**: without it the backend answers
/// `403 upgrade_required`. The value is only floor-checked, so this needs
/// to be at or above whatever minimum the backend currently enforces
/// rather than exactly right. [`auth::cli_version`] prefers the version of
/// the CLI actually installed on this machine so the floor tracks itself,
/// and falls back to this.
pub const COMMANDCODE_FALLBACK_VERSION: &str = "1.44.0";

/// `x-cli-environment`. Optional (requests succeed without it), sent
/// because the backend's own client sends it.
pub const COMMANDCODE_ENVIRONMENT: &str = "production";

/// Provider type string that routes a row to this adapter.
pub const COMMANDCODE_PROVIDER_TYPE: &str = "commandcode";
