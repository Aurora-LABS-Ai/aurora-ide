//! kenari — reading the plan's usage, which needs a browser session.
//!
//! ## Why this is not just another API call
//!
//! kenari's `kn-` key reaches the models and nothing else. Every account-shaped
//! read — the weekly quota, the reset clock, the web-search allowance — lives
//! on the dashboard's `/api/*` surface, and that surface answers
//! `401 no session` to a key presented as `Authorization: Bearer`, as
//! `x-api-key`, or as a cookie. Measured against a live account on three
//! endpoints and both header schemes.
//!
//! This is not a gap in Aurora's reading of the docs. It is how kenari is
//! built, and their own tooling says so:
//!
//! - The API reference documents no account endpoint. The only paths in it are
//!   the six model wires, `GET /v1/models`, and `GET /api/public/pricing`.
//! - **`@kenarihq/cli`, kenari's own first-party CLI, contains exactly three
//!   kenari URLs**: `/v1/models`, `/api/cli-auth/token`, and a printed link to
//!   the dashboard's key page. Its `status --check` proves connectivity by
//!   fetching `/v1/models`. There is no `kenari usage` command, because a key
//!   cannot answer that question.
//! - A key minted by `kenari login` — the sanctioned OAuth flow — is `401 no
//!   session` on the same endpoints as a hand-made one. The flow issues an
//!   ordinary API key, labelled `CLI <hostname>` in the dashboard.
//!
//! So a session is the only way, and a session is only obtainable the way a
//! person obtains one: by signing in. `POST /api/login` is behind Cloudflare
//! Turnstile (`"Verifikasi keamanan belum selesai"`) and `/api/auth/google`
//! redirects to `?oauth_error=turnstile`, so there is no headless path either —
//! by design, and Aurora should not want one.
//!
//! ## The shape that follows from that
//!
//! Aurora opens kenari's own login page in a WebView window and lets the person
//! sign in there. Aurora never sees the password and never touches Turnstile;
//! the widget is solved by the human it exists to detect. When the session
//! cookie appears in that WebView's jar, Aurora takes a copy.
//!
//! **The cookie is validated, not merely observed.** `kn_session` can be
//! present and worthless — a half-finished login, a session killed server-side.
//! Storing it on sight buys a card that says "connected" over an account that
//! is not. One `GET /api/me` settles it, and its answer doubles as the email
//! the card shows.
//!
//! ## Cloudflare, and why the User-Agent is stored
//!
//! kenari sits behind Cloudflare, so the jar also holds `cf_clearance` — the
//! token that says a browser passed the challenge. Cloudflare associates it
//! with the client that earned it, so a later request from Rust has to look
//! like the same client or the clearance is worth nothing. The WebView is built
//! with an explicit User-Agent rather than its default for exactly this reason:
//! a UA Aurora chose is a UA Aurora can replay, whereas WebView2's default
//! varies with the runtime installed on the machine and would have to be read
//! back out of the page to be known at all.
//!
//! Requests are then made from Rust rather than from inside a kept-alive
//! WebView. That is the lighter of the two designs and it is the one that was
//! measured working: cookies plus a matching UA, through an ordinary HTTP
//! client, answered 200 on every endpoint this module reads.
//!
//! ## What expiry looks like
//!
//! Both cookies expire, `cf_clearance` sooner than `kn_session`. Nothing here
//! tries to hide that. A read that comes back 401 reports
//! [`KenariError::SessionExpired`], the card offers Sign in again, and the ring
//! drops its kenari block rather than showing a stale bar. A quota that has
//! quietly stopped updating is worse than one that is honestly absent.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

use crate::paths;

/// The dashboard origin. Every path in this module hangs off it.
const KENARI_ORIGIN: &str = "https://kenari.id";

/// Where the person signs in. kenari's own page, unmodified.
const KENARI_LOGIN_URL: &str = "https://kenari.id/login";

