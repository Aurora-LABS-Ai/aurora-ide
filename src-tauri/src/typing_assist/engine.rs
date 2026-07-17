//! The statistical typing-assist engine — a faithful Rust port of TypeAssist's
//! `PredictionEngine` + `CorrectionEngine`, unified on a single trie built from
//! the bundled open-source frequency data.
//!
//!   * inline completion — the trie is walked down the typed prefix and the
//!     subtree's top-frequency words are re-ranked by previous-word bigram
//!     context and the user's personal lexicon;
//!   * autocorrect — a curated map first, then a conservative statistical pass
//!     (banded Damerau-Levenshtein over the same trie) that only touches words
//!     which are NOT already valid;
//!   * next-word — bigram prediction blended with the user's own bigrams.
//!
//! The trie is stored as an arena (`Vec<TrieNode>`) so nodes reference children
//! by index — no `Rc`/`RefCell`, no borrow-checker fights during the walk.

use std::collections::HashMap;
use std::path::Path;

use parking_lot::Mutex;

use super::common_misspellings;
use super::lexicon::Lexicon;

const TOP_WORDS_PER_NODE: usize = 5;
const MAX_COMPLETION_CANDIDATES: usize = 12;

// Scoring weights (log10-frequency is roughly 3..10 for this corpus).
const BIGRAM_WEIGHT: f64 = 1.6;
const PERSONAL_BIGRAM_WEIGHT: f64 = 2.2;
const MIN_SUGGESTION_COUNT: u64 = 1000;
const MAX_NEXT_WORD_PER_KEY: usize = 8;

/// What kind of ghost text a query produced.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum GhostKind {
    /// The suggestion extends the word being typed (insert the remainder).
    Completion,
    /// A fresh word predicted to follow the previous one.
    NextWord,
}

/// A single inline suggestion for the composer to render as ghost text.
pub struct Ghost {
    /// Text to insert at the caret when accepted (remainder for completion, the
    /// whole word for next-word).
    pub insert: String,
    /// The full word (for the lexicon to learn on accept).
    pub word: String,
    pub kind: GhostKind,
}

struct TrieNode {
    children: HashMap<char, usize>,
    /// Index into `words`/`counts` if a word ends here, else `-1`.
    word_id: i32,
    /// Top-frequency word ids in this subtree (precomputed for completion).
    top_words: Vec<u32>,
}

impl TrieNode {
    fn new() -> Self {
        TrieNode {
            children: HashMap::new(),
            word_id: -1,
            top_words: Vec::new(),
        }
    }
}

pub struct Engine {
    words: Vec<String>,
    counts: Vec<u64>,
    nodes: Vec<TrieNode>,
    /// prev word -> most likely following words (corpus), best first.
    next_word: HashMap<String, Vec<String>>,
    /// "w1 w2" -> corpus bigram count (context scoring).
    bigram_counts: HashMap<String, u64>,
    lexicon: Mutex<Lexicon>,
}

/// A word char is a letter or an in-word apostrophe (mirrors `WordTracker`).
fn is_word_char(c: char) -> bool {
    c.is_alphabetic() || c == '\''
}

impl Engine {
    /// Loads and indexes the dictionaries + the personal lexicon. Blocking I/O —
    /// call off the async runtime (e.g. `spawn_blocking`).
    pub fn load(
        freq_path: &Path,
        bigram_path: &Path,
        lexicon_path: std::path::PathBuf,
    ) -> std::io::Result<Engine> {
        let mut engine = Engine {
            words: Vec::with_capacity(90_000),
            counts: Vec::with_capacity(90_000),
            nodes: vec![TrieNode::new()],
            next_word: HashMap::new(),
            bigram_counts: HashMap::new(),
            lexicon: Mutex::new(Lexicon::load(lexicon_path)),
        };
        engine.build_trie(freq_path)?;
        engine.compute_top_words(0);
        engine.build_next_word_index(bigram_path)?;
        Ok(engine)
    }

    // ----- Index construction -----

    fn build_trie(&mut self, path: &Path) -> std::io::Result<()> {
        let text = std::fs::read_to_string(path)?;
        for line in text.lines() {
            let Some(sp) = line.find(' ') else { continue };
            let word = &line[..sp];
            if word.chars().count() < 2 {
                continue;
            }
            let Ok(count) = line[sp + 1..].trim().parse::<u64>() else {
                continue;
            };

            let id = self.words.len() as u32;
            self.words.push(word.to_string());
            self.counts.push(count);

            let mut node = 0usize;
            for c in word.chars() {
                node = match self.nodes[node].children.get(&c) {
                    Some(&child) => child,
                    None => {
                        let child = self.nodes.len();
                        self.nodes.push(TrieNode::new());
                        self.nodes[node].children.insert(c, child);
                        child
                    }
                };
            }
            self.nodes[node].word_id = id as i32;
        }
        Ok(())
    }

