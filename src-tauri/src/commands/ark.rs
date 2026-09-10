//! Volcano Ark Coding Plan — reading the quota, which needs a browser session.
//!
//! ## Why the key cannot answer this
//!
//! The `ark-` key is a Coding Plan key. It reaches the inference gateway at
//! `/api/coding/v3` (and `/api/coding/v1/messages`) and nothing else. Presented
//! to Volcano's control plane it is refused before the account is even looked
//! up: `POST open.volcengineapi.com/?Action=GetCodingPlanUsage` answers
//! `InvalidAuthorization` on a Bearer `ark-` key. Measured, not read off a page.
//!
//! The documented way to read quota is that same control-plane action signed
//! with an Access Key pair, and that route is closed to a large share of
//! accounts: creating an Access Key requires Volcano's real-name verification,
//! which wants Chinese identity documents. An account that cannot verify has a
//! working subscription and no signable credential for it.
//!
//! ## What is used instead
//!
//! The console reads its own quota through a same-origin proxy that takes a
//! session instead of a signature:
//!
//! ```text
//! POST https://console.volcengine.com/api/top/ark/cn-beijing/2024-01-01/GetCodingPlanUsage
//! body:    {}
//! headers: cookie + x-csrf-token
//! ```
//!
//! No signing, no Access Key, and reachable from outside China. So Aurora does
//! what it does for kenari: opens the console in a WebView, lets the person sign
//! in there, and keeps a copy of the cookies that come back.
//!
//! **The CSRF token is a cookie, not a secret handed out separately.** The
//! console's own bundle builds the header from `document.cookie`:
//!
//! ```js
//! "X-Csrf-Token": document.cookie.split("; ").find(e => e.startsWith("csrfToken="))?.split("=")[1]
//! ```
//!
//! Classic double-submit, so `csrfToken` is readable and Aurora copies it the
//! same way. Every other cookie for the origin travels as-is, because which one
//! carries the session is Volcano's business and naming it here would be a guess
//! that breaks the day they rename it.
//!
//! ## The trap in this API: errors arrive as HTTP 200
//!
//! Volcano's console proxy reports failures in the body with the status left at
//! `200 OK` — a request with no CSRF header comes back `200` carrying
//! `Error.Code: InvalidCSRFToken`. Checking `status.is_success()` would read
//! every refusal as a successful empty read and draw an empty quota card over a
//! broken session. So [`ResponseMetadata::Error`] is the authority here, not the
//! status line.
//!
//! ## What expiry looks like
//!
//! The same as kenari's, deliberately: expiry is discovered by being refused,
//! never guessed from a clock. A refused read reports
//! [`ArkError::SessionExpired`], the card offers Sign in again, and the ring
//! drops the block rather than showing a stale bar. Nothing here re-signs on a
//! schedule; a session keeps working until the server stops accepting it.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

use crate::paths;

/// The console origin. Every path in this module hangs off it.
const ARK_ORIGIN: &str = "https://console.volcengine.com";

/// Where the person is sent to sign in.
///
/// The Coding Plan page itself, not a login URL. Signed out, the console
/// redirects here to its own sign-in and back again afterwards, so this works
/// for both states without Aurora hard-coding an auth path that is theirs to
/// change. It is also the page these reads legitimately come from, which is
/// what the `Referer` below claims.
const ARK_SIGNIN_URL: &str = "https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan";

/// The console proxy's prefix. `top` is Volcano's own name for this route.
const ARK_API_PREFIX: &str = "/api/top/ark/cn-beijing/2024-01-01";

/// The window that hosts the sign-in. One at a time — a second would race the
/// first for the same cookie jar and the same file.
///
/// **The label is load-bearing for security**, exactly as in `kenari.rs`:
/// capabilities are matched by window label and this one matches none of them
/// (`default.json` covers `main` and `agent-window`, `browser.json` covers
/// `browser-*`). The console page, which runs a great deal of third-party
/// script, therefore reaches no Aurora command at all. Renaming this to
/// `browser-signin` would silently hand it remote IPC.
const SIGNIN_LABEL: &str = "ark-signin";

