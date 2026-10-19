//! Antigravity provider: Gemini, Claude and GPT-OSS models on a Google
//! account's Antigravity plan.
//!
//! Antigravity is Google's agent IDE. Its models are served by the Cloud Code
//! backend (`daily-cloudcode-pa.googleapis.com/v1internal`) to whoever holds
//! a Google OAuth token issued to the Antigravity client, metered against that
//! account's Antigravity quota. Aurora signs in with the same client.
//!
//! ## How it fits together
//!
//! - [`accounts`]: Aurora's own list of Google accounts at
//!   `<root>/auth/antigravity-accounts.json`. One of them (main) serves
//!   requests, the same model as the Claude Code and Codex lists.
//! - [`auth`]: token lifecycle. Sign-in is Google's browser flow with a
//!   loopback callback on a random local port. Import copies the refresh token
//!   Antigravity IDE keeps in its own state database; that database is only
//!   read. Google refresh tokens are reusable, so Aurora and the IDE refreshing
//!   the same sign-in never log each other out.
//! - [`wire`]: Aurora's conversation as a Cloud Code request envelope
//!   (`{project, model, request: {contents, tools, …}}`, Gemini's shape).
//! - [`stream`]: the SSE reply back into Aurora's events and blocks.
//! - [`adapter`]: [`adapter::AntigravityAdapter`], the
//!   [`StreamingApiClient`] that ties them together.
//!
//! Measured against the live backend on 2026-10-12 (free tier):
//! - Every reply event is `{response, traceId, metadata}`; `response` is a
//!   Gemini `GenerateContentResponse`.
//! - A tool call arrives whole in one part, never as argument deltas.
//! - A Gemini tool call carries a `thoughtSignature`. Replaying the call
//!   without it is answered `400 Function call is missing a thought_signature`;
//!   replaying it with Google's documented placeholder works. Claude models
//!   through Antigravity accept the call either way.
//! - Both model families end with `finishReason: STOP`, even after a tool call.
//! - None of 9router's disguises (decoy tools, `_ide` suffixes, prompt
//!   rewrites) were needed, so none are used.
//!
//! [`StreamingApiClient`]: crate::agent_runtime::api_client::StreamingApiClient

pub mod accounts;
pub mod adapter;
pub mod auth;
pub mod models;
pub mod quota;
pub mod schema;
pub mod stream;
pub mod wire;

#[cfg(test)]
mod live_tests;

/// The provider type the frontend stores on the row, and the row id of the
/// built-in preset.
pub const ANTIGRAVITY_PROVIDER_TYPE: &str = "antigravity";

/// Antigravity's OAuth client. A desktop ("installed app") client, so its
/// secret is not a secret: it ships inside every Antigravity install, and
/// Google's token endpoint still requires it.
pub const ANTIGRAVITY_CLIENT_ID: &str =
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
pub const ANTIGRAVITY_CLIENT_SECRET: &str = "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";

pub const GOOGLE_AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const GOOGLE_USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";

/// The scopes Antigravity itself asks for. `cloud-platform` is the one the
/// model endpoints check; the rest match the consent screen the user knows.
pub const LOGIN_SCOPES: &[&str] = &[
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
];

/// Account setup lives on the production host; generation on `daily-`.
pub const LOAD_CODE_ASSIST_URL: &str =
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
pub const ONBOARD_USER_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal:onboardUser";
pub const API_BASE: &str = "https://daily-cloudcode-pa.googleapis.com/v1internal";

/// The client version requests carry: the Antigravity desktop app's current
/// release (2.23.1 on 2026-10-16).
pub const ANTIGRAVITY_CLIENT_VERSION: &str = "2.23.1";

/// `antigravity/hub/<version> <os>/<arch>`, the Antigravity desktop app's
/// format.
///
/// The backend picks the model list and the quota groups from this header,
/// not from the account. Probed 2026-10-16 on one Google AI Pro account:
/// `antigravity/ide/<any version>` gets 26 models and two quota groups;
/// `antigravity/hub/2.15.1` and later also gets Gemini 4 Argon
/// (`gemini-4-argon-low/medium/high`) and its own "Gemini 4 Argon" weekly
/// group, and a chat on Argon answers 200 where the `ide` agent got 404.
/// `hub/2.11.0` and older lose Argon (and below that, the Gemini group).
/// Sign-in (`loadCodeAssist`) and the other models answer the same either way.
#[must_use]
pub fn user_agent() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("antigravity/hub/{ANTIGRAVITY_CLIENT_VERSION} {os}/{arch}")
}

/// `ClientMetadata` for `loadCodeAssist` / `onboardUser`: ideType 9 is
/// Antigravity, pluginType 2 the agent, platform the IDE's own OS enum.
#[must_use]
pub fn client_metadata() -> serde_json::Value {
    let platform = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => 2,
        ("macos", _) => 1,
        ("linux", "aarch64") => 4,
        ("linux", _) => 3,
        ("windows", _) => 5,
        _ => 0,
    };
    serde_json::json!({ "ideType": 9, "platform": platform, "pluginType": 2 })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `ide` loses Gemini 4 Argon whatever the version; see [`user_agent`].
    #[test]
    fn requests_present_as_the_desktop_app() {
        let ua = user_agent();
        assert!(ua.starts_with("antigravity/hub/2.23.1 "), "{ua}");
        assert_eq!(ua.split(' ').count(), 2, "{ua}");
    }
}
