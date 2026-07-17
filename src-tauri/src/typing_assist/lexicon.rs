//! The user's personal language model: which words they actually type, how
//! recently, which word tends to follow which, and which words they've told us
//! never to "correct". Everything lives in memory and is persisted to a small
//! local JSON file (words only — never sentences or keystrokes).
//!
//! Faithful port of TypeAssist's `UserLexicon`. Thread-safe: the engine holds
//! this behind a `Mutex`, so the methods here assume single-threaded access and
//! the engine serializes them.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const MAX_WORDS: usize = 4000;
const MAX_BIGRAMS: usize = 8000;
const SAVE_EVERY_N_UPDATES: u32 = 40;
/// Times a word must be typed before we refuse to autocorrect it.
const LEARNED_THRESHOLD: u32 = 3;

#[derive(Clone, Copy)]
struct WordStat {
    count: u32,
    last_used_min: i64, // minutes since unix epoch
}

#[derive(Default, Serialize, Deserialize)]
struct Snapshot {
    /// word -> [count, minutes_since_epoch]
    #[serde(default)]
    words: HashMap<String, [i64; 2]>,
    /// "prev\nword" -> count
    #[serde(default)]
    bigrams: HashMap<String, i64>,
    #[serde(default, rename = "noCorrect")]
    no_correct: Vec<String>,
}

pub struct Lexicon {
    path: PathBuf,
    words: HashMap<String, WordStat>,
    bigrams: HashMap<String, i64>,
    no_correct: HashSet<String>,
    updates_since_save: u32,
}

fn now_minutes() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| (d.as_secs() / 60) as i64)
        .unwrap_or(0)
}

fn normalize(word: &str) -> String {
    word.to_lowercase()
}

impl Lexicon {
    /// Loads the lexicon from `path` (best-effort — a corrupt file starts fresh).
    pub fn load(path: PathBuf) -> Self {
        let mut lex = Lexicon {
            path,
            words: HashMap::new(),
            bigrams: HashMap::new(),
            no_correct: HashSet::new(),
            updates_since_save: 0,
        };
        if let Ok(text) = std::fs::read_to_string(&lex.path) {
            if let Ok(snap) = serde_json::from_str::<Snapshot>(&text) {
                for (w, arr) in snap.words {
                    lex.words.insert(
                        w,
                        WordStat {
                            count: arr[0].max(0) as u32,
                            last_used_min: arr[1],
                        },
                    );
                }
                lex.bigrams = snap.bigrams;
                lex.no_correct = snap.no_correct.into_iter().collect();
            }
        }
        lex
    }

    // ----- Recording -----

    /// Records a finished word (and the bigram from the word before it).
    pub fn record_word(&mut self, previous: &str, word: &str) {
        let w = normalize(word);
        if w.chars().count() < 2 || w.chars().count() > 32 {
            return;
        }
        let now = now_minutes();
        match self.words.get_mut(&w) {
            Some(stat) => {
                stat.count += 1;
                stat.last_used_min = now;
            }
            None => {
                if self.words.len() >= MAX_WORDS {
                    self.prune_words();
                }
                self.words.insert(
                    w.clone(),
                    WordStat {
                        count: 1,
                        last_used_min: now,
                    },
                );
            }
        }

        let p = normalize(previous);
        if !p.is_empty() {
            let key = format!("{p}\n{w}");
            if let Some(c) = self.bigrams.get_mut(&key) {
                *c += 1;
            } else {
                if self.bigrams.len() >= MAX_BIGRAMS {
                    self.prune_bigrams();
                }
                self.bigrams.insert(key, 1);
            }
        }

        self.updates_since_save += 1;
        self.save_if_due();
    }

    /// The user undid a correction of `original` — never touch it again.
    pub fn mark_do_not_correct(&mut self, original: &str) {
        let w = normalize(original);
        if w.is_empty() {
            return;
        }
        self.no_correct.insert(w);
        self.updates_since_save += 1;
        self.save_if_due();
    }

    // ----- Queries -----

    /// True when autocorrect must leave this word alone (undone or heavily used).
    pub fn is_protected(&self, word: &str) -> bool {
        let w = normalize(word);
        if self.no_correct.contains(&w) {
            return true;
        }
        self.words
            .get(&w)
            .is_some_and(|s| s.count >= LEARNED_THRESHOLD)
    }

    /// True when the undo list specifically contains this word (blocks even curated fixes).
    pub fn is_no_correct(&self, word: &str) -> bool {
        self.no_correct.contains(&normalize(word))
    }

    /// Score boost for a candidate the user personally types (0 for unknown).
    pub fn boost(&self, word: &str) -> f64 {
        let Some(stat) = self.words.get(&normalize(word)) else {
            return 0.0;
        };
        let mut boost = (f64::from(stat.count + 1)).log2().min(3.0);
        let minutes = (now_minutes() - stat.last_used_min) as f64;
        if minutes <= 10.0 {
            boost += 2.0;
        } else if minutes <= 120.0 {
            boost += 0.8;
        }
        boost
    }

    /// Personal bigram count for prev→word (0 when never seen).
    pub fn bigram_count(&self, previous: &str, word: &str) -> i64 {
        let key = format!("{}\n{}", normalize(previous), normalize(word));
        self.bigrams.get(&key).copied().unwrap_or(0)
    }

    /// The user's own most likely words after `previous`, best first.
    pub fn personal_next_words(&self, previous: &str, count: usize) -> Vec<(String, i64)> {
        let prefix = format!("{}\n", normalize(previous));
        let mut hits: Vec<(String, i64)> = self
            .bigrams
            .iter()
            .filter_map(|(key, &c)| key.strip_prefix(&prefix).map(|w| (w.to_string(), c)))
            .collect();
        hits.sort_by(|a, b| b.1.cmp(&a.1));
        hits.truncate(count);
        hits
    }

    // ----- Pruning -----

    fn prune_words(&mut self) {
        let drop = self.words.len() / 4;
        let mut ordered: Vec<(String, i64)> = self
            .words
            .iter()
            .map(|(k, v)| (k.clone(), v.last_used_min))
            .collect();
        ordered.sort_by(|a, b| a.1.cmp(&b.1)); // oldest first
        for (k, _) in ordered.into_iter().take(drop) {
            self.words.remove(&k);
        }
    }

    fn prune_bigrams(&mut self) {
        let drop = self.bigrams.len() / 4;
        let mut ordered: Vec<(String, i64)> =
            self.bigrams.iter().map(|(k, &v)| (k.clone(), v)).collect();
        ordered.sort_by(|a, b| a.1.cmp(&b.1)); // least-used first
        for (k, _) in ordered.into_iter().take(drop) {
            self.bigrams.remove(&k);
        }
    }

    // ----- Persistence -----

    fn save_if_due(&mut self) {
        if self.updates_since_save >= SAVE_EVERY_N_UPDATES {
            self.updates_since_save = 0;
            self.save();
        }
    }

    /// Writes the lexicon to disk. Best-effort; the in-memory copy keeps working.
    pub fn save(&self) {
        let mut snap = Snapshot::default();
        for (w, stat) in &self.words {
            snap.words
                .insert(w.clone(), [i64::from(stat.count), stat.last_used_min]);
        }
        snap.bigrams = self.bigrams.clone();
        snap.no_correct = self.no_correct.iter().cloned().collect();

        if let Ok(json) = serde_json::to_string(&snap) {
            if let Some(dir) = self.path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&self.path, json);
        }
    }
}