/// The cookie the console copies into `x-csrf-token`. Not httpOnly, by design:
/// a double-submit token has to be readable by the page to be submitted twice.
const COOKIE_CSRF: &str = "csrfToken";

/// The User-Agent the sign-in window runs as and every later request replays.
///
/// Stored with the session rather than re-derived, for the same reason kenari
/// stores it: a session earned under one string has to be replayed under that
/// string, and WebView2's default varies with the runtime installed.
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/// How long to leave the sign-in window open before giving up.
///
/// Five minutes, like kenari's. A Volcano sign-in can mean a password, a phone
/// code, and a slider puzzle, done by a person who may have looked away.
const SIGNIN_TIMEOUT: Duration = Duration::from_secs(300);

/// How often the jar is checked while the window is open.
const POLL_INTERVAL: Duration = Duration::from_millis(700);

// ── Stored session ───────────────────────────────────────────────────────────

/// What Aurora keeps between launches. Snake_case: this file is Aurora's own,
/// not a wire payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSession {
    /// Every cookie the console origin had, already joined into a `Cookie:`
    /// header value.
    ///
    /// Stored whole rather than as named fields. Volcano sets a dozen cookies
    /// across several subdomains and does not document which carries the
    /// session; picking one by name would be a guess, and a guess that silently
    /// stops working is worse than no integration.
    pub cookie_header: String,
    /// `csrfToken`, lifted out because it also has to travel as a header.
    pub csrf_token: String,
    /// The UA this session was earned under.
    pub user_agent: String,
    /// The account id, shown on the card so a person with two Volcano accounts
    /// can tell which one Aurora is reading.
    #[serde(default)]
    pub account_id: Option<String>,
    /// RFC3339. Only ever displayed — expiry is discovered by being refused,
    /// never computed from this.
    #[serde(default)]
    pub saved_at: Option<String>,
}

fn session_file() -> PathBuf {
    paths::auth_dir().join("ark-session.json")
}

fn read_session() -> Option<StoredSession> {
    let raw = std::fs::read_to_string(session_file()).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_session(session: &StoredSession) -> Result<(), String> {
    let dir = paths::auth_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("Could not create {}: {err}", dir.display()))?;
    let body = serde_json::to_string_pretty(session)
        .map_err(|err| format!("Could not serialize the Ark session: {err}"))?;
    std::fs::write(session_file(), body)
        .map_err(|err| format!("Could not save the Ark session: {err}"))
}

