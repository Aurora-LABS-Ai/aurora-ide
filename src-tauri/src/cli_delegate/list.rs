//! The listing surfaces: `aurora models`, `aurora threads`, `aurora tasks`.
//!
//! All three are the same shape — read something, lay it out, print it — so
//! they share one table style and one rule about what a column is for.
//!
//! ## The table style, and why it has no borders
//!
//! Box-drawing borders were how a terminal separated data from chrome before
//! terminals had colour. They cost two columns of width per rule, they draw
//! the eye to the grid rather than the content, and on a narrow terminal they
//! are the first thing to wrap. A dim header over aligned columns says the
//! same thing with none of that, and is what current tooling — `gh`, `docker`,
//! `cargo` — settled on.
//!
//! ## Columns earn their place
//!
//! Every column here exists to answer a question the user is actually asking.
//! For `aurora models` that question is "these have the same name; which one
//! do I want?", so the columns are the things that *differ* between two models
//! sharing a name — provider, context window, output price — and not the
//! things that do not.

use comfy_table::{presets, Cell, CellAlignment, ContentArrangement, Table};

use super::catalog::{Catalog, CatalogEntry};
use super::term::{glyph, Style, Term};
use super::threads::{display_title, Threads};
use crate::agent_runtime::session_store::SessionSummary;

/// A borderless table with a dim header.
fn table(term: &Term, headers: &[&str]) -> Table {
    let mut table = Table::new();
    table
        // `NOTHING` is comfy-table 8's empty `TableStyle` — no rules, no
        // corners, no outer frame. Alignment alone carries the structure.
        .load_style(presets::NOTHING)
        // Shrink to fit a narrow terminal rather than wrapping into an
        // unreadable block. A truncated column is still scannable; a wrapped
        // table is not.
        .set_content_arrangement(ContentArrangement::Dynamic)
        .set_header(
            headers
                .iter()
                .map(|header| Cell::new(term.paint(Style::Muted, &header.to_uppercase())))
                .collect::<Vec<_>>(),
        );
    table
}

/// Render the model catalogue.
///
/// `query` narrows to one name — the common case, and the whole point: you
/// type `aurora models glm-5.2` precisely because you need to see the
/// providers side by side before choosing one.
pub fn models_table(term: &Term, catalog: &Catalog, entries: &[CatalogEntry]) -> String {
    if entries.is_empty() {
        return term.paint(Style::Muted, "No models match.");
    }

    let mut table = table(term, &["", "provider", "model", "context", "out/1m"]);
    for entry in entries {
        // The selected model is marked rather than merely coloured: colour is
        // unavailable when this is piped, and the mark survives.
        let mark = if entry.selected {
            term.paint(Style::Success, term.g(glyph::POINTER))
        } else {
            " ".to_string()
        };
        let model = if entry.selected {
            term.strong(Style::Text, entry.display_name())
        } else {
            entry.display_name().to_string()
        };
        table.add_row(vec![
            Cell::new(mark),
            // The provider's NAME, not its id: a user-added provider's id is a
            // UUID, and a column of those tells the reader nothing and cannot
            // be typed back into `--provider`.
            Cell::new(term.paint(Style::Hint, entry.provider_label())),
            Cell::new(model),
            Cell::new(term.paint(Style::Muted, &format_context(entry.context_window)))
                .set_alignment(CellAlignment::Right),
            Cell::new(term.paint(Style::Muted, &format_price(entry.price_output_per_mtok)))
                .set_alignment(CellAlignment::Right),
        ]);
    }

    let mut out = table.to_string();
    if let Some(selected) = catalog.selected_entry() {
        out.push_str(&format!(
            "\n{} {} is selected in the Agent Window; tasks use it unless you pass --model.",
            term.paint(Style::Success, term.g(glyph::POINTER)),
            term.paint(Style::Hint, &selected.display_pin())
        ));
    }
    out
}

