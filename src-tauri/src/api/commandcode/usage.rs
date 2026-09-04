//! Plan, spend windows and credit balance for the Command Code card.
//!
//! Three endpoints, read together because no single one answers "can I keep
//! working":
//!
//! - `GET /alpha/billing/credits` — the two rolling spend windows (five-hour
//!   and weekly, each with a dollar cap and a reset timestamp) plus the credit
//!   balance. This is the one that matters.
//! - `GET /alpha/billing/subscriptions` — which plan, and when it renews.
//! - `GET /alpha/whoami` — the account behind the key.
//!
//! `whoami` is not redundant with `~/.commandcode/auth.json`. A key pasted on
//! the provider page has no name stored beside it, so without this the card
//! could not say whose account is being billed, which is the first question a
//! surprise charge raises.
//!
//! Both caps are shown rather than the tighter one. Spending the weekly cap on
//! a Tuesday and spending the five-hour cap for the next forty minutes are
//! different problems with different answers.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::auth;
use super::COMMANDCODE_API_ROOT;

/// One rolling spend window.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCodeWindow {
    /// Dollars spent in this window.
    pub used: f64,
    /// Dollars this window allows.
    pub cap: f64,
    pub exceeded: bool,
    /// Unix milliseconds. Sent raw rather than as a countdown so a card left
    /// open keeps counting down instead of freezing at the value it fetched.
    pub reset_at_ms: Option<i64>,
}

impl CommandCodeWindow {
    fn parse(value: Option<&Value>) -> Option<Self> {
        let value = value?;
        let cap = value.get("cap").and_then(Value::as_f64)?;
        Some(Self {
            used: value.get("used").and_then(Value::as_f64).unwrap_or(0.0),
            cap,
            exceeded: value
                .get("exceeded")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            reset_at_ms: value.get("resetAt").and_then(Value::as_i64),
        })
    }
}

/// What is left to spend, by source.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCodeCredits {
    /// The plan's monthly allowance still unspent.
    pub monthly: f64,
    /// Top-ups bought on top of the plan.
    pub purchased: f64,
    pub free: f64,
    /// The account has crossed its own low-balance threshold.
    pub below_threshold: bool,
}

/// Everything the card renders.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCodeUsageSnapshot {
    /// Raw plan id, e.g. `individual-go`.
    pub plan_id: Option<String>,
    /// Readable tier, e.g. `Go`.
    pub plan_label: Option<String>,
    /// `active`, `past_due`, `canceled`, …
    pub status: Option<String>,
    /// ISO timestamp the current billing period ends.
    pub renews_at: Option<String>,
    /// The plan is set to lapse at the end of this period.
    pub cancel_at_period_end: bool,
    pub credits: CommandCodeCredits,
    pub five_hour: Option<CommandCodeWindow>,
    pub weekly: Option<CommandCodeWindow>,
    /// Whether windows apply at all. Some plans report `limited: false`, in
    /// which case a meter would invent a ceiling that is not there.
    pub limited: bool,
    pub account_name: Option<String>,
    pub account_email: Option<String>,
}