fn clear_session() {
    // A missing file is the desired end state, so its absence is not an error.
    let _ = std::fs::remove_file(session_file());
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/// Why a read failed, in the two flavours the caller has to tell apart.
///
/// `SessionExpired` is not something the person did wrong — it is the ordinary
/// end of a session, and the card's answer to it is a button, not red text.
enum ArkError {
    SessionExpired,
    Other(String),
}

impl From<ArkError> for String {
    fn from(err: ArkError) -> String {
        match err {
            ArkError::SessionExpired => {
                "Your Volcano Engine sign-in has expired. Sign in again to keep reading usage."
                    .to_string()
            }
            ArkError::Other(message) => message,
        }
    }
}

/// Whether an error code from the console means "sign in again".
///
/// Matched on substrings rather than an exact list: Volcano's console codes are
/// undocumented and arrive in several shapes (`InvalidCSRFToken`,
/// `AuthN_*`, `*.NotLogin`). A code this does not recognise is reported
/// verbatim instead of being quietly relabelled as an expiry, so an unfamiliar
/// failure reaches the person who can read it.
fn is_auth_error(code: &str) -> bool {
    let code = code.to_ascii_lowercase();
    [
        "csrf",
        "unauthorized",
        "notlogin",
        "not_login",
        "loginrequired",
        "authn",
        "invalidauthorization",
        "accessdenied",
        "credential",
        "sessionexpired",
    ]
    .iter()
    .any(|needle| code.contains(needle))
}

/// Call one console action and hand back its `Result` object.
///
/// **Errors come back as HTTP 200** on this API, so the body is what decides.
/// See the module note.
async fn call_action(
    session: &StoredSession,
    action: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, ArkError> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|err| ArkError::Other(format!("Could not reach the Volcano console: {err}")))?;

    let response = client
        .post(format!("{ARK_ORIGIN}{ARK_API_PREFIX}/{action}"))
        .header("accept", "application/json")
        .header("content-type", "application/json")
        .header("user-agent", &session.user_agent)
        .header("cookie", &session.cookie_header)
        .header("x-csrf-token", &session.csrf_token)
        // The console checks that a state-changing POST came from its own page.
        // This one genuinely did.
        .header("origin", ARK_ORIGIN)
        .header("referer", ARK_SIGNIN_URL)
        .json(&body)
        .send()
        .await
        .map_err(|err| ArkError::Other(format!("Could not reach the Volcano console: {err}")))?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();

    // A signed-out request can be answered with the console's own HTML rather
    // than JSON. Reported as an expired session, because that is what it means.
    if text.trim_start().starts_with('<') {
        return Err(ArkError::SessionExpired);
    }

    let parsed: serde_json::Value = serde_json::from_str(&text).map_err(|err| {
        ArkError::Other(format!(
            "The Volcano console sent something unreadable ({status}): {err}"
        ))
    })?;

    if let Some(error) = parsed.pointer("/ResponseMetadata/Error") {
        let code = error
            .get("Code")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if is_auth_error(code) {
            return Err(ArkError::SessionExpired);
        }
        let message = error
            .get("Message")
            .and_then(|value| value.as_str())
            .unwrap_or("the console refused the request");
        return Err(ArkError::Other(format!("{action} failed: {message}")));
    }

    // Only now is the status worth consulting: a 5xx with no error object is
    // the gateway rather than the action.
    if !status.is_success() {
        return Err(ArkError::Other(format!(
            "The Volcano console returned {status}."
        )));
    }

    Ok(parsed
        .get("Result")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

// ── Sign-in ──────────────────────────────────────────────────────────────────

/// What the frontend learns once a sign-in lands.
#[derive(Debug, Clone, Serialize)]
pub struct ArkAccount {
    pub account_id: Option<String>,
}

/// Whether a usable session is stored, and whose.
#[derive(Debug, Clone, Serialize)]
pub struct ArkSessionStatus {
    pub connected: bool,
    pub account_id: Option<String>,
    pub saved_at: Option<String>,
}

#[tauri::command]
pub async fn ark_session_status() -> Result<ArkSessionStatus, String> {
    Ok(match read_session() {
        Some(stored) => ArkSessionStatus {
            connected: true,
            account_id: stored.account_id,
            saved_at: stored.saved_at,
        },
        None => ArkSessionStatus {
            connected: false,
            account_id: None,
            saved_at: None,
        },
    })
}

#[tauri::command]
pub async fn ark_disconnect() -> Result<(), String> {
    clear_session();
    Ok(())
}

/// Open the Coding Plan page and keep the session the person signs in with.
///
/// Returns once cookies have been observed **and** proven by a real
/// `GetCodingPlanUsage` call. Presence alone is not enough: the console sets a
/// `csrfToken` for anonymous visitors too, so a jar can look complete while the
/// person is still typing their password. Storing that buys a card that says
/// connected over an account that is not.
#[tauri::command]
pub async fn ark_connect(app: AppHandle) -> Result<ArkAccount, String> {
    // A window from a previous attempt carries the previous attempt's
    // half-state. Close it rather than adopting it.
    if let Some(existing) = app.get_webview_window(SIGNIN_LABEL) {
        let _ = existing.close();
    }

    let window = WebviewWindowBuilder::new(
        &app,
        SIGNIN_LABEL,
        WebviewUrl::External(
            ARK_SIGNIN_URL
                .parse()
                .map_err(|err| format!("invalid Volcano console url: {err}"))?,
        ),
    )
    .title("Sign in to Volcano Engine")
    .inner_size(1100.0, 800.0)
    .min_inner_size(720.0, 560.0)
    .center()
    .resizable(true)
    // See the module note: a UA Aurora chose is a UA Aurora can replay.
    .user_agent(USER_AGENT)
    .build()
    .map_err(|err| format!("Could not open the Volcano sign-in window: {err}"))?;

    let outcome = await_session(&app, &window).await;

    // Closed on every path, including the error ones. A sign-in window left
    // standing after a failure looks like it is still working.
    let _ = window.close();

    outcome
}

/// Build a `Cookie:` header from every cookie the origin holds, and lift the
/// CSRF token out of it.
///
/// `None` when there is no CSRF cookie yet, which is the ordinary state of a
/// page that has not finished loading.
fn collect_cookies(window: &tauri::WebviewWindow, origin: &Url) -> Option<(String, String)> {
    let cookies = window.cookies_for_url(origin.clone()).unwrap_or_default();
    let mut pairs: Vec<String> = Vec::with_capacity(cookies.len());
    let mut csrf: Option<String> = None;
    for cookie in &cookies {
        let (name, value) = (cookie.name(), cookie.value());
        if value.is_empty() {
            continue;
        }
        if name == COOKIE_CSRF {
            csrf = Some(value.to_string());
        }
        pairs.push(format!("{name}={value}"));
    }
    let csrf = csrf?;
    if pairs.is_empty() {
        return None;
    }
    Some((pairs.join("; "), csrf))
}

/// Poll the sign-in window's jar until a session proves itself, or time runs out.
async fn await_session(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<ArkAccount, String> {
    let origin: Url = ARK_ORIGIN
        .parse()
        .map_err(|err| format!("invalid Volcano console origin: {err}"))?;
    let deadline = std::time::Instant::now() + SIGNIN_TIMEOUT;
    // A jar already refused once will be refused again every 700ms for five
    // minutes. Remembering it keeps the poller from re-asking about cookies
    // that have already answered.
    let mut rejected: Option<String> = None;

    loop {
        if std::time::Instant::now() > deadline {
            return Err(
                "Timed out waiting for the Volcano Engine sign-in. Try connecting again."
                    .to_string(),
            );
        }

        // The person closing the window is a cancellation, not a failure, and
        // it is checked first so it is never reported as a timeout.
        if app.get_webview_window(SIGNIN_LABEL).is_none() {
            return Err("Sign-in was cancelled.".to_string());
        }

        // Hops to the main thread and blocks on the reply, which is safe here
        // and only here: a `#[tauri::command] async fn` runs on a tokio worker,
        // never on the UI thread. Called from the UI thread this deadlocks.
        if let Some((cookie_header, csrf_token)) = collect_cookies(window, &origin) {
            if rejected.as_deref() != Some(cookie_header.as_str()) {
                let mut candidate = StoredSession {
                    cookie_header: cookie_header.clone(),
                    csrf_token,
                    user_agent: USER_AGENT.to_string(),
                    account_id: None,
                    saved_at: None,
                };

                // Proven with the real read, not a cheaper probe: the thing
                // that has to work is this exact call, and a session that can
                // answer some other endpoint is not evidence about this one.
                match call_action(&candidate, "GetCodingPlanUsage", serde_json::json!({})).await {
                    Ok(_) => {
                        candidate.account_id = account_id(&candidate).await;
                        candidate.saved_at = Some(chrono::Utc::now().to_rfc3339());
                        write_session(&candidate)?;
                        return Ok(ArkAccount {
                            account_id: candidate.account_id,
                        });
                    }
                    // Not signed in yet — the anonymous page already set a
                    // csrfToken. Keep waiting; this is the ordinary case.
                    Err(ArkError::SessionExpired) => rejected = Some(cookie_header),
                    // Offline, or the console is down, or the account has no
                    // Coding Plan. Worth saying out loud rather than spinning
                    // silently until the timeout.
                    Err(ArkError::Other(message)) => return Err(message),
                }
            }
        }

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// The console's own id for the signed-in account, for the card's byline.
///
/// Best-effort: a sign-in that reads quota but cannot name the account is still
/// a working sign-in, so a failure here is dropped rather than propagated.
async fn account_id(session: &StoredSession) -> Option<String> {
    let result = call_action(session, "GetAccountInfo", serde_json::json!({}))
        .await
        .ok()?;
    result
        .get("AccountId")
        .map(|value| match value {
            serde_json::Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .filter(|text| !text.is_empty() && text != "null")
}

// ── Usage ────────────────────────────────────────────────────────────────────

/// One metered window, as the ring draws it.
///
/// `used_percent` is what has been SPENT, 0..100 — the wire's own unit. Volcano
/// meters this plan as a share and never publishes a request count, so a
/// percentage is the whole truth here rather than a derived summary of counts.
#[derive(Debug, Clone, Serialize)]
pub struct ArkWindow {
    pub used_percent: f64,
    /// Unix seconds. An INSTANT, unlike kenari's duration.
    pub resets_at_unix: Option<i64>,
}

/// The plan's headroom, which is the whole point of this module.
#[derive(Debug, Clone, Serialize)]
pub struct ArkUsage {
    /// `lite` or `pro`, from `ListSubscribeTrade`. Absent when that call fails,
    /// which does not stop the quota being drawn.
    pub tier: Option<String>,
    /// The subscription's own word for its state, e.g. `Running`.
    pub status: Option<String>,
    /// The rolling five-hour window. Volcano calls this level `session`.
    pub window_session: Option<ArkWindow>,
    pub window_week: Option<ArkWindow>,
    pub window_month: Option<ArkWindow>,
    /// When the subscription itself lapses, RFC3339 as the console sends it.
    pub expires_at: Option<String>,
    /// Whether bonus quota is attached to the account. Volcano's own flag.
    pub has_reward: bool,
}

/// Read one `QuotaUsage` entry.
///
/// `Cap` is carried on the wire and is `100` on every account measured, so the
/// percentage is already a percentage. It is divided through anyway: a cap that
/// is ever anything else would otherwise silently rescale every bar, and the
/// arithmetic is free.
fn read_window(entry: &serde_json::Value) -> Option<ArkWindow> {
    let percent = entry.get("Percent").and_then(|value| value.as_f64())?;
    let cap = entry
        .get("Cap")
        .and_then(|value| value.as_f64())
        .filter(|cap| *cap > 0.0)
        .unwrap_or(100.0);
    Some(ArkWindow {
        // Clamped: a meter drawn past its own track reads as a rendering bug
        // rather than as "over the limit".
        used_percent: (percent / cap * 100.0).clamp(0.0, 100.0),
        resets_at_unix: entry
            .get("ResetTimestamp")
            .and_then(|value| value.as_i64())
            .filter(|stamp| *stamp > 0),
    })
}

/// How much of the Coding Plan is left. Requires a stored sign-in.
#[tauri::command]
pub async fn ark_usage() -> Result<ArkUsage, String> {
    let Some(session) = read_session() else {
        return Err("Sign in to Volcano Engine to see plan usage.".to_string());
    };

    let result = call_action(&session, "GetCodingPlanUsage", serde_json::json!({})).await?;

    let mut usage = ArkUsage {
        tier: None,
        status: result
            .get("Status")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        window_session: None,
        window_week: None,
        window_month: None,
        expires_at: None,
        has_reward: result
            .get("HasReward")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
    };

    for entry in result
        .get("QuotaUsage")
        .and_then(|value| value.as_array())
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let Some(level) = entry.get("Level").and_then(|value| value.as_str()) else {
            continue;
        };
        let window = read_window(entry);
        match level {
            "session" => usage.window_session = window,
            "weekly" => usage.window_week = window,
            "monthly" => usage.window_month = window,
            // A level Volcano adds later is skipped rather than guessed into
            // one of the three above.
            _ => {}
        }
    }

    // The tier and the expiry date live on a different action. Best-effort: a
    // quota reading with no tier name is still worth drawing, and losing the
    // whole card because the subscription lookup blipped would be the wrong
    // trade.
    if let Ok(trade) = call_action(
        &session,
        "ListSubscribeTrade",
        serde_json::json!({
            "ResourceTypes": ["CodingPlan"],
            "ResourceNames": [""],
            "BizInfos": ["lite", "pro"],
        }),
    )
    .await
    {
        if let Some(info) = trade
            .get("InfoList")
            .and_then(|value| value.as_array())
            .and_then(|list| list.first())
        {
            usage.tier = info
                .get("BizInfo")
                .and_then(|value| value.as_str())
                .map(str::to_string);
            usage.expires_at = info
                .get("EndTime")
                .and_then(|value| value.as_str())
                .map(str::to_string);
        }
    }

    Ok(usage)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_reads_the_live_shape() {
        // Verbatim from a live account's `GetCodingPlanUsage`.
        let raw = serde_json::json!({
            "Level": "session",
            "Percent": 1.5544235,
            "ResetTimestamp": 1_789_079_173_i64,
            "Cap": 100,
            "RewardTotalPercent": 0,
        });
        let window = read_window(&raw).expect("a window");
        assert!((window.used_percent - 1.554_423_5).abs() < 1e-9);
        assert_eq!(window.resets_at_unix, Some(1_789_079_173));
    }

    #[test]
    fn a_cap_that_is_not_a_hundred_rescales_rather_than_lying() {
        let raw = serde_json::json!({ "Percent": 25.0, "Cap": 50 });
        let window = read_window(&raw).expect("a window");
        assert!((window.used_percent - 50.0).abs() < f64::EPSILON);
    }

    #[test]
    fn a_missing_percent_is_absent_rather_than_zero() {
        // A window drawn at 0% says "untouched" about a window nobody reported.
        assert!(read_window(&serde_json::json!({ "Level": "weekly" })).is_none());
    }

    #[test]
    fn a_window_past_its_limit_still_draws_inside_its_track() {
        let raw = serde_json::json!({ "Percent": 140.0, "Cap": 100 });
        assert_eq!(read_window(&raw).expect("a window").used_percent, 100.0);
    }

    #[test]
    fn a_zero_reset_stamp_is_no_reset_rather_than_the_epoch() {
        let raw = serde_json::json!({ "Percent": 1.0, "ResetTimestamp": 0 });
        assert_eq!(read_window(&raw).expect("a window").resets_at_unix, None);
    }

    #[test]
    fn the_csrf_refusal_is_read_as_an_expiry() {
        // The live refusal, verbatim: this is what a signed-out call returns,
        // and it arrives with HTTP 200.
        assert!(is_auth_error("InvalidCSRFToken"));
        assert!(is_auth_error("AuthN_MissOrInvalidAuthorizationHeader"));
    }

    #[test]
    fn an_unfamiliar_code_is_not_relabelled_as_an_expiry() {
        // Sending someone to re-authenticate a working session is worse than
        // showing them the message the console actually sent.
        assert!(!is_auth_error("OperationDenied.operate"));
        assert!(!is_auth_error("InvalidParameter"));
    }
}
