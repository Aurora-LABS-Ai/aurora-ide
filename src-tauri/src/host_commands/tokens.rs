//! Token counting for the context meter and the composer. The bodies are
//! [`crate::services::token_commands`], which the window registers directly.
//! Counting is CPU work, so it runs off the async threads here.

use serde_json::Value;

use super::{arg, done, CommandContext, CommandError};
use crate::services::token_commands::{
    self as tokens, CountChatTokensRequest, CountMessagesTokensRequest, CountTokensRequest,
    TruncateTextRequest,
};

pub const COMMANDS: &[&str] = &[
    "count_tokens",
    "count_chat_tokens",
    "count_messages_tokens",
    "detect_model_encoding",
    "estimate_tokens_quick",
    "truncate_to_tokens",
];

/// Run `name` if it is one of these; `None` hands it on.
pub(super) async fn dispatch(
    _ctx: &CommandContext,
    name: &str,
    args: &Value,
) -> Option<Result<Value, CommandError>> {
    let n = name;
    macro_rules! get {
        ($key:literal) => {
            match arg(n, args, $key) {
                Ok(v) => v,
                Err(e) => return Some(Err(e)),
            }
        };
    }
    Some(match name {
        "count_tokens" => {
            let request: CountTokensRequest = get!("request");
            done(blocking(move || tokens::count_tokens(request)).await)
        }
        "count_chat_tokens" => {
            let request: CountChatTokensRequest = get!("request");
            done(blocking(move || tokens::count_chat_tokens(request)).await)
        }
        "count_messages_tokens" => {
            let request: CountMessagesTokensRequest = get!("request");
            done(blocking(move || tokens::count_messages_tokens(request)).await)
        }
        "detect_model_encoding" => done(Ok(tokens::detect_model_encoding(get!("model")))),
        "estimate_tokens_quick" => {
            let text: String = get!("text");
            done(blocking(move || Ok(tokens::estimate_tokens_quick(text))).await)
        }
        "truncate_to_tokens" => {
            let request: TruncateTextRequest = get!("request");
            done(blocking(move || tokens::truncate_to_tokens(request)).await)
        }
        _ => return None,
    })
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("the token count stopped: {e}"))?
}
