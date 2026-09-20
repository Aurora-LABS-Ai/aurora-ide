//! DeepSeek — reading what is left on the account.
//!
//! One command, because one thing about DeepSeek is not already covered by the
//! three wire adapters: the balance. Chat, tools, thinking and context caching
//! all run through [`crate::api::deepseek`], [`crate::api::anthropic`] or
//! [`crate::api::responses`] depending on the row's wire.
//!
//! ## Unlike every other account read Aurora does, this one just works
//!
//! kenari needs a browser sign-in because its key cannot reach the account.
//! Volcano needs the console's cookies for the same reason. Command Code reads
//! a credential file the CLI wrote. DeepSeek needs none of that: the same
//! `sk-` key that serves chat authenticates
//! `GET https://api.deepseek.com/user/balance`, it is in the public API
//! reference, and it answered 200 with real figures on a live account
//! (2026-09-20). So there is nothing to connect — paste a key and the card
//! fills in.
//!
//! ## It is a balance, not a quota
//!
//! Every other provider card in this family draws a meter, because those
//! accounts meter a rolling window and refuse requests when it empties.
//! DeepSeek is pay-as-you-go: there is no window, no reset, and no percentage
//! — running out is `402 Insufficient Balance` on the next request. A bar
//! needs a ceiling and this has none, so what gets drawn is the number and the
//! account's own `is_available` flag, which is DeepSeek's judgement rather
//! than a threshold Aurora invented.
//!
//! ## Two currencies is normal
//!
//! The live account returned a CNY row and a USD row side by side. Both are
//! carried through in the order DeepSeek sent them; picking one here would
//! mean guessing which wallet the next request spends from.

use serde::{Deserialize, Serialize};

/// Where the account lives, when the row's own base URL says nothing useful.
const DEEPSEEK_API_ROOT: &str = "https://api.deepseek.com";

/// One wallet, in one currency.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepSeekBalance {
    /// `CNY` or `USD`, as DeepSeek reported it.
    pub currency: String,
    /// Everything spendable: granted plus topped up.
    pub total: f64,
    /// Promotional credit that has not expired.
    pub granted: f64,
    /// What was paid in.
    pub topped_up: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepSeekBalanceSnapshot {
    /// DeepSeek's own answer to "can this account still call the API". Carried
    /// rather than derived from the totals: a zero CNY wallet beside a funded
    /// USD one is not an unusable account, and only the vendor knows that.
    pub is_available: bool,
    /// Every wallet the account reports, in the order it reported them.
    pub balances: Vec<DeepSeekBalance>,
    pub fetched_at_ms: i64,
}

// ── Wire types ───────────────────────────────────────────────────────────────
// The amounts arrive as STRINGS (`"13.79"`), which is why these are not `f64`
// on the wire. Every field is optional so a shape drift degrades the card
// rather than failing the read.

#[derive(Debug, Deserialize)]
struct WireRoot {
    #[serde(default)]
    is_available: Option<bool>,
    #[serde(default)]
    balance_infos: Vec<WireBalance>,
}

#[derive(Debug, Deserialize)]
struct WireBalance {
    #[serde(default)]
    currency: Option<String>,
    #[serde(default)]
    total_balance: Option<String>,
    #[serde(default)]
    granted_balance: Option<String>,
    #[serde(default)]
    topped_up_balance: Option<String>,
}

fn amount(raw: Option<&String>) -> f64 {
    raw.and_then(|s| s.trim().parse::<f64>().ok()).unwrap_or(0.0)
}

/// The account root behind whatever the row's base URL happens to be.
///
/// The balance endpoint hangs off the ROOT, not off the wire path: a row set
/// to the Anthropic wire points at `…/anthropic`, and asking that for
/// `/user/balance` is a 404. Each of the three wire suffixes is peeled back to
/// the account, and a blank URL falls back to DeepSeek's own host so the
/// built-in row works before anyone edits anything.
#[must_use]
pub fn balance_url(base_url: &str) -> String {
    let mut root = base_url.trim().trim_end_matches('/');
    if root.is_empty() {
        root = DEEPSEEK_API_ROOT;
    }
    for suffix in ["/anthropic/v1", "/anthropic", "/beta", "/v1"] {
        if let Some(stripped) = root.strip_suffix(suffix) {
            root = stripped.trim_end_matches('/');
            break;
        }
    }
    if root.is_empty() {
        root = DEEPSEEK_API_ROOT;
    }
    format!("{root}/user/balance")
}