/// The window that hosts the login page. One at a time — a second sign-in
/// running beside the first would race for the same cookie jar and the same
/// file, and the person only has one account to sign into anyway.
///
/// **The label is load-bearing for security.** Capabilities are matched by
/// window label, and this one matches none of them: `default.json` covers
/// `main` and `agent-window`, `browser.json` covers `browser-*`. So the page
/// renders with no Tauri command surface at all — kenari's own login page,
/// running third-party script including Cloudflare's, cannot reach a single
/// one of Aurora's commands. Renaming this to `browser-signin` would silently
/// hand it the browser capability, which grants remote IPC.
const SIGNIN_LABEL: &str = "kenari-signin";

/// The session cookie kenari sets. `httpOnly`, which is why this has to come
/// from the WebView's cookie manager rather than from a script in the page.
const COOKIE_SESSION: &str = "kn_session";

/// Cloudflare's "this client passed the challenge" token. Optional in the sense
/// that it is not always set, and required in the sense that when Cloudflare
/// did challenge, a request without it is challenged again.
const COOKIE_CLEARANCE: &str = "cf_clearance";

/// The User-Agent the sign-in window runs as, and the one every later request
/// replays. A real, current Chrome-on-Windows string: WebView2 is Chromium, so
/// this is what it honestly is, minus the `Edg/` suffix that varies by install.
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/// How long to leave the sign-in window open before giving up.
///
/// Five minutes. Signing in means a password, possibly a one-time code, and a
/// Turnstile widget that sometimes thinks about it — all done by a person who
/// may have looked away. The timeout exists so a window closed and forgotten
/// does not leave a poller running for the life of the process, not to hurry
/// anybody.
const SIGNIN_TIMEOUT: Duration = Duration::from_secs(300);

/// How often the jar is checked while the window is open.
///
/// Reading cookies hops to the main thread, so this is not free; but it is one
/// small call and the alternative — waiting on a navigation event — is wrong,
/// because kenari can land a signed-in person on any of several pages and the
/// cookie is the thing that actually matters.
const POLL_INTERVAL: Duration = Duration::from_millis(700);

// ── Stored session ───────────────────────────────────────────────────────────

/// What Aurora keeps between launches. Snake_case: this file is Aurora's, not a
/// wire payload.
///
/// The User-Agent is stored rather than re-derived so that a session keeps
/// working after [`USER_AGENT`] is bumped in a later build. A clearance earned
/// under the old string has to be replayed under the old string.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSession {
    /// `kn_session`.
    pub session: String,
    /// `cf_clearance`, when Cloudflare set one.
    #[serde(default)]
    pub cf_clearance: Option<String>,
    /// The UA this session was earned under.
    pub user_agent: String,
    /// Shown on the card, so a person with two kenari accounts can tell which
    /// one Aurora is reading.
    #[serde(default)]
    pub email: Option<String>,
    /// RFC3339. Only ever displayed — expiry is discovered by being refused,
    /// never guessed from a clock, because the server owns that decision.
    #[serde(default)]
    pub saved_at: Option<String>,
}

impl StoredSession {
    /// The `Cookie:` header value for a request carrying this session.
    fn cookie_header(&self) -> String {
        match &self.cf_clearance {
            Some(clearance) if !clearance.is_empty() => {
                format!(
                    "{COOKIE_SESSION}={}; {COOKIE_CLEARANCE}={clearance}",
                    self.session
                )
            }
            _ => format!("{COOKIE_SESSION}={}", self.session),
        }
    }
}

fn session_file() -> PathBuf {
    paths::auth_dir().join("kenari-session.json")
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
        .map_err(|err| format!("Could not serialize the kenari session: {err}"))?;
    std::fs::write(session_file(), body)
        .map_err(|err| format!("Could not save the kenari session: {err}"))
}

