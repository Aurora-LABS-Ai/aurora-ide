//! Turning what someone typed into something FTS5 will accept.
//!
//! FTS5's `MATCH` takes a query LANGUAGE, not a string. Bare words are fine,
//! but `AND`, `OR`, `NOT` and `NEAR` are operators, `"` opens a phrase, `(` `)`
//! group, `*` is a prefix, `:` is a column filter, and `^` anchors. So a
//! perfectly reasonable question typed by a person — `what about C++ vs. Rust?`
//! or `"the tariffs` — is a syntax error, and an unhandled one surfaces to the
//! model as a failed tool call for a query that was never wrong.
//!
//! Rather than teach anyone the query language, every token is quoted as a
//! literal and the tokens are ANDed. That makes the whole grammar inert: no
//! input can be a syntax error, and no input can accidentally invoke an
//! operator it did not mean.

/// Characters FTS5 treats as syntax. Split on them as well as on whitespace,
/// so `C++`, `foo:bar` and `(nested)` become plain words rather than fragments
/// of an expression.
fn is_syntax(ch: char) -> bool {
    matches!(
        ch,
        '"' | '\'' | '(' | ')' | '*' | ':' | '^' | '-' | '+' | ',' | '.' | '?' | '!' | ';' | '/' | '\\' | '|' | '&' | '=' | '<' | '>' | '[' | ']' | '{' | '}' | '~' | '#' | '@' | '%' | '$'
    )
}

/// Build a safe `MATCH` expression, or `None` when there is nothing to search
/// for.
///
/// `None` rather than an empty string on purpose: an empty `MATCH` is an FTS5
/// error, and a caller that gets `None` can return "no results" — which is the
/// truthful answer to a query with no searchable words in it.
#[must_use]
pub fn to_match_expression(query: &str) -> Option<String> {
    let tokens: Vec<String> = query
        .split(|ch: char| ch.is_whitespace() || is_syntax(ch))
        .filter(|token| !token.is_empty())
        // A double quote cannot survive inside a quoted literal. FTS5 escapes
        // it by doubling, same as SQL — but `is_syntax` has already removed
        // them, so this is a belt on top of braces.
        .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
        .collect();

    if tokens.is_empty() {
        return None;
    }
    // ANDed: every word must appear. A person searching two words means both,
    // and OR would rank a chat matching only "the" above one matching neither
    // usefully.
    Some(tokens.join(" AND "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_memory::ChatMemory;

    #[test]
    fn plain_words_are_quoted_and_anded() {
        assert_eq!(
            to_match_expression("tariffs steel").unwrap(),
            "\"tariffs\" AND \"steel\""
        );
    }

    #[test]
    fn nothing_to_search_for_is_none_rather_than_an_error() {
        assert!(to_match_expression("").is_none());
        assert!(to_match_expression("   ").is_none());
        // Punctuation only — every token is stripped, so there is no query.
        assert!(to_match_expression("?!...").is_none());
    }

    /// The whole point. Each of these is a valid English question and an
    /// INVALID FTS5 expression, and each one used to be a failed tool call.
    #[test]
    fn queries_that_are_fts_syntax_errors_are_made_inert() {
        for query in [
            "what about C++ vs. Rust?",
            "\"the tariffs",
            "cost (approximately)",
            "NEAR the border",
            "a AND b OR c",
            "column:value",
            "^anchored",
            "wild*",
            "-minus",
            "50% of the total",
        ] {
            let expr = to_match_expression(query).expect("has words");
            // Every token is a quoted literal, so no operator survives.
            assert!(!expr.contains("NEAR("), "{query}");
            for fragment in ['*', '^', ':', '(', ')'] {
                assert!(!expr.contains(fragment), "{query} left {fragment} in {expr}");
            }
        }
    }

    /// Words that ARE operators must be searched for as words.
    #[test]
    fn operator_words_are_searched_as_words() {
        let expr = to_match_expression("and or not").unwrap();
        assert_eq!(expr, "\"and\" AND \"or\" AND \"not\"");
    }

    /// The tests above prove the shape. This one proves SQLite accepts it,
    /// which is the only thing that actually matters.
    #[test]
    fn every_awkward_query_is_accepted_by_sqlite() {
        let memory = ChatMemory::in_memory().unwrap();
        memory
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO chats (id, title, created_at, updated_at)
                     VALUES ('c1', 't', '2026-09-04', '2026-09-04')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO messages (chat_id, seq, role, text, created_at)
                     VALUES ('c1', 0, 'user', 'tariffs on C++ and steel at 50%', '2026-09-04')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        for query in [
            "what about C++ vs. Rust?",
            "\"the tariffs",
            "cost (approximately)",
            "NEAR the border",
            "a AND b OR c",
            "column:value",
            "^anchored",
            "wild*",
            "50% of the total",
            "émoji 🙂 and ünicode",
        ] {
            let expr = to_match_expression(query).expect("has words");
            memory
                .with_conn(|conn| {
                    // The assertion is that this does not ERROR. What it
                    // matches is beside the point.
                    let _: i64 = conn.query_row(
                        "SELECT count(*) FROM messages_fts WHERE messages_fts MATCH ?1",
                        rusqlite::params![expr],
                        |row| row.get(0),
                    )?;
                    Ok(())
                })
                .unwrap_or_else(|err| panic!("{query} produced {expr}, which SQLite rejected: {err}"));
        }
    }

    #[test]
    fn a_real_search_still_finds_the_thing() {
        let memory = ChatMemory::in_memory().unwrap();
        memory
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO chats (id, title, created_at, updated_at)
                     VALUES ('c1', 't', '2026-09-04', '2026-09-04')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO messages (chat_id, seq, role, text, created_at)
                     VALUES ('c1', 0, 'user', 'tariffs on imported steel', '2026-09-04')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        let expr = to_match_expression("steel tariffs?").unwrap();
        let hits: i64 = memory
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT count(*) FROM messages_fts WHERE messages_fts MATCH ?1",
                    rusqlite::params![expr],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(hits, 1, "both words are present, in either order");
    }
}