    /// Post-order pass storing each subtree's top-frequency words at its root.
    fn compute_top_words(&mut self, idx: usize) -> Vec<u32> {
        let child_idxs: Vec<usize> = self.nodes[idx].children.values().copied().collect();
        let mut merged: Vec<u32> = Vec::with_capacity(TOP_WORDS_PER_NODE * 4);
        let wid = self.nodes[idx].word_id;
        if wid >= 0 {
            merged.push(wid as u32);
        }
        for c in child_idxs {
            merged.extend(self.compute_top_words(c));
        }
        merged.sort_by(|a, b| self.counts[*b as usize].cmp(&self.counts[*a as usize]));
        merged.truncate(TOP_WORDS_PER_NODE);
        self.nodes[idx].top_words = merged.clone();
        merged
    }

    fn build_next_word_index(&mut self, path: &Path) -> std::io::Result<()> {
        let text = std::fs::read_to_string(path)?;
        let mut scratch: HashMap<String, Vec<(String, u64)>> = HashMap::new();
        for line in text.lines() {
            let Some(sp1) = line.find(' ') else { continue };
            let Some(sp2rel) = line[sp1 + 1..].find(' ') else {
                continue;
            };
            let sp2 = sp1 + 1 + sp2rel;
            let w1 = line[..sp1].to_lowercase();
            let w2 = line[sp1 + 1..sp2].to_lowercase();
            let Ok(count) = line[sp2 + 1..].trim().parse::<u64>() else {
                continue;
            };

            self.bigram_counts.insert(format!("{w1} {w2}"), count);
            scratch.entry(w1).or_default().push((w2, count));
        }
        for (key, mut list) in scratch {
            list.sort_by(|a, b| b.1.cmp(&a.1));
            list.truncate(MAX_NEXT_WORD_PER_KEY);
            self.next_word
                .insert(key, list.into_iter().map(|(w, _)| w).collect());
        }
        Ok(())
    }

    // ----- Public API -----

    /// The corpus bigram count for prev→word, or 0.
    fn corpus_bigram(&self, previous: &str, word: &str) -> u64 {
        self.bigram_counts
            .get(&format!(
                "{} {}",
                previous.to_lowercase(),
                word.to_lowercase()
            ))
            .copied()
            .unwrap_or(0)
    }

    /// Produce the single best ghost suggestion for `text_before_caret`, honoring
    /// the enabled features. Returns `None` when there's nothing to show.
    pub fn query(
        &self,
        text_before_caret: &str,
        want_completion: bool,
        want_next_word: bool,
    ) -> Option<Ghost> {
        let (current, previous) = split_words(text_before_caret);

        // Mid-word → complete it.
        if want_completion && current.chars().count() >= 2 {
            if let Some(word) = self.best_completion(&current, &previous) {
                let cased = match_case(&current, &word);
                // Only prefix completions render cleanly as inline ghost text.
                if cased.len() > current.len()
                    && cased.to_lowercase().starts_with(&current.to_lowercase())
                {
                    let insert = cased[current.len()..].to_string();
                    if !insert.is_empty() {
                        return Some(Ghost {
                            insert,
                            word: cased,
                            kind: GhostKind::Completion,
                        });
                    }
                }
            }
        }

        // At a word boundary → predict the next word.
        if want_next_word && current.is_empty() && !previous.is_empty() {
            if let Some(word) = self.best_next_word(&previous) {
                return Some(Ghost {
                    insert: word.clone(),
                    word,
                    kind: GhostKind::NextWord,
                });
            }
        }

        None
    }

    /// Best completion for `prefix` (exact-prefix, re-ranked by context + lexicon).
    fn best_completion(&self, prefix: &str, previous: &str) -> Option<String> {
        let lower = prefix.to_lowercase();
        let node = self.walk_prefix(&lower)?;
        let prev_lower = previous.to_lowercase();

        let mut best: Option<(f64, u32)> = None;
        // The subtree's top-frequency words are the completion candidates.
        for &id in self.nodes[node]
            .top_words
            .iter()
            .take(MAX_COMPLETION_CANDIDATES)
        {
            let word = &self.words[id as usize];
            if *word == lower {
                continue; // nothing to complete
            }
            let mut score = ((self.counts[id as usize] + 1) as f64).log10();
            score += self.context_boost(&prev_lower, word);
            if best.is_none() || score > best.unwrap().0 {
                best = Some((score, id));
            }
        }
        best.map(|(_, id)| self.words[id as usize].clone())
    }

