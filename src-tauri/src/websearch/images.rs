//! Wikimedia Commons image search. Source pages and attribution accompany every
//! image; an image URL alone is not evidence of permission to reuse it.
//! API contract: https://www.mediawiki.org/wiki/API:Imageinfo

use std::collections::HashSet;

use dom_query::Document as Dom;
use serde::Deserialize;

use super::types::{SearchHit, SearchImage, SearchOutcome};
use super::{http, SearchOptions, WebError};

const ENDPOINT: &str = "https://commons.wikimedia.org/w/api.php";
const ENGINE: &str = "wikimedia-commons";

#[derive(Deserialize)]
struct Response {
    error: Option<ApiError>,
    query: Option<Query>,
    batchcomplete: Option<bool>,
}

#[derive(Deserialize)]
struct ApiError {
    code: String,
    info: String,
}

#[derive(Deserialize)]
struct Query {
    #[serde(default)]
    pages: Vec<Page>,
}

#[derive(Deserialize)]
struct Page {
    title: String,
    index: Option<usize>,
    #[serde(default)]
    imageinfo: Vec<ImageInfo>,
}

#[derive(Deserialize)]
struct ImageInfo {
    url: Option<String>,
    thumburl: Option<String>,
    descriptionurl: Option<String>,
    #[serde(default)]
    width: u32,
    #[serde(default)]
    height: u32,
    mime: Option<String>,
    #[serde(default)]
    extmetadata: std::collections::HashMap<String, Metadata>,
}

#[derive(Deserialize)]
struct Metadata {
    value: String,
}

pub(super) async fn search(query: &str, opts: &SearchOptions) -> Result<SearchOutcome, WebError> {
    let query = query.trim();
    if query.is_empty() {
        return Err(WebError::EmptyQuery);
    }
    // Keep this modest: extmetadata is an expensive Commons operation.
    let limit = opts.limit.clamp(1, 10);
    let mut url = reqwest::Url::parse(ENDPOINT).map_err(|e| WebError::Setup(e.to_string()))?;
    url.query_pairs_mut().extend_pairs([
        ("action", "query"),
        ("format", "json"),
        ("formatversion", "2"),
        ("generator", "search"),
        ("gsrsearch", &format!("{query} filetype:bitmap")),
        ("gsrnamespace", "6"),
        ("gsrlimit", &limit.to_string()),
        ("prop", "imageinfo"),
        ("iiprop", "url|size|mime|extmetadata"),
        ("iiurlwidth", "320"),
        (
            "iiextmetadatafilter",
            "Artist|LicenseShortName|LicenseUrl|ImageDescription",
        ),
        ("iiextmetadatalanguage", "en"),
    ]);
    let response = http::get_api(url.as_str(), "AuroraIDE/2.0 (research image search)").await?;
    let results = parse(&response.text(), limit).map_err(|detail| WebError::Transport {
        url: ENDPOINT.into(),
        detail,
    })?;
    Ok(SearchOutcome {
        query: query.into(),
        engine: ENGINE,
        count: results.len(),
        results,
        fallbacks: Vec::new(),
    })
}

fn parse(body: &str, limit: usize) -> Result<Vec<SearchHit>, String> {
    let response: Response = serde_json::from_str(body)
        .map_err(|e| format!("Wikimedia Commons returned unreadable search data: {e}"))?;
    if let Some(error) = response.error {
        return Err(format!(
            "Wikimedia Commons: {} ({})",
            error.info, error.code
        ));
    }
    let mut pages = match response.query {
        Some(query) => query.pages,
        None if response.batchcomplete == Some(true) => return Ok(Vec::new()),
        None => return Err("Wikimedia Commons returned no search payload".into()),
    };
    pages.sort_by_key(|page| page.index.unwrap_or(usize::MAX));
    let mut seen = HashSet::new();
    let mut hits = Vec::new();
    for page in pages {
        let Some(info) = page.imageinfo.into_iter().next() else {
            continue;
        };
        if !matches!(
            info.mime.as_deref(),
            Some("image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/tiff")
        ) {
            continue;
        }
        let (Some(url), Some(thumbnail_url), Some(source)) = (
            http_url(info.url.as_deref()),
            http_url(info.thumburl.as_deref()),
            http_url(info.descriptionurl.as_deref()),
        ) else {
            continue;
        };
        if !seen.insert(url.clone()) {
            continue;
        }
        let metadata = |key: &str, max: usize| {
            info.extmetadata
                .get(key)
                .and_then(|v| plain_text(&v.value, max))
        };
        hits.push(SearchHit {
            rank: page.index.unwrap_or(hits.len() + 1),
            title: page
                .title
                .trim_start_matches("File:")
                .chars()
                .take(300)
                .collect(),
            url: source,
            display_url: Some("commons.wikimedia.org".into()),
            snippet: metadata("ImageDescription", 500),
            image: Some(SearchImage {
                url,
                thumbnail_url,
                width: info.width,
                height: info.height,
                creator: metadata("Artist", 300),
                license: metadata("LicenseShortName", 120),
                license_url: info
                    .extmetadata
                    .get("LicenseUrl")
                    .and_then(|v| http_url(Some(&v.value))),
            }),
        });
        if hits.len() >= limit {
            break;
        }
    }
    Ok(hits)
}

