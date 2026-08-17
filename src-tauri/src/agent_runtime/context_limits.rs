//! Learned per-endpoint context limits [leaf, disk-backed].
//!
//! **Why this exists.** The context window Aurora holds for a model is a
//! claim, not a measurement. It comes from a preset or from what the user
//! typed, and nothing verifies it. Measured on 2026-08-15: `gpt-5.6-sol`
//! configured at 1,050,000 tokens, served by an endpoint that rejected a
//! 355,296-token request outright. Auto-compaction triggers at a percentage of
//! the configured window — 85% of 1,050,000 is 892,500, a line that endpoint
//! can never reach — so compaction never fired, and every long conversation
//! ran until the provider killed it.
//!
//! No published number can fix that, because the gap is per-endpoint: the same
//! model id behind a different gateway has a different real ceiling. The only
//! authority is the endpoint itself, and it answers in exactly two ways —
//! it accepts a request of a known size, or it rejects one. This module
//! remembers both, per `provider:model`, so the answer survives a restart and
//! the second conversation on a provider is not taught the same lesson as the
//! first.
//!
//! **What is stored.** For each endpoint, the largest request it has accepted
//! and the smallest it has rejected. The usable ceiling sits between them and
//! is pulled toward the accepted end by [`SAFETY_MARGIN`], because a request
//! that is refused costs a round-trip and a summarization, while one that is
//! slightly smaller than it had to be costs nothing.
//!
//! **Why a file and not the database.** This is not user configuration and it
//! is not conversation state — it belongs to neither table. It is small,
//! written rarely, read on every turn, and losing it costs exactly one
//! rejected request to relearn. A standalone JSON file under
//! `paths::limits_dir()` keeps it inspectable (`context-limits.json` is
//! readable by a person debugging exactly this problem) and keeps a schema
//! migration off the critical path.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

/// How far below a known rejection the usable ceiling is placed.
///
/// The rejection tells us a size that fails; it does not tell us the largest
/// size that works. Sitting flush against it would re-fail on the next request
/// that happens to estimate slightly low. A tenth of headroom is cheap —
/// compaction runs marginally earlier — against a failure that costs a
/// round-trip, a forced summarization and a retry.
const SAFETY_MARGIN: f64 = 0.9;

/// Bumped when the on-disk shape changes. A file from an older version is
/// discarded rather than migrated: relearning costs one rejected request, and
/// a migration path for a cache this cheap is not worth the code.
const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Entry {
    /// Largest request this endpoint has been measured accepting.
    #[serde(default)]
    largest_accepted: u32,
    /// Smallest request it has been seen rejecting as too large.
    #[serde(default)]
    smallest_rejected: Option<u32>,
    /// Last write, epoch ms. Diagnostic only — nothing branches on it.
    #[serde(default)]
    updated_at_ms: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct LimitFile {
    version: u32,
    entries: HashMap<String, Entry>,
}

fn path() -> PathBuf {
    crate::paths::limits_dir().join("context-limits.json")
}

/// Process-wide cache of the file. Loaded once; every write goes through here
/// and then straight to disk, so a second window sees a limit this one learned
/// on its next load rather than never.
fn store() -> &'static Mutex<LimitFile> {
    static STORE: OnceLock<Mutex<LimitFile>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(load()))
}

fn load() -> LimitFile {
    let Ok(raw) = std::fs::read_to_string(path()) else {
        return LimitFile {
            version: FORMAT_VERSION,
            entries: HashMap::new(),
        };
    };
    match serde_json::from_str::<LimitFile>(&raw) {
        Ok(file) if file.version == FORMAT_VERSION => file,
        // Corrupt or from an older format. Starting empty is correct and
        // silent-by-design would not be: a limit file that quietly resets is
        // indistinguishable from one that never learned anything.
        Ok(_) => {
            crate::logging::log_warn(
                "agent_runtime.context_limits",
                "context-limits.json is from an older format — starting empty; \
                 each endpoint relearns its ceiling on its next oversized request",
            );
            LimitFile {
                version: FORMAT_VERSION,
                entries: HashMap::new(),
            }
        }
        Err(err) => {
            crate::logging::log_warn(
                "agent_runtime.context_limits",
                &format!("context-limits.json could not be parsed ({err}) — starting empty"),
            );
            LimitFile {
                version: FORMAT_VERSION,
                entries: HashMap::new(),
            }
        }
    }
}