    /// Walk the trie down an exact prefix; `None` if the path falls off.
    fn walk_prefix(&self, prefix: &str) -> Option<usize> {
        let mut node = 0usize;
        for c in prefix.chars() {
            node = *self.nodes[node].children.get(&c)?;
        }
        Some(node)
    }

    /// Frequency + corpus-bigram + personal-lexicon boost for a candidate word.
    fn context_boost(&self, prev_lower: &str, word: &str) -> f64 {
        let mut boost = 0.0;
        {
            let lex = self.lexicon.lock();
            boost += lex.boost(word);
            if !prev_lower.is_empty() {
                let personal = lex.bigram_count(prev_lower, word);
                if personal > 0 {
                    boost += PERSONAL_BIGRAM_WEIGHT + ((personal + 1) as f64).log2().min(2.0);
                }
            }
        }
        if !prev_lower.is_empty() {
            let big = self.corpus_bigram(prev_lower, word);
            if big > 0 {
                boost += BIGRAM_WEIGHT + (((big + 1) as f64).log10() * 0.35).min(2.0);
            }
        }
        boost
    }

    /// Likely word to follow `previous` — personal usage first, then corpus.
    fn best_next_word(&self, previous: &str) -> Option<String> {
        let prev = previous.to_lowercase();
        {
            let lex = self.lexicon.lock();
            for (word, count) in lex.personal_next_words(&prev, 3) {
                if count >= 2 {
                    return Some(word);
                }
            }
        }
        self.next_word.get(&prev).and_then(|l| l.first().cloned())
    }

    /// Decide whether a finished word should be auto-corrected, and to what.
    pub fn correct(&self, word: &str, previous: &str) -> Option<String> {
        if word.is_empty() {
            return None;
        }
        let lower = word.to_lowercase();

        // An explicit "keep my word" undo blocks every kind of correction.
        if self.lexicon.lock().is_no_correct(&lower) {
            return None;
        }

        // Curated map wins first (handles short tokens like "im" -> "I'm").
        if let Some(mapped) = common_misspellings::get(&lower) {
            let corrected = apply_case(word, mapped, true);
            return (corrected != word).then_some(corrected);
        }

        if !is_statistically_correctable(word) {
            return None;
        }
        if self.is_known(&lower) {
            return None; // already a valid word
        }
        // A word the user types often is *their* word, even if the corpus doesn't know it.
        if self.lexicon.lock().is_protected(word) {
            return None;
        }

        let max_edit = if word.chars().count() <= 4 { 1 } else { 2 };
        let candidates = self.nearest(&lower, max_edit);
        let best = self.pick_best_correction(&candidates, previous)?;
        let term = &self.words[best.0 as usize];
        let dist = best.1;
        if *term == lower || dist == 0 || dist > max_edit {
            return None;
        }
        if self.counts[best.0 as usize] < MIN_SUGGESTION_COUNT {
            return None;
        }
        let corrected = apply_case(word, term, false);
        (corrected != word).then_some(corrected)
    }

    fn is_known(&self, lower: &str) -> bool {
        self.walk_prefix(lower)
            .is_some_and(|n| self.nodes[n].word_id >= 0)
    }

    /// All corpus words within `max_edit` Damerau-Levenshtein of `input`,
    /// as `(word_id, distance)`. Banded walk over the trie with row pruning.
    fn nearest(&self, input: &str, max_edit: i32) -> Vec<(u32, i32)> {
        let chars: Vec<char> = input.chars().collect();
        let len = chars.len();
        let row0: Vec<i32> = (0..=len as i32).collect();
        let mut out: Vec<(u32, i32)> = Vec::new();
        self.walk_nearest(0, '\0', &row0, None, &chars, max_edit, &mut out);
        out
    }