fn http_url(value: Option<&str>) -> Option<String> {
    let url = reqwest::Url::parse(value?.trim()).ok()?;
    (matches!(url.scheme(), "https" | "http")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none())
    .then(|| url.to_string())
}

fn plain_text(html: &str, max: usize) -> Option<String> {
    let dom = Dom::from(html);
    dom.select("script, style").remove();
    let text = dom.text().split_whitespace().collect::<Vec<_>>().join(" ");
    (!text.is_empty()).then(|| {
        let mut clipped: String = text.chars().take(max).collect();
        if text.chars().count() > max {
            clipped.push_str("...");
        }
        clipped
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn page(index: usize) -> serde_json::Value {
        json!({"title":"File:Webb.jpg", "index":index, "imageinfo":[{
            "url":format!("https://upload.wikimedia.org/{index}.jpg"),
            "thumburl":"https://thumb.wikimedia.org/webb.jpg",
            "descriptionurl":"https://commons.wikimedia.org/wiki/File:Webb.jpg",
            "mime":"image/jpeg", "width":4256, "height":2832,
            "extmetadata":{
                "Artist":{"value":"<bdi><a href='/author'>Chris Gunn</a></bdi>"},
                "LicenseShortName":{"value":"CC BY 2.0"},
                "LicenseUrl":{"value":"https://creativecommons.org/licenses/by/2.0"},
                "ImageDescription":{"value":"<p>Mirror &amp; telescope</p>"}
            }
        }]})
    }

    #[test]
    fn preserves_rank_source_and_plain_attribution() {
        let body = json!({"batchcomplete":true,"query":{"pages":[page(2),page(1)]}});
        let hits = parse(&body.to_string(), 10).unwrap();
        assert_eq!(hits[0].rank, 1);
        assert!(hits[0].url.contains("/wiki/File:"));
        assert_eq!(hits[0].snippet.as_deref(), Some("Mirror & telescope"));
        let image = hits[0].image.as_ref().unwrap();
        assert_eq!(image.creator.as_deref(), Some("Chris Gunn"));
        assert_eq!(image.license.as_deref(), Some("CC BY 2.0"));
        assert_eq!(image.width, 4256);
    }

    #[test]
    fn rejects_api_errors_and_bad_payloads_but_accepts_empty_searches() {
        assert!(
            parse(r#"{"error":{"code":"ratelimited","info":"Slow down"}}"#, 10)
                .unwrap_err()
                .contains("ratelimited")
        );
        assert!(parse("{}", 10).is_err());
        assert!(parse("<html>blocked</html>", 10).is_err());
        assert!(parse(r#"{"batchcomplete":true}"#, 10).unwrap().is_empty());
    }

    #[test]
    fn skips_missing_unsafe_and_duplicate_images() {
        let mut unsafe_page = page(3);
        unsafe_page["imageinfo"][0]["thumburl"] = json!("javascript:alert(1)");
        let body = json!({"query":{"pages":[
            {"title":"File:Missing.jpg"}, unsafe_page, page(1), page(1), page(2)
        ]}});
        let hits = parse(&body.to_string(), 10).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(parse(&body.to_string(), 1).unwrap().len(), 1);
        assert!(http_url(Some("https://user:password@example.com/a.jpg")).is_none());
    }

    #[tokio::test]
    #[ignore = "live Wikimedia Commons request"]
    async fn live_image_search() {
        let outcome = search("James Webb Space Telescope", &SearchOptions::default())
            .await
            .unwrap();
        assert!(!outcome.results.is_empty());
        assert!(outcome.results.iter().all(|hit| hit.image.is_some()));
        println!("{} images from {}", outcome.count, outcome.engine);
    }
}
