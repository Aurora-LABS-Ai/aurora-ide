//! Scholarly back ends — the free, keyless ones, asked only when the caller
//! says so.
//!
//! Four catalogues: [arXiv](https://arxiv.org) (preprints, physics through
//! computer science), [OpenAlex](https://openalex.org) (an open index of
//! scholarly work of every kind), [Semantic
//! Scholar](https://semanticscholar.org) (strong on computer science, with
//! abstracts) and [PubMed Central](https://www.ncbi.nlm.nih.gov/pmc/)
//! (biomedical full text). None needs an account, a key or a card.
//!
//! ## Why these are not rungs on the web ladder
//!
//! [`super::engines::search`] falls through its back ends until one answers,
//! which works because every rung there is answering the SAME question. These
//! are not. "how do I configure nginx" has no answer in arXiv, and a ladder
//! that reached these when DuckDuckGo was blocked would hand back four papers
//! about queueing theory and call it a result — worse than the failure it
//! replaced, because the model cannot tell a bad answer from a good one here.
//!
//! So they are a **source the caller chooses**: `source: "scholar"` on
//! `auroro_websearch`. Explicit, and never a surprise.
//!
//! ## Why all four at once, rather than a ladder
//!
//! They index different corpora, not the same corpus with different uptime. A
//! machine-learning question is answered by arXiv and Semantic Scholar; a
//! clinical one by PubMed; OpenAlex overlaps both and reaches the journals
//! neither indexes. Asking one and stopping would mean the answer depends on
//! which catalogue happened to be first in the list. So all four are asked
//! together and the lists are interleaved, which puts each catalogue's best
//! result above every catalogue's second-best.
//!
//! A catalogue that fails is reported in `fallbacks` and the rest still
//! answer. Only all four failing is an error.
//!
//! ## No contact details are ever sent
//!
//! OpenAlex offers a "polite pool" keyed on a `mailto`, and NCBI asks callers
//! to identify themselves. Aurora sends `tool=aurora` to NCBI and nothing at
//! all to OpenAlex: the only address on this machine is the user's own, and
//! putting it on an outbound query to identify Aurora would be spending their
//! identity on our convenience. The unauthenticated rate limits are generous
//! enough for one person's searches.

use serde_json::Value;

use super::types::{EngineAttempt, SearchHit, SearchOutcome};
use super::{http, SearchOptions, WebError};

/// The name reported as the answering engine. One name for all four, because
/// what comes back is the merge and no single catalogue produced it — the
/// per-result source is visible in `displayUrl`.
pub const ENGINE_SCHOLAR: &str = "scholar";

const ENGINE_ARXIV: &str = "arxiv";
const ENGINE_OPENALEX: &str = "openalex";
const ENGINE_SEMANTIC_SCHOLAR: &str = "semantic-scholar";
const ENGINE_PUBMED: &str = "pubmed-central";

/// Longest abstract kept on a result.
///
/// A result is a lead, not the document: `action="fetch"` on the URL reads the
/// whole thing. Ten uncut abstracts are ~20,000 characters, which is a tool
/// result the runtime has to compact — and its last resort is to drop the body
/// and keep the envelope, so an uncapped snippet is how a search comes back
/// holding nothing at all.
const MAX_SNIPPET_CHARS: usize = 420;