    #[allow(clippy::too_many_arguments)]
    fn walk_nearest(
        &self,
        idx: usize,
        path_char: char,
        row: &[i32],
        prev_row: Option<&[i32]>,
        input: &[char],
        max_edit: i32,
        out: &mut Vec<(u32, i32)>,
    ) {
        let len = input.len();
        let node = &self.nodes[idx];
        if node.word_id >= 0 && row[len] <= max_edit {
            out.push((node.word_id as u32, row[len]));
        }
        // Prune: once every cell exceeds the band no descendant can recover.
        if *row.iter().min().unwrap_or(&i32::MAX) > max_edit {
            return;
        }
        for (&c, &child) in &node.children {
            let mut next = vec![0i32; len + 1];
            next[0] = row[0] + 1;
            for i in 1..=len {
                let cost = if input[i - 1] == c { 0 } else { 1 };
                next[i] = (row[i] + 1).min(next[i - 1] + 1).min(row[i - 1] + cost);
                // Damerau transposition ("tomrorow" -> "tomorrow").
                if i >= 2 {
                    if let Some(pr) = prev_row {
                        if path_char != '\0' && input[i - 1] == path_char && input[i - 2] == c {
                            next[i] = next[i].min(pr[i - 2] + 1);
                        }
                    }
                }
            }
            self.walk_nearest(child, c, &next, Some(row), input, max_edit, out);
        }
    }

    /// All candidates share the smallest edit distance; prefer the one that fits
    /// after the previous word, then fall back to raw corpus frequency.
    fn pick_best_correction(
        &self,
        candidates: &[(u32, i32)],
        previous: &str,
    ) -> Option<(u32, i32)> {
        if candidates.is_empty() {
            return None;
        }
        // Keep only the minimum-distance tier (Verbosity.Closest).
        let min_dist = candidates.iter().map(|c| c.1).min().unwrap();
        let prev_lower = previous.to_lowercase();

        let mut best: Option<(f64, u32, i32)> = None;
        for &(id, dist) in candidates.iter().filter(|c| c.1 == min_dist) {
            let count = self.counts[id as usize];
            if count < MIN_SUGGESTION_COUNT {
                continue;
            }
            let word = &self.words[id as usize];
            let mut score = ((count + 1) as f64).log10();
            score += self.context_boost(&prev_lower, word);
            if best.is_none() || score > best.unwrap().0 {
                best = Some((score, id, dist));
            }
        }
        best.map(|(_, id, dist)| (id, dist))
    }

    // ----- Learning -----

    /// Record a finished word (and the bigram from the word before it).
    pub fn learn(&self, previous: &str, word: &str) {
        self.lexicon.lock().record_word(previous, word);
    }

    /// The user undid a correction of `original` — never touch it again.
    pub fn undo_correct(&self, previous: &str, original: &str) {
        let mut lex = self.lexicon.lock();
        lex.mark_do_not_correct(original);
        lex.record_word(previous, original);
    }

    /// Flush the personal lexicon to disk (called on shutdown / feature disable).
    pub fn flush(&self) {
        self.lexicon.lock().save();
    }
}

/// From the text before the caret, extract `(current_word, previous_word)`.
/// Mirrors `WordTracker.Current` / `.Previous`, computed from the string.
fn split_words(text: &str) -> (String, String) {
    let chars: Vec<char> = text.chars().collect();
    let mut end = chars.len();

    // current: trailing run of word chars
    let mut cur_start = end;
    while cur_start > 0 && is_word_char(chars[cur_start - 1]) {
        cur_start -= 1;
    }
    let current: String = chars[cur_start..end].iter().collect();

    // previous: skip the boundary run before current, then the word before it
    end = cur_start;
    while end > 0 && !is_word_char(chars[end - 1]) {
        end -= 1;
    }
    let mut prev_start = end;
    while prev_start > 0 && is_word_char(chars[prev_start - 1]) {
        prev_start -= 1;
    }
    let previous: String = chars[prev_start..end].iter().collect();

    (current, previous)
}

/// Copy the casing style of what the user typed onto a suggestion.
fn match_case(typed: &str, suggestion: &str) -> String {
    if typed.is_empty() || suggestion.is_empty() {
        return suggestion.to_string();
    }
    let letters: Vec<char> = typed.chars().filter(|c| c.is_alphabetic()).collect();
    let all_upper = letters.len() > 1 && letters.iter().all(|c| c.is_uppercase());
    if all_upper {
        return suggestion.to_uppercase();
    }
    let first = typed.chars().next().unwrap();
    if first.is_uppercase() {
        let mut out = String::new();
        let mut chars = suggestion.chars();
        if let Some(c0) = chars.next() {
            out.extend(c0.to_uppercase());
            out.extend(chars);
        }
        return out;
    }
    suggestion.to_string()
}