fn clear_session() {
    // A missing file is the desired end state, so its absence is not an error.
    let _ = std::fs::remove_file(session_file());
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/// Why a read failed, in the two flavours the caller has to tell apart.
///
/// `SessionExpired` is not an error the person did anything wrong — it is the
/// ordinary end of a session, and the card's answer to it is a button, not a
/// message in red.
enum KenariError {
    SessionExpired,
    Other(String),
}

impl From<KenariError> for String {
    fn from(err: KenariError) -> String {
        match err {
            KenariError::SessionExpired => {
                "Your kenari sign-in has expired. Sign in again to keep reading usage.".to_string()
            }
            KenariError::Other(message) => message,
        }
    }
}

async fn get_json(session: &StoredSession, path: &str) -> Result<serde_json::Value, KenariError> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|err| KenariError::Other(format!("Could not reach kenari: {err}")))?;

    let response = client
        .get(format!("{KENARI_ORIGIN}{path}"))
        .header("accept", "application/json")
        .header("user-agent", &session.user_agent)
        .header("cookie", session.cookie_header())
        // Cloudflare is measurably happier when the request looks like it came
        // from the page it belongs to, and this one genuinely did.
        .header("referer", format!("{KENARI_ORIGIN}/usage"))
        .send()
        .await
        .map_err(|err| KenariError::Other(format!("Could not reach kenari: {err}")))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(KenariError::SessionExpired);
    }
    if !status.is_success() {
        return Err(KenariError::Other(format!(
            "kenari returned {status}: {}",
            body.trim()
        )));
    }

    // A signed-out request to `/api/*` can be answered with the SPA's own HTML
    // rather than JSON. Reported as an expired session, because that is what it
    // means — not as "kenari sent something unreadable", which sends the reader
    // looking for a parser bug.
    if body.trim_start().starts_with('<') {
        return Err(KenariError::SessionExpired);
    }

    serde_json::from_str(&body)
        .map_err(|err| KenariError::Other(format!("kenari sent something unreadable: {err}")))
}

// ── Sign-in ──────────────────────────────────────────────────────────────────

/// What the frontend learns once a sign-in lands.
#[derive(Debug, Clone, Serialize)]
pub struct KenariAccount {
    pub email: Option<String>,
    /// kenari's own USD/IDR rate, so a Rupiah figure can be shown in dollars
    /// without Aurora inventing an exchange rate.
    pub usd_idr_rate: Option<f64>,
}

/// Whether a usable session is stored, and whose.
#[derive(Debug, Clone, Serialize)]
pub struct KenariSessionStatus {
    pub connected: bool,
    pub email: Option<String>,
    pub saved_at: Option<String>,
}

#[tauri::command]
pub async fn kenari_session_status() -> Result<KenariSessionStatus, String> {
    Ok(match read_session() {
        Some(stored) => KenariSessionStatus {
            connected: true,
            email: stored.email,
            saved_at: stored.saved_at,
        },
        None => KenariSessionStatus {
            connected: false,
            email: None,
            saved_at: None,
        },
    })
}

#[tauri::command]
pub async fn kenari_disconnect() -> Result<(), String> {
    clear_session();
    Ok(())
}

/// Open kenari's login page and keep the session the person signs in with.
///
/// Returns once a cookie has been observed **and** verified against
/// `/api/me` — see the module note on why presence alone is not enough. The
/// window is closed on every exit path, including the error ones: a sign-in
/// window left standing after a failure is a window that looks like it is still
/// working.
#[tauri::command]
pub async fn kenari_connect(app: AppHandle) -> Result<KenariAccount, String> {
    // A window from a previous attempt still carries the previous attempt's
    // half-state. Close it rather than adopting it.
    if let Some(existing) = app.get_webview_window(SIGNIN_LABEL) {
        let _ = existing.close();
    }

    let window = WebviewWindowBuilder::new(
        &app,
        SIGNIN_LABEL,
        WebviewUrl::External(
            KENARI_LOGIN_URL
                .parse()
                .map_err(|err| format!("invalid kenari login url: {err}"))?,
        ),
    )
    .title("Sign in to kenari")
    .inner_size(480.0, 720.0)
    .min_inner_size(380.0, 560.0)
    .center()
    .resizable(true)
    // See the module note: a UA Aurora chose is a UA Aurora can replay.
    .user_agent(USER_AGENT)
    .build()
    .map_err(|err| format!("Could not open the kenari sign-in window: {err}"))?;

    let outcome = await_session(&app, &window).await;

    // Closed on every path. `close()` on an already-closed window is a no-op,
    // which covers the person who signed in and shut the window themselves.
    let _ = window.close();

    outcome
}

