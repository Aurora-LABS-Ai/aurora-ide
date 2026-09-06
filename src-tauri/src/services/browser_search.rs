//! The browser, as the search ladder's last rung.
//!
//! ## What this is for
//!
//! Both of DuckDuckGo's no-JavaScript endpoints answer a request they dislike
//! with a challenge page — 200 OK, no results, nothing that reads as an error.
//! No HTTP client gets past that by trying harder: the challenge is testing for
//! a browser, and the honest way to pass it is to be one. Aurora already has a
//! browser, so the search that would otherwise have failed loads the full site
//! in it and reads the rendered page.
//!
//! Four public search back ends were probed for this job in an earlier session
//! and none survived — Mojeek serves a captcha, three SearXNG instances answer
//! 429 or 403, and Marginalia's API does not resolve. Adding one of those would
//! have made the ladder longer and no more reliable. A real browser is the rung
//! that actually adds something none of the others has.
//!
//! ## Its own window, not the panel the user is looking at
//!
//! The obvious implementation drives the agent window's Browser panel. It is
//! also wrong: a search is a background step of a turn, and taking the page the
//! user (or the agent's own browser tools) is working on and navigating it to a
//! results list would destroy state nobody asked to lose — a filled form, a
//! logged-in session, the page an inspection was halfway through.
//!
//! So this owns [`SEARCH_BROWSER_LABEL`], a webview of its own. It is a child
//! of the agent window like every browser here — Aurora removed standalone
//! browser windows deliberately — but it is parked outside the visible client
//! area, and nothing else ever navigates it.
//!
//! **Why it is parked rather than shrunk to nothing.** A zero- or one-pixel
//! webview lays the page out in a viewport of that size, and every element in
//! it then has a zero-width bounding rect. `wait_for` treats a zero-size
//! element as not yet rendered, so the wait would run to its deadline on a page
//! that had loaded perfectly. It gets a real desktop viewport and a position
//! far off the top-left instead.

use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use tokio::sync::Mutex;

use crate::services::browser_runtime::{BrowserManager, CreateBrowserWindow, EmbedConfig};
use crate::websearch::PageSource;

/// One search at a time in the search webview.
///
/// `auroro_websearch` is `concurrency_safe`, so the runtime dispatches a batch
/// of them at once — which is right for the HTTP back ends and impossible for
/// this one. There is a single webview: two searches sharing it would each
/// navigate it out from under the other and read whichever page won, and both
/// would report the results as their own. The lock is taken only on the rung
/// that touches the browser, so a batch of ordinary searches still runs in
/// parallel.
fn one_at_a_time() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// The window this and nothing else drives. The `browser-` prefix is what the
/// capability allowlist targets with a wildcard, so it is not optional.
pub const SEARCH_BROWSER_LABEL: &str = "browser-search";

/// The window every browser here is a child of.
const HOST_LABEL: &str = "agent-window";

/// Where the search webview sits: a desktop-shaped viewport, parked far enough
/// up and left that no part of it can land inside the host's content area.
const OFFSCREEN_X: f64 = -4000.0;
const OFFSCREEN_Y: f64 = -4000.0;
const VIEWPORT_W: f64 = 1280.0;
const VIEWPORT_H: f64 = 900.0;

/// How long one attempt polls INSIDE the page for the results to appear.
const ATTEMPT_MS: u64 = 4_000;

/// How long attempts keep being made before giving up altogether.
///
/// Generous on purpose: this rung only ever runs after the HTTP back ends have
/// failed, so the search is slow either way and the choice is between a few
/// more seconds and no answer at all.
const READY_BUDGET_MS: u64 = 15_000;

/// Pause before each attempt, to let a navigation commit.
const SETTLE_MS: u64 = 400;

/// Runs the search ladder's browser rung.
pub struct BrowserPageSource {
    manager: Arc<BrowserManager>,
}