/// Guards against mangling non-prose tokens (code, acronyms, handles, numbers).
fn is_statistically_correctable(word: &str) -> bool {
    if word.chars().count() < 3 {
        return false;
    }
    let mut upper = 0;
    for c in word.chars() {
        if c.is_ascii_digit() {
            return false; // versions, IDs
        }
        if matches!(c, '@' | '_' | '/' | '\\') {
            return false;
        }
        if c.is_uppercase() {
            upper += 1;
        }
    }
    // All-caps acronyms (URL, NASA) and internal capitals (camelCase, McX) are
    // intentional; only correct plain lowercase / Titlecase words.
    if upper > 1 {
        return false;
    }
    let first_upper = word.chars().next().is_some_and(|c| c.is_uppercase());
    if upper == 1 && !first_upper {
        return false;
    }
    true
}

/// Apply the original word's casing to a replacement. When the replacement has
/// intrinsic case (curated map, e.g. "I'm"), a lowercase original keeps it as-is.
fn apply_case(original: &str, replacement: &str, replacement_has_intrinsic_case: bool) -> String {
    if replacement.is_empty() || original.is_empty() {
        return replacement.to_string();
    }
    let letters: Vec<char> = original.chars().filter(|c| c.is_alphabetic()).collect();
    let all_upper = original.chars().count() > 1
        && !letters.is_empty()
        && letters.iter().all(|c| c.is_uppercase());
    if all_upper {
        return replacement.to_uppercase();
    }
    if original.chars().next().is_some_and(|c| c.is_uppercase()) {
        let mut out = String::new();
        let mut chars = replacement.chars();
        if let Some(c0) = chars.next() {
            out.extend(c0.to_uppercase());
            out.extend(chars);
        }
        return out;
    }
    if replacement_has_intrinsic_case {
        replacement.to_string()
    } else {
        replacement.to_lowercase()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn load() -> Engine {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/typing-assist");
        let lex = std::env::temp_dir().join("aurora_ta_test_lexicon.json");
        let _ = std::fs::remove_file(&lex);
        Engine::load(
            &base.join("frequency_dictionary_en.txt"),
            &base.join("frequency_bigramdictionary_en.txt"),
            lex,
        )
        .expect("dictionaries load")
    }

    #[test]
    fn corrects_curated_and_statistical() {
        let e = load();
        // Curated, unambiguous fixes.
        assert_eq!(e.correct("teh", ""), Some("the".into()));
        assert_eq!(e.correct("recieve", ""), Some("receive".into()));
        assert_eq!(e.correct("seperate", ""), Some("separate".into()));
        // Statistical (not in the curated map) — clear single-edit repairs.
        assert_eq!(e.correct("wrold", ""), Some("world".into()));
        assert_eq!(e.correct("goign", ""), Some("going".into()));
    }

    #[test]
    fn leaves_valid_and_code_tokens_alone() {
        let e = load();
        assert_eq!(e.correct("the", ""), None);
        assert_eq!(e.correct("hello", ""), None);
        assert_eq!(e.correct("useState", ""), None); // internal caps → code
        assert_eq!(e.correct("URL", ""), None); // all-caps acronym
        assert_eq!(e.correct("v2", ""), None); // digit → not prose
    }

    #[test]
    fn preserves_original_casing() {
        let e = load();
        assert_eq!(e.correct("Teh", ""), Some("The".into()));
        assert_eq!(e.correct("TEH", ""), Some("THE".into()));
    }

    #[test]
    fn completes_prefix_as_ghost() {
        let e = load();
        let g = e
            .query("I need to fini", true, false)
            .expect("a completion");
        assert!(matches!(g.kind, GhostKind::Completion));
        assert!(
            g.word.to_lowercase().starts_with("fini"),
            "word = {}",
            g.word
        );
        assert_eq!(g.insert, g.word["fini".len()..]);
    }

    #[test]
    fn predicts_next_word_after_space() {
        let e = load();
        let g = e.query("thank ", false, true);
        assert!(
            g.is_some(),
            "expected a next-word prediction after 'thank '"
        );
        assert!(matches!(g.unwrap().kind, GhostKind::NextWord));
    }

    #[test]
    fn respects_disabled_features() {
        let e = load();
        // completion off → no ghost mid-word
        assert!(e.query("I need to fini", false, false).is_none());
        // next-word off → no ghost after a space
        assert!(e.query("thank ", true, false).is_none());
    }
}