/// Read the plan, the windows and the balance.
///
/// `row_key` is the provider row's key; empty falls back to the CLI's stored
/// one, the same order a real request uses.
///
/// Only the credits call is allowed to fail the whole read. The plan name and
/// the account are labels: losing one should not blank a card whose meters
/// arrived fine.
pub async fn fetch(row_key: &str) -> Result<CommandCodeUsageSnapshot, String> {
    let (key, _source) = auth::resolve_api_key(row_key)?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|err| format!("Couldn't build the HTTP client: {err}"))?;

    let (credits, subscription, whoami) = tokio::join!(
        get_json(&client, &key, "alpha/billing/credits"),
        get_json(&client, &key, "alpha/billing/subscriptions"),
        get_json(&client, &key, "alpha/whoami"),
    );

    let credits = credits?;
    let windows = credits.get("windowLimits");
    let balance = credits.get("credits");

    let subscription = subscription.ok().unwrap_or(Value::Null);
    let plan = subscription.get("data");
    let plan_id = plan
        .and_then(|p| p.get("planId"))
        .and_then(Value::as_str)
        .map(str::to_string);

    let whoami = whoami.ok().unwrap_or(Value::Null);
    let user = whoami.get("user");

    Ok(CommandCodeUsageSnapshot {
        plan_label: plan_id.as_deref().map(plan_label),
        plan_id,
        status: plan
            .and_then(|p| p.get("status"))
            .and_then(Value::as_str)
            .map(str::to_string),
        renews_at: plan
            .and_then(|p| p.get("currentPeriodEnd"))
            .and_then(Value::as_str)
            .map(str::to_string),
        cancel_at_period_end: plan
            .and_then(|p| p.get("cancelAtPeriodEnd"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        credits: CommandCodeCredits {
            monthly: number(balance, "monthlyCredits"),
            purchased: number(balance, "purchasedCredits"),
            free: number(balance, "freeCredits"),
            below_threshold: balance
                .and_then(|b| b.get("belowThreshold"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        },
        five_hour: CommandCodeWindow::parse(windows.and_then(|w| w.get("fiveHour"))),
        weekly: CommandCodeWindow::parse(windows.and_then(|w| w.get("weekly"))),
        limited: windows
            .and_then(|w| w.get("limited"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        account_name: user
            .and_then(|u| u.get("userName").or_else(|| u.get("name")))
            .and_then(Value::as_str)
            .map(str::to_string),
        account_email: user
            .and_then(|u| u.get("email"))
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn number(node: Option<&Value>, key: &str) -> f64 {
    node.and_then(|n| n.get(key))
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
}

async fn get_json(client: &reqwest::Client, key: &str, path: &str) -> Result<Value, String> {
    let response = client
        .get(format!("{COMMANDCODE_API_ROOT}/{path}"))
        .header("Authorization", format!("Bearer {key}"))
        .header("x-command-code-version", auth::cli_version())
        .send()
        .await
        .map_err(|err| format!("Couldn't reach Command Code: {err}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "Command Code returned {} for {path}: {}",
            status.as_u16(),
            body.chars().take(200).collect::<String>()
        ));
    }
    serde_json::from_str(&body).map_err(|err| format!("Couldn't read {path}: {err}"))
}

/// Readable tier from a plan id.
///
/// Ids are `individual-<tier>` today. Anything unrecognised is title-cased
/// rather than dropped, so a plan added next month shows its own name instead
/// of a blank where the tier should be.
#[must_use]
pub fn plan_label(plan_id: &str) -> String {
    let tier = plan_id.rsplit('-').next().unwrap_or(plan_id);
    match tier.to_ascii_lowercase().as_str() {
        "go" => "Go".to_string(),
        "goat" => "GOAT".to_string(),
        "pro" => "Pro".to_string(),
        "max" => "Max".to_string(),
        other => {
            let mut chars = other.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => plan_id.to_string(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn windows_parse_the_live_shape() {
        let value = json!({
            "used": 0.00037, "cap": 3, "exceeded": false, "resetAt": 1788413827433i64
        });
        let window = CommandCodeWindow::parse(Some(&value)).expect("parses");
        assert_eq!(window.cap, 3.0);
        assert_eq!(window.reset_at_ms, Some(1788413827433));
        assert!(!window.exceeded);
    }

    #[test]
    fn a_window_without_a_cap_is_no_window() {
        // No ceiling means no meter. Rendering one would invent a limit.
        assert!(CommandCodeWindow::parse(Some(&json!({ "used": 1.0 }))).is_none());
        assert!(CommandCodeWindow::parse(None).is_none());
    }

    /// Against the real billing endpoints, using whatever key this machine
    /// has. Ignored by default: needs network and an account.
    ///
    /// `cargo test --lib commandcode -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "hits the live Command Code API; needs an account"]
    async fn live_usage_reads_the_plan_and_both_windows() {
        let snapshot = fetch("").await.expect("usage should load");
        println!("{snapshot:#?}");
        assert!(
            snapshot.plan_label.is_some(),
            "the subscription endpoint should name a plan"
        );
        let five_hour = snapshot.five_hour.expect("a five-hour window");
        let weekly = snapshot.weekly.expect("a weekly window");
        // Caps are dollars and always positive; a zero would make the meter
        // divide by nothing and read as permanently full.
        assert!(five_hour.cap > 0.0);
        assert!(weekly.cap > 0.0);
        assert!(weekly.cap >= five_hour.cap, "the weekly cap is the wider one");
        assert!(snapshot.account_email.is_some(), "whoami should name the account");
    }

    #[test]
    fn plan_ids_become_the_tier_names_the_pricing_page_uses() {
        assert_eq!(plan_label("individual-go"), "Go");
        assert_eq!(plan_label("individual-goat"), "GOAT");
        assert_eq!(plan_label("individual-pro"), "Pro");
        assert_eq!(plan_label("individual-max"), "Max");
        // Unknown tiers keep their name rather than vanishing.
        assert_eq!(plan_label("team-enterprise"), "Enterprise");
    }
}