/// How much is left on the account.
///
/// `async` with the request awaited inline: a sync `#[tauri::command]` runs on
/// the UI thread in Tauri v2, and this one makes a network call.
///
/// Errors come back as a sentence somebody can act on, because the two that
/// matter are both fixable — a rejected key and an unreachable host — and a
/// card that silently shows nothing would read as "no balance", which on a
/// pay-as-you-go account is the one reading that is never true.
#[tauri::command]
pub async fn deepseek_balance_get(
    api_key: String,
    base_url: Option<String>,
) -> Result<DeepSeekBalanceSnapshot, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("Add your DeepSeek API key to read the balance.".to_string());
    }
    let url = balance_url(base_url.as_deref().unwrap_or_default());

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Could not start the request: {e}"))?;

    let response = client
        .get(&url)
        .bearer_auth(key)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Could not reach DeepSeek: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        // 401 is the one people hit, and "401" alone sends them to check the
        // network. Named, it sends them to the field they actually mistyped.
        let hint = match status.as_u16() {
            401 => " — the key was rejected.",
            402 => " — the account is out of balance.",
            _ => "",
        };
        return Err(format!("DeepSeek answered {status}{hint}"));
    }

    let parsed: WireRoot = response
        .json()
        .await
        .map_err(|e| format!("DeepSeek's balance reply could not be read: {e}"))?;

    let balances = parsed
        .balance_infos
        .into_iter()
        .map(|b| DeepSeekBalance {
            currency: b.currency.unwrap_or_else(|| "USD".to_string()),
            total: amount(b.total_balance.as_ref()),
            granted: amount(b.granted_balance.as_ref()),
            topped_up: amount(b.topped_up_balance.as_ref()),
        })
        .collect();

    Ok(DeepSeekBalanceSnapshot {
        is_available: parsed.is_available.unwrap_or(true),
        balances,
        fetched_at_ms: chrono::Utc::now().timestamp_millis(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn balance_url_peels_every_wire_suffix_back_to_the_account() {
        // The three shapes a DeepSeek row can be pointed at, plus the empty
        // one the built-in preset ships with before anyone edits it.
        assert_eq!(
            balance_url("https://api.deepseek.com/v1"),
            "https://api.deepseek.com/user/balance"
        );
        assert_eq!(
            balance_url("https://api.deepseek.com/anthropic/v1"),
            "https://api.deepseek.com/user/balance"
        );
        assert_eq!(
            balance_url("https://api.deepseek.com/anthropic"),
            "https://api.deepseek.com/user/balance"
        );
        assert_eq!(
            balance_url("https://api.deepseek.com/beta/"),
            "https://api.deepseek.com/user/balance"
        );
        assert_eq!(balance_url(""), "https://api.deepseek.com/user/balance");
    }

    #[test]
    fn balance_url_keeps_a_proxy_host() {
        // Somebody fronting DeepSeek with their own gateway must still be
        // asked about THEIR account, not about api.deepseek.com.
        assert_eq!(
            balance_url("https://proxy.internal/deepseek/v1"),
            "https://proxy.internal/deepseek/user/balance"
        );
    }

    #[test]
    fn amounts_arrive_as_strings_on_the_wire() {
        let wire: WireRoot = serde_json::from_str(
            r#"{"is_available":true,"balance_infos":[
                 {"currency":"CNY","total_balance":"13.79","granted_balance":"0.00","topped_up_balance":"13.79"},
                 {"currency":"USD","total_balance":"8.99","granted_balance":"0.00","topped_up_balance":"8.99"}]}"#,
        )
        .expect("parse");
        assert_eq!(wire.balance_infos.len(), 2);
        assert!((amount(wire.balance_infos[0].total_balance.as_ref()) - 13.79).abs() < 1e-9);
        assert!((amount(wire.balance_infos[1].total_balance.as_ref()) - 8.99).abs() < 1e-9);
    }

    #[test]
    fn a_missing_field_reads_as_zero_rather_than_failing() {
        let wire: WireRoot =
            serde_json::from_str(r#"{"balance_infos":[{"currency":"USD"}]}"#).expect("parse");
        assert!(wire.is_available.is_none());
        assert_eq!(amount(wire.balance_infos[0].total_balance.as_ref()), 0.0);
    }
}