/// Render the conversation list.
pub fn threads_table(term: &Term, threads: &[SessionSummary], scoped: bool) -> String {
    if threads.is_empty() {
        return term.paint(
            Style::Muted,
            if scoped {
                "No conversations in this project yet."
            } else {
                "No conversations yet."
            },
        );
    }

    let mut table = table(term, &["id", "updated", "msgs", "title"]);
    for summary in threads {
        table.add_row(vec![
            // The short id is what `--thread` wants, so it leads the row and
            // is shown in the length a user would actually retype.
            Cell::new(term.paint(Style::Hint, &short_id(&summary.id))),
            Cell::new(term.paint(Style::Muted, &relative_time(&summary.updated_at))),
            Cell::new(term.paint(Style::Muted, &summary.message_count.to_string()))
                .set_alignment(CellAlignment::Right),
            Cell::new(display_title(summary)),
        ]);
    }
    table.to_string()
}

/// The leading characters of a thread id — enough to identify it.
///
/// Ids are ULIDs. Eight characters is well past unique within one project's
/// history, and it is short enough to read off the screen and retype, which
/// twenty-six is not. `--thread` accepts any unique prefix, so what is printed
/// is directly usable.
pub fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

/// A context window as a person would say it: `200k`, `1M`.
fn format_context(tokens: Option<i64>) -> String {
    match tokens {
        None => "—".to_string(),
        Some(value) if value >= 1_000_000 => {
            let millions = value as f64 / 1_000_000.0;
            if (millions - millions.round()).abs() < 0.05 {
                format!("{}M", millions.round() as i64)
            } else {
                format!("{millions:.1}M")
            }
        }
        Some(value) if value >= 1_000 => format!("{}k", value / 1_000),
        Some(value) => value.to_string(),
    }
}

/// A price per million output tokens, or an em dash when unpriced.
///
/// An em dash rather than `0.00`: a model with no pricing configured is
/// *unknown*, and printing a zero would read as free.
fn format_price(usd: Option<f64>) -> String {
    match usd {
        Some(price) if price > 0.0 => format!("${price:.2}"),
        _ => "—".to_string(),
    }
}

/// A timestamp as elapsed time: `4m`, `2h`, `3d`.
///
/// Relative because the question a conversation list answers is "which one was
/// I just in", and that is a comparison between rows, not a lookup of a date.
/// Falls back to the raw value if it cannot be parsed, rather than printing
/// nothing — an odd-looking cell is still information.
fn relative_time(rfc3339: &str) -> String {
    let Ok(then) = chrono::DateTime::parse_from_rfc3339(rfc3339) else {
        return rfc3339.chars().take(10).collect();
    };
    let elapsed = chrono::Utc::now().signed_duration_since(then.with_timezone(&chrono::Utc));

    let minutes = elapsed.num_minutes();
    if minutes < 1 {
        return "just now".to_string();
    }
    if minutes < 60 {
        return format!("{minutes}m ago");
    }
    let hours = elapsed.num_hours();
    if hours < 24 {
        return format!("{hours}h ago");
    }
    let days = elapsed.num_days();
    if days < 30 {
        return format!("{days}d ago");
    }
    // Past a month, elapsed time stops being meaningful and a date is what a
    // person actually wants.
    then.format("%Y-%m-%d").to_string()
}

