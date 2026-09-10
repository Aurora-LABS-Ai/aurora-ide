//! Claude (Pro/Max subscription) provider — "Claude Code" sign-in.
//!
//! Lets Aurora drive Claude models through the same OAuth grant Claude Code
//! uses, metered against the user's claude.ai subscription instead of a
//! platform API key.
//!
//! ## How it fits together
//!
//! - [`auth`] — token lifecycle. Aurora keeps its OWN credential file at
//!   `<root>/auth/claude-code-auth.json`. It never reads or writes the
//!   user's `~/.claude` directory: a sign-in in Aurora is Aurora's, and a
//!   sign-out in Aurora leaves Claude Code's own session untouched. The
//!   sign-in is the manual PKCE flow — Aurora shows the authorize URL, the
//!   user finishes in their browser, and pastes the code (or the whole
//!   callback URL) back into the card. No loopback listener, no port.
//! - [`adapter`] — [`ClaudeCodeAdapter`], a thin [`StreamingApiClient`]
//!   that resolves a fresh access token per turn, sends it as
//!   `Authorization: Bearer`, adds the OAuth beta header, keeps the
//!   Claude Code identity at the head of the system prompt, and delegates
//!   the wire work to the existing Anthropic Messages builders.
//! - [`usage`] — the plan's rolling windows for the settings card, from the
//!   endpoint Claude Code's `/usage` reads.
//!
//! [`StreamingApiClient`]: crate::agent_runtime::api_client::StreamingApiClient
//! [`ClaudeCodeAdapter`]: adapter::ClaudeCodeAdapter

pub mod adapter;
pub mod auth;
pub mod usage;

/// The provider type the frontend stores on the row. Also the row id of the
/// shipped preset, so `ProviderKind::detect` and the model-prefix stripping
/// agree.
pub const CLAUDE_CODE_PROVIDER_TYPE: &str = "claude-code";

/// OAuth client id registered for Claude Code. Third-party Claude clients
/// authenticate with the same id — it is what makes the resulting tokens
/// subscription-entitled.
pub const CLAUDE_CODE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/// Where the browser sign-in starts.
pub const CLAUDE_AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";

/// Authorization-code and refresh-token exchange.
pub const CLAUDE_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";

/// The redirect Claude Code's own manual flow uses: the page shows the user
/// a code to copy instead of bouncing to a local port.
pub const CLAUDE_MANUAL_REDIRECT_URL: &str = "https://platform.claude.com/oauth/code/callback";

/// Anthropic API root the subscription token is valid against.
pub const CLAUDE_API_BASE: &str = "https://api.anthropic.com";

/// Account + organisation for the card (needs `user:profile`).
pub const CLAUDE_PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";

/// Rolling-window utilisation for the card (needs `user:profile`).
pub const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

/// Beta flag every request made with a subscription token must carry.
pub const OAUTH_BETA: &str = "oauth-2025-04-20";

/// The beta Claude Code sends alongside it on agentic requests.
pub const CLAUDE_CODE_BETA: &str = "claude-code-20250219";

/// The scope that makes a token usable for inference. Presence decides
/// "signed in as a subscriber", not which button the user pressed.
pub const INFERENCE_SCOPE: &str = "user:inference";

/// Scopes requested at sign-in — the union Claude Code itself requests, so
/// the consent screen the user sees is the one they already know.
pub const LOGIN_SCOPES: &[&str] = &[
    "org:create_api_key",
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
];

/// Scopes asked for on refresh. The refresh grant allows scope expansion, so
/// this is the full subscriber set rather than whatever was first granted.
pub const REFRESH_SCOPES: &[&str] = &[
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
];

/// The sentence Claude Code puts first in every system prompt. The
/// subscription endpoint expects it at the head of the request, so the
/// adapter keeps it there ahead of Aurora's own prompt.
pub const CLAUDE_CODE_IDENTITY: &str = "You are Claude Code, Anthropic's official CLI for Claude.";

/// What the requests call themselves. The endpoint is served to Claude Code
/// clients, and the CLI's own identifier is what it is used to seeing.
pub const CLAUDE_CODE_USER_AGENT: &str = "claude-cli/2.1.2 (external, cli)";