/// Write-through. Failures are logged, never propagated: a limit that cannot
/// be persisted still works for this process, and a turn must not die because
/// a cache file is unwritable.
fn persist(file: &LimitFile) {
    let target = path();
    match serde_json::to_string_pretty(file) {
        Ok(json) => {
            if let Err(err) = std::fs::write(&target, json) {
                crate::logging::log_warn(
                    "agent_runtime.context_limits",
                    &format!(
                        "could not write {} ({err}) — limits hold for this session only",
                        target.display()
                    ),
                );
            }
        }
        Err(err) => crate::logging::log_warn(
            "agent_runtime.context_limits",
            &format!("could not serialize context limits ({err})"),
        ),
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// The ceiling this endpoint is known to tolerate, if anything is known.
///
/// `None` means "nothing learned" — the caller keeps whatever it was going to
/// use. This deliberately does NOT invent a number from the accepted side
/// alone: a request that succeeded proves the ceiling is at least that high,
/// never that it is that low, and treating it as a limit would compact a
/// conversation that had plenty of room.
#[must_use]
pub fn learned_ceiling(model: &str) -> Option<u32> {
    let file = store().lock().ok()?;
    let entry = file.entries.get(model)?;
    let rejected = entry.smallest_rejected?;
    let margin = (f64::from(rejected) * SAFETY_MARGIN) as u32;
    // Never place the ceiling below a size this endpoint has actually served:
    // that is proven-good ground, and compacting below it would throw away
    // context for nothing.
    Some(margin.max(entry.largest_accepted))
}

/// The window the runtime should actually budget against: the smaller of what
/// the user configured and what the endpoint has proven it accepts.
///
/// `configured` wins while nothing is known, which is every provider that has
/// never overflowed — the common case, and one this must not slow down or
/// second-guess.
#[must_use]
pub fn effective_window(model: &str, configured: Option<u32>) -> Option<u32> {
    match (configured.filter(|w| *w > 0), learned_ceiling(model)) {
        (Some(configured), Some(learned)) => Some(configured.min(learned)),
        (Some(configured), None) => Some(configured),
        // No configured window but a learned ceiling still beats budgeting
        // against nothing at all.
        (None, learned) => learned,
    }
}

/// Record a request this endpoint served, at its measured size.
///
/// Only ever called with a PROVIDER-measured number. An estimate here would
/// teach the ceiling a figure Aurora made up, and the whole point of this
/// module is that Aurora's own numbers are what could not be trusted.
pub fn record_accepted(model: &str, tokens: u32) {
    if model.is_empty() || tokens == 0 {
        return;
    }
    let Ok(mut file) = store().lock() else { return };
    let entry = file.entries.entry(model.to_string()).or_default();
    if tokens <= entry.largest_accepted {
        return;
    }
    entry.largest_accepted = tokens;
    // A success at or above a size we had recorded as rejected means the old
    // rejection no longer describes this endpoint — a raised plan limit, a
    // different gateway behind the same id, a transient refusal we
    // misattributed. The newer, positive evidence wins outright.
    if entry.smallest_rejected.is_some_and(|r| r <= tokens) {
        entry.smallest_rejected = None;
    }
    entry.updated_at_ms = now_ms();
    persist(&file);
}

/// Record a request this endpoint refused as too large.
///
/// `tokens` is Aurora's estimate of what it tried to send — the provider does
/// not report a size for a request it never ran. That makes the figure
/// approximate, which is why it is clamped: a rejection is never allowed to
/// claim a ceiling at or below a size this same endpoint has already served,
/// or one bad estimate would compact every future conversation to nothing.
pub fn record_rejected(model: &str, tokens: u32) {
    if model.is_empty() || tokens == 0 {
        return;
    }
    let Ok(mut file) = store().lock() else { return };
    let entry = file.entries.entry(model.to_string()).or_default();
    let floor = entry.largest_accepted.saturating_add(1);
    let candidate = tokens.max(floor);
    if entry.smallest_rejected.is_some_and(|r| r <= candidate) {
        return;
    }
    entry.smallest_rejected = Some(candidate);
    entry.updated_at_ms = now_ms();
    persist(&file);
    crate::logging::log_warn(
        "agent_runtime.context_limits",
        &format!(
            "{model} refused ~{candidate} tokens; budgeting against \
             {} from now on (configured window is not what this endpoint serves)",
            (f64::from(candidate) * SAFETY_MARGIN) as u32
        ),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The arithmetic, exercised without touching the process-wide file — the
    /// rules are what matter and they must hold independent of where the JSON
    /// happens to live.
    fn ceiling_of(entry: &Entry) -> Option<u32> {
        let rejected = entry.smallest_rejected?;
        Some(((f64::from(rejected) * SAFETY_MARGIN) as u32).max(entry.largest_accepted))
    }

    #[test]
    fn nothing_learned_means_the_configured_window_is_untouched() {
        let entry = Entry::default();
        assert_eq!(ceiling_of(&entry), None);
    }

    /// A success alone must never lower the ceiling: it proves the endpoint
    /// serves AT LEAST that much, which is the opposite of a limit.
    #[test]
    fn an_accepted_request_alone_sets_no_ceiling() {
        let entry = Entry {
            largest_accepted: 294_873,
            smallest_rejected: None,
            updated_at_ms: 0,
        };
        assert_eq!(ceiling_of(&entry), None);
    }

    /// The measured 2026-08-15 case: configured 1,050,000, rejected at
    /// 355,296, previously served 294,873.
    #[test]
    fn a_rejection_places_the_ceiling_below_it_with_headroom() {
        let entry = Entry {
            largest_accepted: 294_873,
            smallest_rejected: Some(355_296),
            updated_at_ms: 0,
        };
        let ceiling = ceiling_of(&entry).expect("a rejection is a ceiling");
        assert_eq!(ceiling, 319_766);
        assert!(ceiling < 355_296, "must sit below the size that failed");
        assert!(
            ceiling > 294_873,
            "must not discard ground the endpoint has already served"
        );
        // 85% of the learned ceiling is reachable; 85% of the configured
        // window (892,500) never was — this is the whole fix in one line.
        assert!((ceiling as f64 * 0.85) < 294_873.0);
    }

    /// A wild low estimate on the rejected side must not be able to collapse
    /// the ceiling under proven-good ground.
    #[test]
    fn a_rejection_below_a_proven_size_is_clamped_above_it() {
        let mut entry = Entry {
            largest_accepted: 294_873,
            smallest_rejected: None,
            updated_at_ms: 0,
        };
        let floor = entry.largest_accepted.saturating_add(1);
        entry.smallest_rejected = Some(12_000u32.max(floor));
        assert_eq!(entry.smallest_rejected, Some(294_874));
        assert_eq!(
            ceiling_of(&entry),
            Some(294_873),
            "clamped back onto the largest size actually served"
        );
    }

    #[test]
    fn file_round_trips_through_serde() {
        let mut entries = HashMap::new();
        entries.insert(
            "openai-responses:gpt-5.6-sol".to_string(),
            Entry {
                largest_accepted: 294_873,
                smallest_rejected: Some(355_296),
                updated_at_ms: 1_755_000_000_000,
            },
        );
        let file = LimitFile {
            version: FORMAT_VERSION,
            entries,
        };
        let json = serde_json::to_string(&file).expect("serialize");
        let back: LimitFile = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.version, FORMAT_VERSION);
        let entry = &back.entries["openai-responses:gpt-5.6-sol"];
        assert_eq!(entry.largest_accepted, 294_873);
        assert_eq!(entry.smallest_rejected, Some(355_296));
    }
}