/// Ask every catalogue and merge what comes back.
pub async fn search(query: &str, opts: &SearchOptions) -> Result<SearchOutcome, WebError> {
    let query = query.trim();
    if query.is_empty() {
        return Err(WebError::EmptyQuery);
    }
    // Each catalogue is asked for the full limit rather than a share of it.
    // A share assumes they all answer; when three fail, a quarter-sized ask
    // from the fourth would cap the result at a quarter of what was wanted.
    let want = opts.limit.clamp(1, 25);

    // Concurrent: four sequential round trips to four different continents is
    // most of a slow search. `try_join!` would abandon the rest on the first
    // failure, which is exactly wrong here — a catalogue being down is the
    // normal case these four exist to survive.
    let (arxiv, openalex, semantic, pubmed) = tokio::join!(
        arxiv(query, want),
        openalex(query, want),
        semantic_scholar(query, want),
        pubmed_central(query, want),
    );

    let mut lists: Vec<(&'static str, Vec<SearchHit>)> = Vec::new();
    let mut fallbacks: Vec<EngineAttempt> = Vec::new();
    for (engine, attempt) in [
        (ENGINE_ARXIV, arxiv),
        (ENGINE_OPENALEX, openalex),
        (ENGINE_SEMANTIC_SCHOLAR, semantic),
        (ENGINE_PUBMED, pubmed),
    ] {
        match attempt {
            Ok(hits) if !hits.is_empty() => lists.push((engine, hits)),
            Ok(_) => fallbacks.push(EngineAttempt {
                engine,
                reason: "answered with no matching work".to_string(),
            }),
            Err(e) => fallbacks.push(EngineAttempt {
                engine,
                reason: e.to_string(),
            }),
        }
    }

    if lists.is_empty() {
        return Err(WebError::NoEngineAnswered {
            query: query.to_string(),
            attempts: fallbacks,
        });
    }

    let results = interleave(lists, want);
    Ok(SearchOutcome {
        query: query.to_string(),
        engine: ENGINE_SCHOLAR,
        count: results.len(),
        results,
        fallbacks,
    })
}

/// Take one from each catalogue in turn until the limit is reached.
///
/// Round-robin rather than concatenation: concatenating puts every one of
/// arXiv's ten above OpenAlex's best, which makes the order of the source list
/// the ranking. Taking turns means a result is only beaten by another
/// catalogue's result of the same rank.
///
/// The same paper is routinely in three of these catalogues, so duplicates are
/// dropped on the way out — first by where it points, then by its title, since
/// the same work has a different URL in each catalogue and only the title is
/// shared.
fn interleave(lists: Vec<(&'static str, Vec<SearchHit>)>, limit: usize) -> Vec<SearchHit> {
    let mut seen_url: Vec<String> = Vec::new();
    let mut seen_title: Vec<String> = Vec::new();
    let mut out: Vec<SearchHit> = Vec::new();

    let deepest = lists.iter().map(|(_, l)| l.len()).max().unwrap_or(0);
    for round in 0..deepest {
        for (_, list) in &lists {
            if out.len() >= limit {
                return renumber(out);
            }
            let Some(hit) = list.get(round) else { continue };
            let url_key = url_key(&hit.url);
            let title_key = title_key(&hit.title);
            if seen_url.contains(&url_key) || (!title_key.is_empty() && seen_title.contains(&title_key))
            {
                continue;
            }
            seen_url.push(url_key);
            if !title_key.is_empty() {
                seen_title.push(title_key);
            }
            out.push(hit.clone());
        }
    }
    renumber(out)
}

/// Rank is the position in the list handed over, so it has to be assigned
/// after the merge — the catalogue's own rank means nothing once four lists
/// are one.
fn renumber(mut hits: Vec<SearchHit>) -> Vec<SearchHit> {
    for (i, hit) in hits.iter_mut().enumerate() {
        hit.rank = i + 1;
    }
    hits
}

/// A URL reduced to the part that identifies the thing it points at.
///
/// `https://doi.org/10.1/x`, `http://doi.org/10.1/x` and `doi.org/10.1/x/` are
/// one work in three catalogues' spelling.
fn url_key(url: &str) -> String {
    let lower = url.trim().to_ascii_lowercase();
    let without_scheme = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .unwrap_or(&lower);
    without_scheme
        .strip_prefix("www.")
        .unwrap_or(without_scheme)
        .trim_end_matches('/')
        .to_string()
}

/// A title reduced to its letters and digits, so punctuation and casing
/// cannot make one paper look like two.
fn title_key(title: &str) -> String {
    title
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Cut an abstract to a lead, on a word boundary.
fn snippet(raw: &str) -> Option<String> {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    if collapsed.chars().count() <= MAX_SNIPPET_CHARS {
        return Some(collapsed);
    }
    let head: String = collapsed.chars().take(MAX_SNIPPET_CHARS).collect();
    let cut = head.rfind(' ').unwrap_or(head.len());
    Some(format!("{}…", head[..cut].trim_end()))
}

/// Percent-encode for a query string. Local rather than shared with
/// [`super::engines`]: that one encodes a space as `+` for form submission,
/// and these are REST APIs where `+` is a literal plus in a search term.
fn encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// Read a JSON body, naming the endpoint when it is not JSON at all.
///
/// A rate-limited API answers with an HTML holding page often enough that
/// "expected value at line 1" has to say which of the four said it.
fn json_body(engine: &str, url: &str, body: &str) -> Result<Value, WebError> {
    serde_json::from_str(body).map_err(|e| WebError::Transport {
        url: url.to_string(),
        detail: format!("{engine} did not answer with JSON: {e}"),
    })
}

// ── arXiv ────────────────────────────────────────────────────────────────

const ARXIV_URL: &str = "https://export.arxiv.org/api/query";

/// arXiv's Atom feed.
///
/// The `id` is used as the destination, not the PDF link the API also offers:
/// `id` is the abstract page, which is HTML and so can be read by
/// `action="fetch"`. A PDF comes back from that same fetch as `unsupported`,
/// which would make every arXiv result a dead end one step later.
async fn arxiv(query: &str, limit: usize) -> Result<Vec<SearchHit>, WebError> {
    let url = format!(
        "{ARXIV_URL}?search_query=all:{}&start=0&max_results={limit}&sortBy=relevance",
        encode(query)
    );
    let response = http::get(&url).await?;
    Ok(parse_arxiv_atom(&response.text(), limit))
}

/// Put a piece of text onto whichever field is open.
fn append(id: &mut String, title: &mut String, summary: &mut String, field: Option<&str>, text: &str) {
    match field {
        Some("id") => id.push_str(text),
        Some("title") => title.push_str(text),
        Some("summary") => summary.push_str(text),
        _ => {}
    }
}

/// Turn an entity reference's name into the character it stands for.
///
/// The five XML predefined names come from quick-xml; the numeric forms are
/// resolved here because arXiv abstracts are full of them (`&#x2212;` for a
/// minus sign in a formula, `&#8212;` for an em dash).
fn resolve_entity(name: &str) -> Option<String> {
    if let Some(predefined) = quick_xml::escape::resolve_predefined_entity(name) {
        return Some(predefined.to_string());
    }
    let digits = name.strip_prefix('#')?;
    let code = match digits.strip_prefix(['x', 'X']) {
        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
        None => digits.parse::<u32>().ok()?,
    };
    char::from_u32(code).map(String::from)
}

/// Read an Atom feed into results.
///
/// Text is accumulated **verbatim and unseparated**, then collapsed once at the
/// end. Both halves of that matter, and they pull against each other:
///
/// * arXiv wraps a long title across lines with the feed's own indentation, so
///   the raw text carries newlines and runs of spaces that have to go.
/// * An entity splits its field into several events — `Cats &amp; Dogs` is
///   `"Cats "`, a reference, `" Dogs"` — so anything joined with a separator
///   gains a space that was never in the title.
///
/// Trimming each event and joining with a space fixes the first and breaks the
/// second. Keeping every event exactly as it came and collapsing the
/// whitespace at the end fixes both, because the wrap already IS whitespace.
fn parse_arxiv_atom(xml: &str, limit: usize) -> Vec<SearchHit> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);

    let mut hits: Vec<SearchHit> = Vec::new();
    // Only inside an `<entry>`: the feed itself opens with a `<title>` holding
    // the query that was asked, and a depth-blind reader files that as the
    // first paper.
    let mut in_entry = false;
    let mut field: Option<String> = None;
    let (mut id, mut title, mut summary) = (String::new(), String::new(), String::new());

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == "entry" {
                    in_entry = true;
                    id.clear();
                    title.clear();
                    summary.clear();
                } else if in_entry {
                    field = Some(name);
                }
            }
            Ok(Event::Text(t)) => {
                if !in_entry {
                    continue;
                }
                let text = t.xml_content().unwrap_or_default();
                append(&mut id, &mut title, &mut summary, field.as_deref(), &text);
            }
            // `&amp;` and `&#x27;` arrive as their own event in quick-xml, not
            // as part of the surrounding text. Ignoring them drops the
            // character silently — a title reads "Cats Dogs" and nothing looks
            // wrong enough to notice.
            Ok(Event::GeneralRef(r)) => {
                if !in_entry {
                    continue;
                }
                let name = r.decode().unwrap_or_default();
                let Some(resolved) = resolve_entity(&name) else {
                    continue;
                };
                append(
                    &mut id,
                    &mut title,
                    &mut summary,
                    field.as_deref(),
                    &resolved,
                );
            }
            Ok(Event::End(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == "entry" {
                    in_entry = false;
                    field = None;
                    let url = id.split_whitespace().collect::<String>();
                    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
                    if url.starts_with("http") && !title.is_empty() {
                        hits.push(SearchHit {
                            rank: hits.len() + 1,
                            title,
                            url,
                            display_url: Some("arxiv.org".to_string()),
                            snippet: snippet(&summary),
                        });
                        if hits.len() >= limit {
                            break;
                        }
                    }
                } else if in_entry {
                    field = None;
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    hits
}

// ── OpenAlex ─────────────────────────────────────────────────────────────

const OPENALEX_URL: &str = "https://api.openalex.org/works";

/// OpenAlex.
///
/// No `sort` is sent. A search without one is already ranked by relevance, and
/// OpenAlex rejects `sort=relevance_score:desc` on a request that has no
/// search term — sending it unconditionally is one refactor away from a 400 on
/// every call.
async fn openalex(query: &str, limit: usize) -> Result<Vec<SearchHit>, WebError> {
    let url = format!(
        "{OPENALEX_URL}?search={}&per_page={}",
        encode(query),
        limit.min(25)
    );
    let response = http::get(&url).await?;
    let body = json_body(ENGINE_OPENALEX, &url, &response.text())?;

    let mut hits = Vec::new();
    for work in body["results"].as_array().unwrap_or(&Vec::new()) {
        let title = work["display_name"]
            .as_str()
            .or_else(|| work["title"].as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        if title.is_empty() {
            continue;
        }
        // A DOI outlives every landing page, so it is preferred as the
        // destination — and it is what makes the same work dedupe against the
        // other catalogues, which quote DOIs too.
        let url = work["doi"]
            .as_str()
            .filter(|d| d.starts_with("http"))
            .or_else(|| work["primary_location"]["landing_page_url"].as_str())
            .or_else(|| work["id"].as_str())
            .unwrap_or_default()
            .to_string();
        if !url.starts_with("http") {
            continue;
        }
        let venue = work["primary_location"]["source"]["display_name"]
            .as_str()
            .unwrap_or_default();
        let year = work["publication_year"].as_u64();
        hits.push(SearchHit {
            rank: hits.len() + 1,
            title,
            url,
            display_url: Some(match (venue.is_empty(), year) {
                (false, Some(y)) => format!("{venue}, {y}"),
                (false, None) => venue.to_string(),
                (true, Some(y)) => format!("openalex.org, {y}"),
                (true, None) => "openalex.org".to_string(),
            }),
            snippet: inverted_abstract(&work["abstract_inverted_index"]).and_then(|a| snippet(&a)),
        });
        if hits.len() >= limit {
            break;
        }
    }
    Ok(hits)
}

/// Rebuild an abstract from OpenAlex's inverted index.
///
/// It is stored as `{word: [positions]}` — a search index, not prose — because
/// the publishers' licences allow indexing an abstract and not republishing
/// it. Putting the words back in order is the documented way to read one, and
/// without it every OpenAlex result arrives with no summary at all.
fn inverted_abstract(value: &Value) -> Option<String> {
    let map = value.as_object()?;
    let mut placed: Vec<(u64, &str)> = Vec::new();
    for (word, positions) in map {
        for position in positions.as_array()? {
            if let Some(at) = position.as_u64() {
                placed.push((at, word.as_str()));
            }
        }
    }
    if placed.is_empty() {
        return None;
    }
    placed.sort_by_key(|(at, _)| *at);
    Some(
        placed
            .into_iter()
            .map(|(_, word)| word)
            .collect::<Vec<_>>()
            .join(" "),
    )
}

// ── Semantic Scholar ─────────────────────────────────────────────────────

const SEMANTIC_SCHOLAR_URL: &str = "https://api.semanticscholar.org/graph/v1/paper/search";

/// Semantic Scholar.
///
/// Every paper is kept, not only the open-access ones. A paper behind a
/// paywall is still the citation a reader needs, and dropping it leaves the
/// list looking like the field has less work in it than it does — the abstract
/// comes back either way.
///
/// Unauthenticated callers share one throttled pool, so a 429 is the common
/// case rather than an edge one — measured 2026-09-05, it declined the first
/// call of the day while the other three answered. That is survivable by
/// design: the merge reports it in `fallbacks` and returns the rest, so this
/// catalogue is a bonus when it answers and never a broken search when it does
/// not.
async fn semantic_scholar(query: &str, limit: usize) -> Result<Vec<SearchHit>, WebError> {
    let url = format!(
        "{SEMANTIC_SCHOLAR_URL}?query={}&limit={}&fields=title,abstract,url,venue,year",
        encode(query),
        limit.min(100)
    );
    let response = http::get(&url).await?;
    let body = json_body(ENGINE_SEMANTIC_SCHOLAR, &url, &response.text())?;

    let mut hits = Vec::new();
    for paper in body["data"].as_array().unwrap_or(&Vec::new()) {
        let title = paper["title"].as_str().unwrap_or_default().trim().to_string();
        let url = paper["url"].as_str().unwrap_or_default().to_string();
        if title.is_empty() || !url.starts_with("http") {
            continue;
        }
        let venue = paper["venue"].as_str().unwrap_or_default();
        let year = paper["year"].as_u64();
        hits.push(SearchHit {
            rank: hits.len() + 1,
            title,
            url,
            display_url: Some(match (venue.is_empty(), year) {
                (false, Some(y)) => format!("{venue}, {y}"),
                (false, None) => venue.to_string(),
                (true, Some(y)) => format!("semanticscholar.org, {y}"),
                (true, None) => "semanticscholar.org".to_string(),
            }),
            snippet: paper["abstract"].as_str().and_then(snippet),
        });
        if hits.len() >= limit {
            break;
        }
    }
    Ok(hits)
}

// ── PubMed Central ───────────────────────────────────────────────────────

const NCBI_SEARCH: &str = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const NCBI_SUMMARY: &str = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";

/// PubMed Central, in the two calls its API requires: ids, then summaries.
///
/// `esummary` rather than `efetch`: summaries come back as JSON and carry the
/// title, journal and date, which is everything a result row shows. `efetch`
/// returns the full article as its own XML schema — a second parser to
/// maintain for a body the reader can get from the article page instead.
async fn pubmed_central(query: &str, limit: usize) -> Result<Vec<SearchHit>, WebError> {
    let search_url = format!(
        "{NCBI_SEARCH}?db=pmc&term={}&retmax={limit}&retmode=json&sort=relevance&tool=aurora",
        encode(query)
    );
    let response = http::get(&search_url).await?;
    let body = json_body(ENGINE_PUBMED, &search_url, &response.text())?;

    let ids: Vec<String> = body["esearchresult"]["idlist"]
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .filter_map(|v| v.as_str())
        .take(limit)
        .map(str::to_string)
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let summary_url = format!(
        "{NCBI_SUMMARY}?db=pmc&id={}&retmode=json&tool=aurora",
        ids.join(",")
    );
    let response = http::get(&summary_url).await?;
    let body = json_body(ENGINE_PUBMED, &summary_url, &response.text())?;
    let result = &body["result"];

    let mut hits = Vec::new();
    // Walked in the id order the search returned, not in the object's key
    // order: `result` is a map keyed by id plus a `uids` list, and a map has
    // no ranking in it. Iterating the object would return relevance-ranked
    // results in an arbitrary order.
    for id in &ids {
        let entry = &result[id];
        let title = entry["title"].as_str().unwrap_or_default().trim().to_string();
        if title.is_empty() {
            continue;
        }
        let journal = entry["fulljournalname"]
            .as_str()
            .or_else(|| entry["source"].as_str())
            .unwrap_or_default();
        let date = entry["sortdate"]
            .as_str()
            .or_else(|| entry["pubdate"].as_str())
            .unwrap_or_default();
        hits.push(SearchHit {
            rank: hits.len() + 1,
            // The title arrives as a fragment of HTML — PMC marks up italics
            // in species names and superscripts in formulae — so the tags come
            // out rather than reaching the reader as literal `<i>`.
            title: strip_tags(&title),
            url: format!("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC{id}/"),
            display_url: Some(match (journal.is_empty(), date.is_empty()) {
                (false, false) => format!("{journal}, {}", &date[..date.len().min(10)]),
                (false, true) => journal.to_string(),
                _ => "ncbi.nlm.nih.gov".to_string(),
            }),
            // PMC's summary carries no abstract. Left absent rather than
            // filled with the journal name again: an empty field says "this
            // catalogue did not summarise it", and a padded one says nothing
            // while looking like it did.
            snippet: None,
        });
    }
    Ok(hits)
}

/// Drop the markup out of a field that arrives as an HTML fragment.
fn strip_tags(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut inside = false;
    for c in raw.chars() {
        match c {
            '<' => inside = true,
            '>' => inside = false,
            _ if !inside => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(title: &str, url: &str) -> SearchHit {
        SearchHit {
            rank: 1,
            title: title.into(),
            url: url.into(),
            display_url: None,
            snippet: None,
        }
    }

    /// The feed's own `<title>` holds the query that was asked. A reader that
    /// does not track depth files it as the first paper.
    #[test]
    fn the_feeds_own_title_is_not_read_as_a_paper() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query: search_query=all:attention</title>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v5</id>
    <title>Attention Is All You Need</title>
    <summary>The dominant sequence transduction models are based on
    complex recurrent networks.</summary>
  </entry>
</feed>"#;
        let hits = parse_arxiv_atom(xml, 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Attention Is All You Need");
        assert_eq!(hits[0].url, "http://arxiv.org/abs/1706.03762v5");
        assert!(hits[0].snippet.as_deref().unwrap().starts_with("The dominant"));
    }

    /// An entity splits the text into two events. Assigning rather than
    /// appending keeps only what followed the last `&amp;`.
    #[test]
    fn an_escaped_character_does_not_truncate_a_title() {
        let xml = r#"<feed><entry>
            <id>http://arxiv.org/abs/1</id>
            <title>Cats &amp; Dogs</title>
            <summary>a &lt; b</summary>
        </entry></feed>"#;
        let hits = parse_arxiv_atom(xml, 10);
        assert_eq!(hits[0].title, "Cats & Dogs");
        assert_eq!(hits[0].snippet.as_deref(), Some("a < b"));
    }

    #[test]
    fn an_entry_with_no_usable_id_is_dropped_rather_than_linked_nowhere() {
        let xml = r#"<feed><entry><title>No link</title></entry>
                     <entry><id>https://arxiv.org/abs/2</id><title>Fine</title></entry></feed>"#;
        let hits = parse_arxiv_atom(xml, 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Fine");
        assert_eq!(hits[0].rank, 1);
    }

    #[test]
    fn an_openalex_abstract_is_rebuilt_in_word_order() {
        let index = serde_json::json!({
            "Attention": [0],
            "is": [1, 4],
            "all": [2],
            "you": [3],
            "need": [5],
        });
        assert_eq!(
            inverted_abstract(&index).as_deref(),
            Some("Attention is all you is need")
        );
        assert_eq!(inverted_abstract(&serde_json::json!(null)), None);
        assert_eq!(inverted_abstract(&serde_json::json!({})), None);
    }

    /// Concatenation would put every arXiv result above OpenAlex's best.
    #[test]
    fn the_catalogues_take_turns_rather_than_queueing() {
        let merged = interleave(
            vec![
                (
                    "arxiv",
                    vec![hit("A one", "https://a.example/1"), hit("A two", "https://a.example/2")],
                ),
                (
                    "openalex",
                    vec![hit("B one", "https://b.example/1"), hit("B two", "https://b.example/2")],
                ),
            ],
            10,
        );
        let titles: Vec<&str> = merged.iter().map(|h| h.title.as_str()).collect();
        assert_eq!(titles, ["A one", "B one", "A two", "B two"]);
        assert_eq!(merged[2].rank, 3);
    }

    /// The same paper is in three of these catalogues, with a different URL in
    /// each and the same title in all of them — down to the punctuation and
    /// casing each one applied to it.
    #[test]
    fn one_paper_found_by_three_catalogues_is_listed_once() {
        let merged = interleave(
            vec![
                ("arxiv", vec![hit("Attention Is All You Need", "https://arxiv.org/abs/1706.03762")]),
                ("openalex", vec![hit("Attention is all you need!", "https://doi.org/10.5555/x")]),
                (
                    "semantic-scholar",
                    vec![hit("Attention Is All You Need", "https://semanticscholar.org/p/1")],
                ),
            ],
            10,
        );
        assert_eq!(merged.len(), 1, "{merged:#?}");
        assert_eq!(merged[0].url, "https://arxiv.org/abs/1706.03762");
    }

    /// A wrapped title and an escaped one pull in opposite directions: one
    /// needs the whitespace between events, the other must not gain any.
    #[test]
    fn a_title_wrapped_across_lines_comes_back_as_one_line() {
        let xml = "<feed><entry>\
            <id>https://arxiv.org/abs/3</id>\
            <title>Attention Is\n      All You Need</title>\
        </entry></feed>";
        assert_eq!(parse_arxiv_atom(xml, 5)[0].title, "Attention Is All You Need");
    }

    #[test]
    fn a_numeric_entity_becomes_its_character() {
        assert_eq!(resolve_entity("amp").as_deref(), Some("&"));
        assert_eq!(resolve_entity("#8212").as_deref(), Some("—"));
        assert_eq!(resolve_entity("#x2212").as_deref(), Some("−"));
        assert_eq!(resolve_entity("nbsp"), None);
    }

    #[test]
    fn the_same_url_in_two_spellings_is_one_result() {
        let merged = interleave(
            vec![
                ("arxiv", vec![hit("One", "https://doi.org/10.1/x")]),
                ("openalex", vec![hit("Another title", "http://www.doi.org/10.1/x/")]),
            ],
            10,
        );
        assert_eq!(merged.len(), 1);
    }

    #[test]
    fn a_long_abstract_is_cut_on_a_word() {
        let long = "word ".repeat(200);
        let cut = snippet(&long).unwrap();
        assert!(cut.chars().count() <= MAX_SNIPPET_CHARS + 1, "{}", cut.len());
        assert!(cut.ends_with('…'));
        assert!(!cut.contains("wor…"), "{cut}");
        assert_eq!(snippet("   "), None);
    }

    #[test]
    fn a_marked_up_pmc_title_arrives_as_text() {
        assert_eq!(
            strip_tags("Effects of <i>E. coli</i> on H<sub>2</sub>O"),
            "Effects of E. coli on H2O"
        );
    }

    /// A term with a space, an ampersand or an accent must not be able to add
    /// parameters to the URL it is placed into.
    #[test]
    fn a_query_cannot_smuggle_parameters_into_an_api_url() {
        assert_eq!(encode("a b&per_page=999"), "a%20b%26per_page%3D999");
        assert_eq!(encode("café"), "caf%C3%A9");
    }

    /// Search endpoints answer a rate limit with an HTML holding page, and
    /// "expected value at line 1 column 1" has to say who said it.
    #[test]
    fn a_non_json_answer_names_the_catalogue_that_gave_it() {
        let err = json_body(ENGINE_SEMANTIC_SCHOLAR, "https://x.example", "<html>429</html>")
            .unwrap_err()
            .to_string();
        assert!(err.contains("semantic-scholar"), "{err}");
        assert!(err.contains("https://x.example"), "{err}");
    }

    /// Every one of these is asked over the network, so they are `#[ignore]`d
    /// and run by hand: `cargo test --lib scholar -- --ignored --nocapture`.
    /// They are the only thing that catches a catalogue changing its shape.
    mod live {
        use super::*;

        #[tokio::test]
        #[ignore]
        async fn arxiv_answers_a_real_query() {
            let hits = arxiv("attention is all you need", 5).await.expect("arxiv");
            assert!(!hits.is_empty());
            println!("{:#?}", hits[0]);
        }

        #[tokio::test]
        #[ignore]
        async fn openalex_answers_a_real_query() {
            let hits = openalex("transformer architecture", 5).await.expect("openalex");
            assert!(!hits.is_empty());
            println!("{:#?}", hits[0]);
        }

        /// A 429 is a pass here, and that is not a lowered bar.
        ///
        /// Semantic Scholar's unauthenticated pool is shared by everyone and
        /// throttled hard — measured 2026-09-05, it answered `429 Too Many
        /// Requests` to the first call of the day. Asserting on results would
        /// make this test fail on someone else's traffic, and a test that
        /// fails for reasons the code cannot fix is one people learn to
        /// ignore. What is worth checking is that the request is well formed
        /// and the failure is legible, which the merge then reports instead of
        /// hiding.
        #[tokio::test]
        #[ignore]
        async fn semantic_scholar_answers_or_says_it_is_rate_limited() {
            match semantic_scholar("retrieval augmented generation", 5).await {
                Ok(hits) => {
                    assert!(!hits.is_empty());
                    println!("{:#?}", hits[0]);
                }
                Err(e) => {
                    let message = e.to_string();
                    println!("semantic scholar declined: {message}");
                    assert!(message.contains("429"), "unexpected failure: {message}");
                }
            }
        }

        #[tokio::test]
        #[ignore]
        async fn pubmed_answers_a_real_query() {
            let hits = pubmed_central("crispr off target effects", 5)
                .await
                .expect("pubmed");
            assert!(!hits.is_empty());
            println!("{:#?}", hits[0]);
        }

        #[tokio::test]
        #[ignore]
        async fn the_merge_survives_whatever_is_down_today() {
            let outcome = search("graph neural networks", &SearchOptions::default())
                .await
                .expect("scholar");
            println!("{} results, fallbacks: {:#?}", outcome.count, outcome.fallbacks);
            assert!(outcome.count > 0);
        }
    }
}