/// Load the conversation list a `threads` invocation asked for.
pub fn load_threads(
    workspace: Option<&str>,
    limit: usize,
) -> Result<Vec<SessionSummary>, super::threads::ThreadError> {
    let threads = Threads::load(workspace)?;
    Ok(threads.all.into_iter().take(limit).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(provider: &str, model: &str, context: Option<i64>) -> CatalogEntry {
        CatalogEntry {
            provider_id: provider.to_string(),
            provider_name: provider.to_string(),
            model_key: model.to_string(),
            label: None,
            context_window: context,
            max_output_tokens: Some(8_192),
            supports_vision: false,
            supports_thinking: false,
            price_output_per_mtok: None,
            selected: false,
        }
    }

    fn summary(id: &str, updated_at: &str) -> SessionSummary {
        SessionSummary {
            id: id.to_string(),
            title: "a conversation".to_string(),
            message_count: 4,
            preview: String::new(),
            workspace_root: Some(r"E:\project".to_string()),
            model: None,
            pinned: false,
            archived_at: None,
            deep_research: false,
            created_at: updated_at.to_string(),
            updated_at: updated_at.to_string(),
        }
    }

    #[test]
    fn the_models_table_shows_every_provider_for_one_name() {
        // The situation the command exists for.
        let entries = vec![
            entry("fireworks", "glm-5.2", Some(200_000)),
            entry("openstarry", "glm-5.2", Some(128_000)),
            entry("x5m5x", "glm-5.2", Some(128_000)),
        ];
        let catalog = Catalog {
            entries: entries.clone(),
            selected: None,
        };
        let rendered = models_table(&Term::plain(), &catalog, &entries);

        for provider in ["fireworks", "openstarry", "x5m5x"] {
            assert!(rendered.contains(provider), "missing {provider}");
        }
        // And the column that tells them apart.
        assert!(rendered.contains("200k"));
        assert!(rendered.contains("128k"));
    }

    #[test]
    fn the_selected_model_is_marked_without_relying_on_colour() {
        // Piped output has no colour; the mark has to carry the meaning.
        let entries = vec![
            entry("fireworks", "glm-5.2", Some(200_000)),
            CatalogEntry {
                selected: true,
                ..entry("fireworks", "kimi-k3", Some(256_000))
            },
        ];
        let catalog = Catalog {
            entries: entries.clone(),
            selected: Some("fireworks:kimi-k3".to_string()),
        };
        let plain = Term::plain();
        let rendered = models_table(&plain, &catalog, &entries);
        assert!(rendered.contains(plain.g(glyph::POINTER)));
        assert!(rendered.contains("fireworks:kimi-k3 is selected"));
    }

    #[test]
    fn an_empty_result_says_so_rather_than_printing_a_bare_header() {
        let catalog = Catalog::default();
        let rendered = models_table(&Term::plain(), &catalog, &[]);
        assert!(rendered.contains("No models match"));
    }

    #[test]
    fn context_windows_read_naturally() {
        assert_eq!(format_context(None), "—");
        assert_eq!(format_context(Some(900)), "900");
        assert_eq!(format_context(Some(128_000)), "128k");
        assert_eq!(format_context(Some(200_000)), "200k");
        assert_eq!(format_context(Some(1_000_000)), "1M");
        assert_eq!(format_context(Some(1_500_000)), "1.5M");
    }

    #[test]
    fn an_unpriced_model_is_unknown_not_free() {
        assert_eq!(format_price(None), "—");
        assert_eq!(format_price(Some(0.0)), "—");
        assert_eq!(format_price(Some(2.2)), "$2.20");
    }

    #[test]
    fn thread_ids_are_shortened_to_a_retypable_length() {
        assert_eq!(short_id("01JQ8FAAAABBBBCCCCDDDDEEEE"), "01JQ8FAA");
        // A short id is left alone rather than padded.
        assert_eq!(short_id("abc"), "abc");
    }

    #[test]
    fn the_threads_table_lists_conversations() {
        let now = chrono::Utc::now().to_rfc3339();
        let rendered = threads_table(&Term::plain(), &[summary("01JQ8FAAAA", &now)], true);
        assert!(rendered.contains("01JQ8FAA"));
        assert!(rendered.contains("a conversation"));
    }

    #[test]
    fn an_empty_thread_list_names_the_scope() {
        let plain = Term::plain();
        assert!(threads_table(&plain, &[], true).contains("in this project"));
        assert!(!threads_table(&plain, &[], false).contains("in this project"));
    }

    #[test]
    fn relative_times_read_as_elapsed() {
        let now = chrono::Utc::now();
        let ago = |minutes: i64| {
            relative_time(&(now - chrono::Duration::minutes(minutes)).to_rfc3339())
        };
        assert_eq!(ago(0), "just now");
        assert_eq!(ago(5), "5m ago");
        assert_eq!(ago(120), "2h ago");
        assert_eq!(ago(60 * 24 * 3), "3d ago");
    }

    #[test]
    fn an_old_timestamp_becomes_a_date() {
        let long_ago = (chrono::Utc::now() - chrono::Duration::days(200)).to_rfc3339();
        let rendered = relative_time(&long_ago);
        assert!(rendered.contains('-'), "expected a date, got {rendered}");
        assert!(!rendered.contains("ago"));
    }

    #[test]
    fn an_unparseable_timestamp_still_prints_something() {
        // Better an odd cell than a blank one.
        assert_eq!(relative_time("not a timestamp"), "not a time");
    }
}
