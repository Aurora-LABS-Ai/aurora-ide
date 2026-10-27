//! One web request as the agent's tool and the window ask for it: search, or
//! read one page. Resolves which action was meant, checks the argument that
//! action needs, and turns a [`super::WebError`] into the caller's string.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuroraWebSearchRequest {
    pub action: Option<String>,
    pub query: Option<String>,
    pub url: Option<String>,
    pub num_results: Option<u32>,
    pub region: Option<String>,
    pub safe_search: Option<String>,
    /// Which catalogue to ask: `web` (the default) or `scholar`.
    pub source: Option<String>,
    /// Characters of page text to return from a fetch.
    pub max_chars: Option<u32>,
    /// Where in the page to start reading, for paging through a long one.
    pub offset: Option<u32>,
}

/// The reply to a web call.
///
/// `results` and `content` are flattened into the top level rather than nested
/// under a wrapper key. The nesting is what let the runtime's compactor mistake
/// a fetch's body for something it could not shrink and throw it away whole;
/// keeping the payload one level down keeps that path honest, and reads better
/// besides.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuroraWebSearchResponse {
    pub success: bool,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Present on a search.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<crate::websearch::SearchOutcome>,
    /// Present on a fetch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document: Option<crate::websearch::Document>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The work behind `commands::aurora_websearch`, with the browser rung as a
/// parameter.
///
/// The agent's tool hands in a real browser; the IPC command passes `None`,
/// because every argument of a `#[tauri::command]` is deserialized from the
/// frontend's payload, so a `&dyn` cannot be a parameter of it.
pub async fn aurora_websearch_with(
    mut request: AuroraWebSearchRequest,
    browser: Option<&dyn crate::websearch::PageSource>,
) -> Result<AuroraWebSearchResponse, String> {
    use crate::websearch::{self, FetchOptions, SafeSearch, SearchOptions, SearchSource};

    for value in [&mut request.action, &mut request.url, &mut request.query, &mut request.source] {
        *value = value.take().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    }
    request.action = request.action.map(|s| s.to_ascii_lowercase());
    request.source = request.source.map(|s| s.to_ascii_lowercase());

    // A caller that names a URL means "read it" even when it forgot to say so.
    let action = request.action.clone().unwrap_or_else(|| {
        if request.url.is_some() {
            "fetch".to_string()
        } else {
            "search".to_string()
        }
    });

    if !matches!(action.as_str(), "search" | "fetch") {
        return Err(format!("unknown web action '{action}'; use 'search' or 'fetch'"));
    }
    if action == "fetch" {
        let url = request
            .url
            .clone()
            .ok_or_else(|| "fetch needs a `url`.".to_string())?;

        let opts = FetchOptions {
            max_chars: request
                .max_chars
                .map(|n| n as usize)
                .unwrap_or(websearch::DEFAULT_MAX_CHARS),
            offset: request.offset.unwrap_or(0) as usize,
        };

        let document = websearch::fetch(&url, &opts)
            .await
            .map_err(|e| e.to_string())?;

        return Ok(AuroraWebSearchResponse {
            success: true,
            action,
            query: None,
            url: Some(url),
            search: None,
            document: Some(document),
            error: None,
        });
    }

    let query = request
        .query
        .clone()
        .ok_or_else(|| "search needs a `query`.".to_string())?;

    if let Some(source) = request.source.as_deref() {
        if !matches!(source, "web" | "scholar" | "papers" | "academic" | "images") {
            return Err(format!("unknown search source '{source}'; use 'web', 'scholar' or 'images'"));
        }
    }
    let opts = SearchOptions {
        limit: request.num_results.unwrap_or(10).clamp(1, 25) as usize,
        region: request.region.clone(),
        safe_search: request
            .safe_search
            .as_deref()
            .map(SafeSearch::parse)
            .unwrap_or_default(),
        source: request
            .source
            .as_deref()
            .map(SearchSource::parse)
            .unwrap_or_default(),
    };

    let outcome = websearch::search(&query, &opts, browser)
        .await
        .map_err(|e| e.to_string())?;

    Ok(AuroraWebSearchResponse {
        success: true,
        action,
        query: Some(query),
        url: None,
        search: Some(outcome),
        document: None,
        error: None,
    })
}
