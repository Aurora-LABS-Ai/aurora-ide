//! A short-lived memory of what the web just said.
//!
//! Two things make this worth having rather than clever:
//!
//! * **Paging.** A long page is read one window at a time. Without a cache,
//!   every window is a fresh HTTP request, and a page that changes between
//!   windows hands the reader two halves of two different documents.
//! * **Repetition.** An agent that searches, reads three results, and then
//!   re-reads one to quote it would otherwise pay for the same page twice and
//!   put twice the load on the site.
//!
//! Entries expire after [`TTL`]. Short enough that a page edited during a
//! session is picked up on the next look; long enough to cover a turn.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::engines::SearchOptions;
use super::types::{Document, SearchOutcome};

/// How long an answer is reused.
const TTL: Duration = Duration::from_secs(15 * 60);

/// Entries kept before the oldest are dropped. A ceiling on memory, not a
/// tuning knob: each entry is one page of text, so this is a few tens of MB at
/// worst.
const MAX_ENTRIES: usize = 64;

struct Entry<T> {
    value: T,
    stored: Instant,
}

struct Store {
    documents: HashMap<String, Entry<Document>>,
    searches: HashMap<String, Entry<SearchOutcome>>,
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| {
        Mutex::new(Store {
            documents: HashMap::new(),
            searches: HashMap::new(),
        })
    })
}

/// Drop expired entries, then the oldest, until the map is within its ceiling.
fn evict<T>(map: &mut HashMap<String, Entry<T>>) {
    map.retain(|_, e| e.stored.elapsed() < TTL);
    while map.len() > MAX_ENTRIES {
        let Some(oldest) = map
            .iter()
            .min_by_key(|(_, e)| e.stored)
            .map(|(k, _)| k.clone())
        else {
            break;
        };
        map.remove(&oldest);
    }
}

fn search_key(query: &str, opts: &SearchOptions) -> String {
    format!(
        "{}\u{1}{}\u{1}{}\u{1}{:?}\u{1}{:?}",
        query.trim().to_lowercase(),
        opts.limit,
        opts.region.as_deref().unwrap_or(""),
        opts.safe_search,
        // The source is part of the key, not a detail of how the answer was
        // produced: the same words asked of the web and of the catalogues are
        // two different searches, and sharing a key would serve one as the
        // other for the next fifteen minutes.
        opts.source
    )
}

pub fn search_hit(query: &str, opts: &SearchOptions) -> Option<SearchOutcome> {
    let key = search_key(query, opts);
    let guard = store().lock().ok()?;
    let entry = guard.searches.get(&key)?;
    (entry.stored.elapsed() < TTL).then(|| entry.value.clone())
}

pub fn store_search(query: &str, opts: &SearchOptions, outcome: &SearchOutcome) {
    let key = search_key(query, opts);
    let Ok(mut guard) = store().lock() else {
        return;
    };
    guard.searches.insert(
        key,
        Entry {
            value: outcome.clone(),
            stored: Instant::now(),
        },
    );
    evict(&mut guard.searches);
}

/// The cached document holds the **whole** body, before windowing — otherwise
/// asking for a later offset would page through the first window forever.
pub fn document_hit(url: &str) -> Option<Document> {
    let guard = store().lock().ok()?;
    let entry = guard.documents.get(url)?;
    (entry.stored.elapsed() < TTL).then(|| entry.value.clone())
}

pub fn store_document(url: &str, doc: &Document) {
    let Ok(mut guard) = store().lock() else {
        return;
    };
    guard.documents.insert(
        url.to_string(),
        Entry {
            value: doc.clone(),
            stored: Instant::now(),
        },
    );
    evict(&mut guard.documents);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_document_comes_back_whole_so_later_windows_can_be_cut_from_it() {
        let mut doc = Document {
            url: "https://cache.test/whole".into(),
            ..Document::default()
        };
        doc.content = "abcdefghij".repeat(10);
        store_document("https://cache.test/whole", &doc);

        let back = document_hit("https://cache.test/whole").expect("cached");
        assert_eq!(back.content.len(), 100);
    }

    #[test]
    fn an_unseen_url_is_a_miss() {
        assert!(document_hit("https://cache.test/never-stored").is_none());
    }

    /// Options are part of the key: the same words with a different result
    /// limit or region are a different search, and returning the first for the
    /// second would quietly ignore what was asked for.
    #[test]
    fn search_options_are_part_of_the_key() {
        let ten = SearchOptions {
            limit: 10,
            ..SearchOptions::default()
        };
        let three = SearchOptions {
            limit: 3,
            ..SearchOptions::default()
        };
        assert_ne!(search_key("rust", &ten), search_key("rust", &three));

        let german = SearchOptions {
            region: Some("de-de".into()),
            ..SearchOptions::default()
        };
        assert_ne!(search_key("rust", &ten), search_key("rust", &german));
    }

    /// Casing and stray spaces are not a different question.
    #[test]
    fn the_same_query_typed_differently_is_one_key() {
        let opts = SearchOptions::default();
        assert_eq!(
            search_key("  Rust Async ", &opts),
            search_key("rust async", &opts)
        );
    }

    #[test]
    fn the_store_stays_within_its_ceiling() {
        let mut map: HashMap<String, Entry<u8>> = HashMap::new();
        for i in 0..(MAX_ENTRIES + 20) {
            map.insert(
                format!("k{i}"),
                Entry {
                    value: 0,
                    stored: Instant::now(),
                },
            );
        }
        evict(&mut map);
        assert_eq!(map.len(), MAX_ENTRIES);
    }
}