/// Poll the sign-in window's jar until a cookie proves itself, or time runs out.
async fn await_session(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<KenariAccount, String> {
    let origin: Url = KENARI_ORIGIN
        .parse()
        .map_err(|err| format!("invalid kenari origin: {err}"))?;
    let deadline = std::time::Instant::now() + SIGNIN_TIMEOUT;
    // A session already refused once will be refused every 700ms for five
    // minutes. Remembering it keeps the poller from re-asking `/api/me` about a
    // cookie that has already answered.
    let mut rejected: Option<String> = None;

    loop {
        if std::time::Instant::now() > deadline {
            return Err(
                "Timed out waiting for the kenari sign-in. Try Sign in to kenari again."
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
        let cookies = window.cookies_for_url(origin.clone()).unwrap_or_default();

        let session = cookies
            .iter()
            .find(|cookie| cookie.name() == COOKIE_SESSION)
            .map(|cookie| cookie.value().to_string())
            .filter(|value| !value.is_empty());

        if let Some(session) = session {
            if rejected.as_deref() != Some(session.as_str()) {
                let clearance = cookies
                    .iter()
                    .find(|cookie| cookie.name() == COOKIE_CLEARANCE)
                    .map(|cookie| cookie.value().to_string())
                    .filter(|value| !value.is_empty());

                let mut candidate = StoredSession {
                    session: session.clone(),
                    cf_clearance: clearance,
                    user_agent: USER_AGENT.to_string(),
                    email: None,
                    saved_at: None,
                };

                match get_json(&candidate, "/api/me").await {
                    Ok(me) => {
                        candidate.email = me
                            .get("email")
                            .and_then(|value| value.as_str())
                            .map(str::to_string);
                        candidate.saved_at = Some(chrono::Utc::now().to_rfc3339());
                        write_session(&candidate)?;
                        return Ok(KenariAccount {
                            email: candidate.email,
                            usd_idr_rate: me.get("usd_idr_rate").and_then(|v| v.as_f64()),
                        });
                    }
                    // Not signed in yet — the cookie exists because the login
                    // page set one before the password was accepted. Keep
                    // waiting; this is the ordinary case, not an error.
                    Err(KenariError::SessionExpired) => rejected = Some(session),
                    // Offline, or kenari is down. Worth saying out loud rather
                    // than silently spinning until the timeout.
                    Err(KenariError::Other(message)) => return Err(message),
                }
            }
        }

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

// ── Usage ────────────────────────────────────────────────────────────────────

/// One rolling quota window, as the ring draws it.
///
/// `used_frac` is what has been spent (0..1); the ring shows what is left,
/// because the two carry the same fact but only one answers "can I keep going".
/// A plan can leave a window unset — `/api/plans` reports `0` for "no limit on
/// this window" — and an unset window is `None` here rather than a full bar.
#[derive(Debug, Clone, Serialize)]
pub struct KenariWindow {
    pub used_frac: f64,
    pub resets_in_secs: Option<i64>,
}

/// The plan's headroom, which is the whole point of this module.
#[derive(Debug, Clone, Serialize)]
pub struct KenariUsage {
    pub plan_name: Option<String>,
    pub plan_status: Option<String>,
    pub window_5h: Option<KenariWindow>,
    pub window_week: Option<KenariWindow>,
    pub window_month: Option<KenariWindow>,
    /// Web searches: how many the plan allows a day and how many are gone.
    pub web_search_allowance: Option<i64>,
    pub web_search_used_today: Option<i64>,
    /// Spend this billing cycle, in micro-Rupiah — kenari's own unit, converted
    /// where it is displayed rather than here, so nothing is rounded twice.
    pub catalog_this_cycle_micro_idr: Option<i64>,
    pub market_this_cycle_micro_idr: Option<i64>,
    /// True when kenari itself says the account is close to a limit. Its
    /// judgement, not a threshold Aurora invented.
    pub near_limit: bool,
}

fn read_window(raw: Option<&serde_json::Value>) -> Option<KenariWindow> {
    let entry = raw?.as_object()?;
    Some(KenariWindow {
        // Clamped: a meter drawn past its own track reads as a rendering bug
        // rather than as "over the limit".
        used_frac: entry
            .get("used_frac")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
            .clamp(0.0, 1.0),
        resets_in_secs: entry.get("resets_in_secs").and_then(|v| v.as_i64()),
    })
}

/// How much of the plan is left. Requires a stored session.
#[tauri::command]
pub async fn kenari_usage() -> Result<KenariUsage, String> {
    let Some(session) = read_session() else {
        return Err("Sign in to kenari to see plan usage.".to_string());
    };

    let body = get_json(&session, "/api/subscription").await?;

    let web_search = body.get("web_search");
    Ok(KenariUsage {
        plan_name: body
            .get("plan_name")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        plan_status: body
            .get("plan_status")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        window_5h: read_window(body.get("window_5h")),
        window_week: read_window(body.get("window_week")),
        window_month: read_window(body.get("window_month")),
        web_search_allowance: web_search
            .and_then(|w| w.get("allowance"))
            .and_then(|v| v.as_i64()),
        web_search_used_today: web_search
            .and_then(|w| w.get("used_today"))
            .and_then(|v| v.as_i64()),
        catalog_this_cycle_micro_idr: body
            .get("catalog_this_cycle_micro_idr")
            .and_then(|v| v.as_i64()),
        market_this_cycle_micro_idr: body
            .get("market_this_cycle_micro_idr")
            .and_then(|v| v.as_i64()),
        near_limit: body
            .get("near_limit")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cookie_header_carries_clearance_when_there_is_one() {
        let session = StoredSession {
            session: "abc".into(),
            cf_clearance: Some("xyz".into()),
            user_agent: USER_AGENT.into(),
            email: None,
            saved_at: None,
        };
        assert_eq!(session.cookie_header(), "kn_session=abc; cf_clearance=xyz");
    }

    #[test]
    fn a_missing_clearance_does_not_produce_an_empty_pair() {
        // `cf_clearance=` with no value is not the same request as one without
        // the cookie at all, and Cloudflare treats it worse.
        let session = StoredSession {
            session: "abc".into(),
            cf_clearance: None,
            user_agent: USER_AGENT.into(),
            email: None,
            saved_at: None,
        };
        assert_eq!(session.cookie_header(), "kn_session=abc");
        let blank = StoredSession {
            cf_clearance: Some(String::new()),
            ..session
        };
        assert_eq!(blank.cookie_header(), "kn_session=abc");
    }

    #[test]
    fn a_window_reports_what_the_account_actually_spent() {
        // The live shape, verbatim: `used_frac` is a fraction, not a percent.
        // Read as a percent it would draw a 0.2%-full bar over a fifth-spent
        // week.
        let raw = serde_json::json!({ "used_frac": 0.20203278766666666, "resets_in_secs": 399967 });
        let window = read_window(Some(&raw)).expect("a window");
        assert!((window.used_frac - 0.202_032_787_666_666_6).abs() < f64::EPSILON);
        assert_eq!(window.resets_in_secs, Some(399_967));
    }

    #[test]
    fn an_unset_window_is_absent_rather_than_full() {
        // A plan with no 5-hour or monthly cap sends JSON null for it. Drawn as
        // a window it would read as a limit that is 100% spent.
        assert!(read_window(Some(&serde_json::Value::Null)).is_none());
        assert!(read_window(None).is_none());
    }

    #[test]
    fn a_window_past_its_limit_still_draws_inside_its_track() {
        let raw = serde_json::json!({ "used_frac": 1.4 });
        assert_eq!(read_window(Some(&raw)).expect("a window").used_frac, 1.0);
    }
}