impl BrowserPageSource {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }

    /// Make sure the search webview exists, without disturbing anything else.
    ///
    /// Creating it needs the agent window, so a call from a process that has
    /// none — the IDE window on its own, a test — fails here with a reason
    /// rather than a panic, and the ladder reports the rung as unavailable.
    fn ensure_window(&self) -> Result<(), String> {
        if self.manager.has_window(SEARCH_BROWSER_LABEL) {
            return Ok(());
        }
        self.manager.create_window(CreateBrowserWindow {
            label: SEARCH_BROWSER_LABEL.to_string(),
            // `about:blank` first: creating the window and navigating are two
            // steps everywhere else in this file's flow, and doing the same
            // here means one path to debug rather than two.
            url: "about:blank".to_string(),
            title: Some("Aurora search".to_string()),
            width: Some(VIEWPORT_W),
            height: Some(VIEWPORT_H),
            x: None,
            y: None,
            always_on_top: None,
            embed: Some(EmbedConfig {
                host_label: HOST_LABEL.to_string(),
                x: OFFSCREEN_X,
                y: OFFSCREEN_Y,
                width: VIEWPORT_W,
                height: VIEWPORT_H,
            }),
        })
    }
}

#[async_trait]
impl PageSource for BrowserPageSource {
    async fn rendered_html(&self, url: &str, ready_selector: &str) -> Result<String, String> {
        // Held for the whole navigate → wait → read sequence, because the page
        // read has to be the page this call asked for.
        let _turn = one_at_a_time().lock().await;

        self.ensure_window()?;
        self.manager.navigate(SEARCH_BROWSER_LABEL, url)?;

        // ── Waiting for the page, and why it is a loop ──────────────────
        //
        // `navigate` returns as soon as the navigation is STARTED. A script
        // evaluated in the moment after it lands in the document being
        // replaced — it is torn down with that document and its answer never
        // arrives, so the call does not fail, it hangs until the channel gives
        // up. Measured live on 2026-09-05: the rung reported `browser request
        // '…' timed out after 14s` on a search a browser answers instantly,
        // and one long wait had no way to recover from having been made one
        // moment too early.
        //
        // Retrying is what fixes it. Each attempt polls inside the page for a
        // few seconds; an attempt whose answer never comes was evaluated in a
        // doomed document, or before the webview had one, and the next attempt
        // lands in the real page.
        //
        // Waiting on the results themselves, not on a load event: the app
        // fires `load` with an empty shell and fills it from script, so a
        // load-event wait reads the page one frame before it says anything.
        let deadline = Instant::now() + Duration::from_millis(READY_BUDGET_MS);
        let mut last_error;
        loop {
            tokio::time::sleep(Duration::from_millis(SETTLE_MS)).await;

            match self
                .manager
                .wait_for(SEARCH_BROWSER_LABEL, ready_selector, Some(ATTEMPT_MS))
                .await
            {
                // The page answered. Whatever it said is the truth about it,
                // so this is where the loop ends either way — a page that can
                // reply and has no results is a real answer, not a retry.
                Ok(result) => {
                    let found = result
                        .value
                        .as_ref()
                        .and_then(|v| v.get("found"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    if found {
                        break;
                    }
                    // Named as a wait that expired rather than as an empty
                    // result: the difference between "nothing matched the
                    // query" and "we were shown a challenge page" is the whole
                    // reason this rung exists, and only the first is the web's
                    // answer.
                    return Err(format!(
                        "the page loaded and answered, but nothing matching `{ready_selector}` \
                         appeared — a challenge page, or the site has changed shape"
                    ));
                }
                Err(e) => {
                    last_error = e;
                    if Instant::now() >= deadline {
                        return Err(format!(
                            "the page never answered within {}s — the webview may not be \
                             loading at all. Last attempt: {last_error}",
                            READY_BUDGET_MS / 1000
                        ));
                    }
                }
            }
        }

        let dom = self.manager.get_dom(SEARCH_BROWSER_LABEL, None).await?;
        dom.value
            .as_ref()
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| "the browser returned no page text".to_string())
    }
}
