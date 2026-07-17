//! AI thread-title maker (OpenAI-compatible, one-shot).
//!
//! When the user enables the title maker in Agent settings, the FIRST message of
//! a NEW chat is sent to a user-configured OpenAI-compatible `/chat/completions`
//! endpoint with a system prompt that asks for a short title and NOTHING else.
//! The returned title replaces the locally-derived one in the session metadata.
//!
//! This is deliberately a small, isolated module — it does not touch the agent
//! runtime or the provider kernel. It speaks only the OpenAI chat-completions
//! shape (the user picks the base URL / key / model), runs non-streaming, and
//! returns a single cleaned title string. Any failure is the caller's cue to
//! keep the derived title (the frontend treats `Err(_)` as "fall back").
//!
//! Reasoning models are handled: we read only `choices[0].message.content`
//! (ignoring any `reasoning_content` sidecar) and additionally strip inline
//! `<think>…</think>` blocks some models emit, so the title is never polluted
//! by chain-of-thought.

const TITLE_SYSTEM_PROMPT: &str = "You write a short, clear title for a conversation based on the user's first message. \
Output ONLY the title — no quotes, no markdown, no labels, no preamble, no trailing punctuation, nothing else. \
Keep it concise (ideally 3 to 6 words) and capture the user's intent.";

/// Generate a thread title from the user's first message via an OpenAI-compatible
/// endpoint. Returns the cleaned title, or `Err` (the caller then keeps the
/// derived title — every error path here is non-fatal by design).
#[tauri::command]
pub async fn generate_thread_title(
    base_url: String,
    api_key: Option<String>,
    model: Option<String>,
    user_message: String,
) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("title maker base URL is not set".to_string());
    }
    let model = model.unwrap_or_default();
    let model = model.trim();
    if model.is_empty() {
        return Err("title maker model is not set".to_string());
    }

    // Cap the seed so a huge first message can't bloat the request.
    let seed: String = user_message.chars().take(4000).collect();
    if seed.trim().is_empty() {
        return Err("empty user message".to_string());
    }

    let url = format!("{base}/chat/completions");
    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": TITLE_SYSTEM_PROMPT },
            { "role": "user", "content": seed }
        ],
        "temperature": 0.3,
        "max_tokens": 80,
        "stream": false
    });

    let client = reqwest::Client::new();
    let mut req = client.post(&url).json(&body);
    if let Some(key) = api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("title request failed: {e}"))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!(
            "title provider returned {code}: {}",
            txt.chars().take(200).collect::<String>()
        ));
    }

    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("title parse failed: {e}"))?;
    let content = v["choices"][0]["message"]["content"].as_str().unwrap_or("");
    let title = clean_title(content);
    if title.is_empty() {
        return Err("title provider returned an empty title".to_string());
    }
    Ok(title)
}

/// Reduce a raw model reply to a bare title: strip `<think>` reasoning blocks,
/// take the first non-empty line, peel surrounding quotes/markdown, drop trailing
/// punctuation, and clamp to a sane length.
fn clean_title(raw: &str) -> String {
    let mut s = raw.to_string();

    // Remove well-formed <think>…</think> spans.
    while let Some(start) = s.find("<think>") {
        match s[start..].find("</think>") {
            Some(end_rel) => {
                let end = start + end_rel + "</think>".len();
                s.replace_range(start..end, "");
            }
            None => break,
        }
    }
    // If reasoning was left open / only a closing tag survives, keep what follows
    // the LAST close marker.
    if let Some(pos) = s.rfind("</think>") {
        s = s[pos + "</think>".len()..].to_string();
    }

    let first = s
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");

    let trimmed = first
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '`' || c == '*' || c == '#')
        .trim();
    let trimmed = trimmed
        .trim_end_matches(|c: char| c == '.' || c == '!' || c == '?' || c == ':')
        .trim();

    let mut out: String = trimmed
        .split_whitespace()
        .take(10)
        .collect::<Vec<_>>()
        .join(" ");
    if out.chars().count() > 70 {
        out = out.chars().take(70).collect::<String>().trim().to_string();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::clean_title;

    #[test]
    fn strips_think_block() {
        assert_eq!(
            clean_title("<think>let me reason about this</think>Fix login bug"),
            "Fix login bug"
        );
    }

    #[test]
    fn keeps_text_after_unclosed_reasoning() {
        assert_eq!(
            clean_title("reasoning…</think>Add dark mode"),
            "Add dark mode"
        );
    }

    #[test]
    fn peels_quotes_and_trailing_punctuation() {
        assert_eq!(clean_title("\"Set up CI pipeline.\""), "Set up CI pipeline");
    }

    #[test]
    fn takes_first_line() {
        assert_eq!(
            clean_title("Refactor auth module\nextra chatter"),
            "Refactor auth module"
        );
    }
}
