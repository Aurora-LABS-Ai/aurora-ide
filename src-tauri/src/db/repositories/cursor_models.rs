//! `cursor_models` — the Cursor account's model catalogue.
//!
//! The account is the source of truth, so this repository has no `add` and no
//! `update`: the only write is [`CursorModelsRepository::replace_all`], which
//! swaps the whole catalogue inside one transaction. A user picks from this
//! list; they never edit it.
//!
//! That shape is the point. `provider_models` supports per-row editing because
//! those rows are the user's own; here, a row that survived a refresh it should
//! not have would be a model the account can no longer reach — selectable,
//! priced, and then failing at the first request.

use rusqlite::{params, Connection};

use crate::db::error::DbResult;

/// One model the signed-in Cursor account can reach.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorModel {
    /// Upstream id, sent verbatim as the model. Note this is the *raw* id
    /// (`claude-opus-5-thinking-high`) with no vendor prefix — prefixed forms
    /// like `cursor-claude-…` are an artifact of OpenAI-shaped bridges and
    /// are not what the agent protocol accepts.
    pub model_id: String,
    pub display_model_id: Option<String>,
    pub display_name: Option<String>,
    pub display_name_short: Option<String>,
    /// Alternate ids the account also accepts for this model.
    #[serde(default)]
    pub aliases: Vec<String>,
    pub supports_thinking: bool,
    pub max_mode: bool,
    /// Whether this model appears in the model selector.
    ///
    /// An account reaches ~200 models; showing them all would make the
    /// selector unusable. The provider page lists the whole catalogue with a
    /// toggle, and only what is toggled on is offered when picking a model.
    ///
    /// Set by the user, never by the catalogue — see
    /// [`CursorModelsRepository::replace_all`] for why a refresh must not
    /// touch it.
    #[serde(default)]
    pub enabled: bool,
    /// Position in the upstream response. Cursor's own ordering puts the
    /// models it expects you to want first, which is better than anything we
    /// would invent by sorting alphabetically.
    pub sort_order: i64,
}

/// Suffix Cursor puts on the low-latency variant of a model.
const FAST_SUFFIX: &str = "-fast";

/// Everything Cursor appends to a model id that describes *how* to run it
/// rather than *which* model it is.
///
/// These are the difference between 204 rows and 43: `claude-fable-5` alone
/// ships ten ids that vary only by effort and thinking. Longest-first so
/// `-xhigh` is not left as a stray `-x` by matching `high`.
const MODIFIER_SUFFIXES: &[&str] = &[
    "-thinking",
    "-minimal",
    "-medium",
    "-xhigh",
    "-extra",
    "-high",
    "-none",
    "-fast",
    "-low",
    "-max",
];

/// Read the leading version number out of an id fragment and compare it to a
/// floor.
///
/// Cursor writes the same version two ways — `claude-opus-4-8` and
/// `gpt-5.2` — so **a dash between two numbers is a decimal point**. Reading
/// `4-5` as plain `4` is how Opus 4.5 ends up hidden as though it were Opus 4.
///
/// `"5.2"` → 5.2 · `"4-8-high"` → 4.8 · `"4-sonnet"` → 4.0 · `"5"` → 5.0.
/// A fragment with no leading number returns `false`: an id this rule was not
/// written for is not an old id, and hiding it would be a guess.
fn below_version(fragment: &str, floor: f32) -> bool {
    let mut parts = fragment.split(['-', '.']);
    let Some(first) = parts.next() else {
        return false;
    };

    let major: String = first.chars().take_while(char::is_ascii_digit).collect();
    if major.is_empty() {
        return false;
    }

    // A major glued to letters (`4o`) carries no minor — the letters are a
    // model name, not a version. Only a cleanly numeric first segment can be
    // followed by one.
    let minor = if is_numeric(first) {
        // A trailing non-numeric segment (`4-sonnet`) means no minor either.
        parts.next().filter(|p| is_numeric(p)).unwrap_or("0")
    } else {
        "0"
    };

    match format!("{major}.{minor}").parse::<f32>() {
        Ok(version) => version < floor,
        Err(_) => false,
    }
}

fn is_numeric(part: &str) -> bool {
    !part.is_empty() && part.chars().all(|c| c.is_ascii_digit())
}

impl CursorModel {
    /// Whether this is Cursor's low-latency variant.
    ///
    /// Derived rather than stored: it is a fact about the id, so computing it
    /// cannot drift out of sync with the catalogue the way a column could.
    #[must_use]
    pub fn is_fast(&self) -> bool {
        self.model_id.ends_with(FAST_SUFFIX)
    }

    /// The id with the fast suffix removed — the model this is a variant of.
    ///
    /// Roughly half the ~200-model catalogue is a `-fast` twin of another
    /// entry. Pairing them lets the provider page show one row per model with
    /// a Fast toggle instead of two near-identical rows, which is the
    /// difference between a list someone can scan and one they cannot.
    #[must_use]
    pub fn base_model_id(&self) -> &str {
        Self::base_of(&self.model_id)
    }

    /// [`base_model_id`] for a bare id, without needing a whole row.
    ///
    /// [`base_model_id`]: Self::base_model_id
    #[must_use]
    pub fn base_of(model_id: &str) -> &str {
        model_id.strip_suffix(FAST_SUFFIX).unwrap_or(model_id)
    }

    /// Whether this model is an older generation the picker hides by default.
    ///
    /// A Cursor account reaches ~200 models and keeps years of back-catalogue
    /// alive. Most of it is strictly worse than what sits beside it, and a
    /// list that long is one nobody reads. The floors:
    ///
    /// - **GPT** — 5 and up
    /// - **Claude Sonnet / Opus** — 4.5 and up
    ///
    /// Anything outside those families is left alone: a rule that guesses at
    /// families it was not written for would hide models on a vendor Cursor
    /// adds next month.
    ///
    /// Hidden, never deleted. The catalogue still stores them and the provider
    /// page can show them on request — this decides a default view, not what
    /// the account can reach.
    #[must_use]
    pub fn is_legacy(&self) -> bool {
        let id = self.base_model_id().to_ascii_lowercase();
        let id = id.strip_prefix("cursor-").unwrap_or(&id);

        if let Some(rest) = id.strip_prefix("gpt-") {
            return below_version(rest, 5.0);
        }
        for family in ["claude-sonnet-", "claude-opus-"] {
            if let Some(rest) = id.strip_prefix(family) {
                return below_version(rest, 4.5);
            }
        }
        // Cursor also ships the older `claude-4-sonnet` / `claude-4.5-opus`
        // ordering, where the version comes before the tier.
        if let Some(rest) = id.strip_prefix("claude-") {
            if rest.contains("sonnet") || rest.contains("opus") {
                return below_version(rest, 4.5);
            }
        }
        false
    }

    /// The models.dev key for this model, or `None` when the id carries no
    /// recognisable base.
    ///
    /// Cursor's wire says **nothing** about modality, context window, or
    /// pricing — `ModelDetails` is an id, display names, aliases, a thinking
    /// marker and a max-mode flag. Rather than hardcode a family table that
    /// goes stale every time a vendor ships a model, Aurora looks the model up
    /// in the models.dev catalogue it already uses for every other provider.
    ///
    /// That needs the vendor's own id, so this strips the decorations Cursor
    /// layers on top: its `cursor-` prefix, the `-fast` twin marker, the
    /// `-thinking` marker, and the effort suffix (`-low`/`-high`/`-max`/…).
    /// `claude-opus-5-thinking-high` → `claude-opus-5`.
    #[must_use]
    pub fn catalog_key(&self) -> Option<String> {
        let mut id = self.base_model_id().to_ascii_lowercase();

        // `auto`/`default` is a router, not a model — there is nothing to look
        // up, and its real capabilities depend on where it routes.
        if matches!(id.as_str(), "auto" | "default" | "cursor-default") {
            return None;
        }
        if let Some(stripped) = id.strip_prefix("cursor-") {
            id = stripped.to_string();
        }

        // Cursor writes these in **both** orders — `claude-opus-5-thinking-high`
        // and `claude-4.5-opus-high-thinking` — so a single pass in a fixed
        // order leaves half of them un-stripped and splits one model across two
        // rows. Strip until nothing changes.
        loop {
            let before = id.len();
            for suffix in MODIFIER_SUFFIXES {
                if let Some(stripped) = id.strip_suffix(suffix) {
                    id = stripped.to_string();
                    break;
                }
            }
            if id.len() == before {
                break;
            }
        }
        (!id.is_empty()).then_some(id)
    }
}

pub struct CursorModelsRepository<'a> {
    conn: &'a Connection,
}

impl<'a> CursorModelsRepository<'a> {
    #[must_use]
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    /// Replace the entire catalogue, **keeping the user's enable choices**.
    ///
    /// Transactional delete-then-insert rather than an upsert-and-prune: a
    /// refresh is a snapshot, and a half-applied one would leave the user
    /// picking from a list that never existed on the account.
    ///
    /// The one thing that survives is `enabled`, carried across by `model_id`.
    /// Without that, every refresh would silently reset a selector the user
    /// had curated — the kind of loss that is invisible until they go looking
    /// for a model that was there yesterday. A model the account has dropped
    /// takes its flag with it, which is correct: re-adding it later should not
    /// resurrect a choice made about a different catalogue.
    ///
    /// An empty `models` is refused. A successful RPC always returns models,
    /// so an empty list means something went wrong upstream — and wiping the
    /// catalogue would turn a transient failure into an empty model picker.
    ///
    /// On the very first populate nothing is enabled yet, so the account's
    /// top-ranked model is switched on. Cursor orders the response by what it
    /// expects you to want, and connecting to a provider that then offers
    /// nothing to select reads as broken.
    pub fn replace_all(&self, models: &[CursorModel], fetched_at: &str) -> DbResult<usize> {
        if models.is_empty() {
            return Ok(self.count()?);
        }

        let previously_enabled = self.enabled_ids()?;
        let had_catalogue = self.count()? > 0;

        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM cursor_models", [])?;

        {
            let mut stmt = tx.prepare(
                "INSERT INTO cursor_models (
                    model_id, display_model_id, display_name, display_name_short,
                    aliases, supports_thinking, max_mode, enabled, sort_order, fetched_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )?;
            for (index, model) in models.iter().enumerate() {
                let aliases = serde_json::to_string(&model.aliases).unwrap_or_else(|_| "[]".into());
                let enabled = if had_catalogue {
                    previously_enabled.contains(&model.model_id)
                } else {
                    index == 0
                };
                stmt.execute(params![
                    model.model_id,
                    model.display_model_id,
                    model.display_name,
                    model.display_name_short,
                    aliases,
                    model.supports_thinking as i32,
                    model.max_mode as i32,
                    enabled as i32,
                    index as i64,
                    fetched_at,
                ])?;
            }
        }

        tx.commit()?;
        Ok(models.len())
    }

    /// Ids currently switched on, as a set for cheap carry-over.
    fn enabled_ids(&self) -> DbResult<std::collections::HashSet<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT model_id FROM cursor_models WHERE enabled = 1")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows.flatten().collect())
    }

    /// Toggle one model's presence in the model selector.
    ///
    /// Returns `false` when the id is not in the catalogue — a stale UI
    /// toggling a model a refresh removed should be told, not silently
    /// ignored.
    pub fn set_enabled(&self, model_id: &str, enabled: bool) -> DbResult<bool> {
        let changed = self.conn.execute(
            "UPDATE cursor_models SET enabled = ?1 WHERE model_id = ?2",
            params![enabled as i32, model_id],
        )?;
        Ok(changed > 0)
    }

    /// Set the enabled set in one shot — what "enable all" / "disable all" and
    /// a multi-select save call.
    ///
    /// Applied as one transaction so the selector can never observe a
    /// half-applied selection.
    pub fn set_enabled_bulk(&self, model_ids: &[String], enabled: bool) -> DbResult<usize> {
        if model_ids.is_empty() {
            return Ok(0);
        }
        let tx = self.conn.unchecked_transaction()?;
        let mut changed = 0;
        {
            let mut stmt =
                tx.prepare("UPDATE cursor_models SET enabled = ?1 WHERE model_id = ?2")?;
            for id in model_ids {
                changed += stmt.execute(params![enabled as i32, id])?;
            }
        }
        tx.commit()?;
        Ok(changed)
    }

    /// Only the models the user switched on — what the model selector offers.
    pub fn list_enabled(&self) -> DbResult<Vec<CursorModel>> {
        self.query("WHERE enabled = 1")
    }

    // Composing the id a turn sends — model plus effort, thinking and Fast —
    // is NOT done here. Cursor puts all three in the id, so the answer depends
    // on controls the composer owns and has to be available synchronously on
    // the send path. It lives in `services/providers/cursor-variants.ts`,
    // checked against the catalogue `list` serves.

    /// Every model, in the account's own order — what the provider page lists.
    pub fn list(&self) -> DbResult<Vec<CursorModel>> {
        self.query("")
    }

    fn query(&self, where_clause: &str) -> DbResult<Vec<CursorModel>> {
        let sql = format!(
            "SELECT model_id, display_model_id, display_name, display_name_short,
                    aliases, supports_thinking, max_mode, enabled, sort_order
             FROM cursor_models {where_clause}
             ORDER BY sort_order ASC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], |row| {
            let aliases: Option<String> = row.get(4)?;
            Ok(CursorModel {
                model_id: row.get(0)?,
                display_model_id: row.get(1)?,
                display_name: row.get(2)?,
                display_name_short: row.get(3)?,
                aliases: aliases
                    .and_then(|raw| serde_json::from_str(&raw).ok())
                    .unwrap_or_default(),
                supports_thinking: row.get::<_, i32>(5)? != 0,
                max_mode: row.get::<_, i32>(6)? != 0,
                enabled: row.get::<_, i32>(7)? != 0,
                sort_order: row.get(8)?,
            })
        })?;
        Ok(rows.flatten().collect())
    }

    /// When the catalogue was last pulled, RFC3339. `None` means never.
    ///
    /// Drives the "Last refreshed …" line on the settings card. Every row
    /// carries the same value, so reading one is enough.
    pub fn fetched_at(&self) -> DbResult<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT fetched_at FROM cursor_models LIMIT 1")?;
        let mut rows = stmt.query([])?;
        Ok(match rows.next()? {
            Some(row) => row.get(0)?,
            None => None,
        })
    }

    pub fn count(&self) -> DbResult<usize> {
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM cursor_models", [], |row| row.get(0))?;
        Ok(n as usize)
    }

    /// Forget the catalogue. Called on sign-out — a stale list belonging to an
    /// account nobody is signed in to is worse than an empty one, because it
    /// still looks selectable.
    pub fn clear(&self) -> DbResult<()> {
        self.conn.execute("DELETE FROM cursor_models", [])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        crate::db::schema::create_cursor_models_table(&conn).expect("schema");
        conn
    }

    fn model(id: &str) -> CursorModel {
        CursorModel {
            model_id: id.to_string(),
            display_model_id: None,
            display_name: None,
            display_name_short: None,
            aliases: Vec::new(),
            supports_thinking: false,
            max_mode: false,
            enabled: false,
            sort_order: 0,
        }
    }

    /// The regression this whole design exists to prevent: a catalogue
    /// refresh must not reset a selector the user curated.
    #[test]
    fn a_refresh_keeps_the_users_enabled_models() {
        let conn = db();
        let repo = CursorModelsRepository::new(&conn);
        repo.replace_all(&[model("a"), model("b"), model("c")], "t1")
            .unwrap();
        repo.set_enabled("b", true).unwrap();
        repo.set_enabled("c", true).unwrap();
        repo.set_enabled("a", false).unwrap();

        // Same account, refreshed — plus one new model, minus none.
        repo.replace_all(&[model("a"), model("b"), model("c"), model("d")], "t2")
            .unwrap();

        let enabled: Vec<_> = repo
            .list_enabled()
            .unwrap()
            .into_iter()
            .map(|m| m.model_id)
            .collect();
        assert_eq!(enabled, vec!["b", "c"], "choices must survive a refresh");

        let fresh = repo.list().unwrap();
        assert!(
            !fresh.iter().find(|m| m.model_id == "d").unwrap().enabled,
            "a newly appeared model stays off rather than flooding the selector"
        );
    }

    #[test]
    fn a_model_the_account_dropped_does_not_resurrect_its_flag() {
        let conn = db();
        let repo = CursorModelsRepository::new(&conn);
        repo.replace_all(&[model("gone"), model("stays")], "t1")
            .unwrap();
        repo.set_enabled("gone", true).unwrap();
        repo.set_enabled("stays", true).unwrap();

        // Dropped upstream…
        repo.replace_all(&[model("stays")], "t2").unwrap();
        // …then back later. Its old flag belonged to a different catalogue.
        repo.replace_all(&[model("stays"), model("gone")], "t3")
            .unwrap();

        let enabled: Vec<_> = repo
            .list_enabled()
            .unwrap()
            .into_iter()
            .map(|m| m.model_id)
            .collect();
        assert_eq!(enabled, vec!["stays"]);
    }

    /// Connecting and then finding nothing selectable reads as broken.
    #[test]
    fn the_first_populate_switches_on_the_accounts_top_model() {
        let conn = db();
        let repo = CursorModelsRepository::new(&conn);
        repo.replace_all(&[model("top"), model("second"), model("third")], "t1")
            .unwrap();

        let enabled: Vec<_> = repo
            .list_enabled()
            .unwrap()
            .into_iter()
            .map(|m| m.model_id)
            .collect();
        assert_eq!(enabled, vec!["top"]);
    }

    /// …but a user who deliberately turned everything off keeps it that way.
    #[test]
    fn a_deliberately_empty_selection_is_not_re_seeded() {
        let conn = db();
        let repo = CursorModelsRepository::new(&conn);
        repo.replace_all(&[model("a"), model("b")], "t1").unwrap();
        repo.set_enabled("a", false).unwrap();
        assert_eq!(repo.list_enabled().unwrap().len(), 0);

        repo.replace_all(&[model("a"), model("b")], "t2").unwrap();

        assert_eq!(
            repo.list_enabled().unwrap().len(),
            0,
            "re-seeding here would override an explicit choice"
        );
    }

    #[test]
    fn toggling_reports_whether_the_model_exists() {
        let conn = db();
        let repo = CursorModelsRepository::new(&conn);
        repo.replace_all(&[model("real")], "t1").unwrap();

        assert!(repo.set_enabled("real", true).unwrap());
        assert!(
            !repo.set_enabled("ghost", true).unwrap(),
            "a stale UI toggling a removed model must be told, not ignored"
        );
    }

    #[test]
    fn bulk_toggle_applies_to_every_named_model() {
        let conn = db();
        let repo = CursorModelsRepository::new(&conn);
        let all = vec![model("a"), model("b"), model("c")];
        repo.replace_all(&all, "t1").unwrap();

        let ids: Vec<String> = all.iter().map(|m| m.model_id.clone()).collect();
        assert_eq!(repo.set_enabled_bulk(&ids, true).unwrap(), 3);
        assert_eq!(repo.list_enabled().unwrap().len(), 3);

        assert_eq!(repo.set_enabled_bulk(&ids, false).unwrap(), 3);
        assert_eq!(repo.list_enabled().unwrap().len(), 0);
    }

    #[test]
    fn the_provider_page_sees_everything_the_selector_sees_only_enabled() {
        let conn = db();
        let repo = CursorModelsRepository::new(&conn);
        let many: Vec<CursorModel> = (0..204).map(|i| model(&format!("m{i}"))).collect();
        repo.replace_all(&many, "t1").unwrap();
        repo.set_enabled_bulk(&["m7".to_string(), "m42".to_string()], true)
            .unwrap();

        assert_eq!(
            repo.list().unwrap().len(),
            204,
            "provider page: all of them"
        );
        let selectable: Vec<_> = repo
            .list_enabled()
            .unwrap()
            .into_iter()
            .map(|m| m.model_id)
            .collect();
        // m0 was auto-enabled by the first populate, plus the two chosen.
        assert_eq!(selectable, vec!["m0", "m7", "m42"]);
    }

    #[test]
    fn replace_all_stores_and_preserves_upstream_order() {
        let conn = db();
        let repo = CursorModelsRepository::new(&conn);
        let models = vec![model("composer-2.5"), model("gpt-5.2"), model("auto")];

        assert_eq!(
            repo.replace_all(&models, "2026-08-22T00:00:00Z").unwrap(),
            3
        );

        let listed = repo.list().unwrap();
        let ids: Vec<_> = listed.iter().map(|m| m.model_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["composer-2.5", "gpt-5.2", "auto"],
            "the account's own ranking must survive the round trip"
        );
    }

    #[test]
    fn a_refresh_drops_models_the_account_lost() {
        let conn = db();
        let repo = CursorModelsRepository::new(&conn);
        repo.replace_all(&[model("old-a"), model("old-b")], "t1")
            .unwrap();

        repo.replace_all(&[model("new-only")], "t2").unwrap();

        let ids: Vec<_> = repo
            .list()
            .unwrap()
            .into_iter()
            .map(|m| m.model_id)
            .collect();
        assert_eq!(ids, vec!["new-only"]);
        assert_eq!(repo.fetched_at().unwrap().as_deref(), Some("t2"));
    }

    /// A failed RPC must not empty the picker.
    #[test]
    fn an_empty_refresh_leaves_the_catalogue_alone() {
        let conn = db();
        let repo = CursorModelsRepository::new(&conn);
        repo.replace_all(&[model("keep-me")], "t1").unwrap();

        let kept = repo.replace_all(&[], "t2").unwrap();

        assert_eq!(kept, 1);
        assert_eq!(repo.count().unwrap(), 1);
        assert_eq!(
            repo.fetched_at().unwrap().as_deref(),
            Some("t1"),
            "a refusal to write must not advance the refresh timestamp"
        );
    }

    #[test]
    fn aliases_and_flags_round_trip() {
        let conn = db();
        let repo = CursorModelsRepository::new(&conn);
        let rich = CursorModel {
            model_id: "claude-opus-5-thinking-high".into(),
            display_model_id: Some("claude-opus-5".into()),
            display_name: Some("Claude Opus 5 (Thinking, High)".into()),
            display_name_short: Some("Opus 5".into()),
            aliases: vec!["opus-5".into(), "opus".into()],
            supports_thinking: true,
            max_mode: true,
            // First populate switches on the top-ranked model, so the row that
            // comes back is this one with `enabled` flipped.
            enabled: true,
            sort_order: 0,
        };
        repo.replace_all(&[rich.clone()], "t1").unwrap();

        let listed = repo.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], rich);
    }

    #[test]
    fn fast_variants_are_recognised_and_paired_with_their_base() {
        let fast = model("cursor-grok-4.6-high-fast");
        let base = model("cursor-grok-4.6-high");

        assert!(fast.is_fast());
        assert!(!base.is_fast());
        assert_eq!(
            fast.base_model_id(),
            base.base_model_id(),
            "the pair must group under one row in the provider page"
        );
        assert_eq!(base.base_model_id(), "cursor-grok-4.6-high");
    }

    /// `-fast` is a suffix, not a substring: a model merely containing the
    /// word must not be mistaken for a variant.
    #[test]
    fn fast_is_matched_as_a_suffix_only() {
        assert!(!model("fast-model-x").is_fast());
        assert!(!model("gpt-fastball").is_fast());
        assert_eq!(model("fast-model-x").base_model_id(), "fast-model-x");
    }

    #[test]
    fn pairing_halves_a_catalogue_of_twins() {
        let conn = db();
        let repo = CursorModelsRepository::new(&conn);
        let models = vec![
            model("cursor-grok-4.6-high"),
            model("cursor-grok-4.6-high-fast"),
            model("gpt-5.2"),
            model("gpt-5.2-fast"),
        ];
        repo.replace_all(&models, "t1").unwrap();

        let bases: std::collections::BTreeSet<String> = repo
            .list()
            .unwrap()
            .iter()
            .map(|m| m.base_model_id().to_string())
            .collect();
        assert_eq!(bases.len(), 2, "four rows collapse to two real models");
    }

    /// The composer's Fast toggle, end to end.
    /// Capability comes from models.dev, so the job here is producing the
    /// vendor's own id out of Cursor's decorated one.
    #[test]
    fn catalog_keys_strip_cursors_decorations() {
        for (cursor_id, expected) in [
            ("claude-opus-5-thinking-high", "claude-opus-5"),
            ("claude-opus-5-thinking-high-fast", "claude-opus-5"),
            ("claude-sonnet-5-xhigh", "claude-sonnet-5"),
            ("gpt-5.2", "gpt-5.2"),
            ("gpt-5.3-codex-low", "gpt-5.3-codex"),
            ("cursor-grok-4.6-high", "grok-4.6"),
            ("gemini-3.7-flash-medium", "gemini-3.7-flash"),
            ("composer-2.5", "composer-2.5"),
        ] {
            assert_eq!(
                model(cursor_id).catalog_key().as_deref(),
                Some(expected),
                "{cursor_id}"
            );
        }
    }

    /// `auto` routes to whichever model Cursor picks, so there is no single
    /// entry to look its capabilities up in.
    #[test]
    fn the_router_model_has_no_catalog_entry() {
        assert_eq!(model("default").catalog_key(), None);
        assert_eq!(model("cursor-default").catalog_key(), None);
        assert_eq!(model("auto").catalog_key(), None);
    }

    #[test]
    fn older_generations_are_marked_legacy() {
        for id in [
            "gpt-4o",          // 4.0 < 5
            "gpt-4.1",         // 4.1 < 5
            "claude-4-sonnet", // 4.0 < 4.5, version-first spelling
            "claude-4.1-opus", // 4.1 < 4.5
            "claude-opus-4-1", // 4.1 < 4.5, tier-first spelling
        ] {
            assert!(model(id).is_legacy(), "{id} should be hidden by default");
        }
    }

    /// Real ids from a live account. 4.6 and 4.8 both clear the 4.5 floor —
    /// reading their dashes as a plain `4` would bury two current models.
    #[test]
    fn dash_versioned_current_models_stay_visible() {
        assert!(!model("claude-sonnet-4-6-medium").is_legacy());
        assert!(!model("claude-opus-4-8-high").is_legacy());
        assert!(!model("claude-opus-4-7-thinking-xhigh").is_legacy());
    }

    /// The floor is inclusive: 4.5 is the oldest Sonnet/Opus that stays.
    #[test]
    fn the_generation_floor_is_inclusive() {
        assert!(!model("claude-4.5-opus-high").is_legacy());
        assert!(!model("claude-opus-4-5").is_legacy());
        assert!(model("claude-4.1-opus").is_legacy());
        assert!(!model("gpt-5").is_legacy());
        assert!(model("gpt-4.9").is_legacy());
    }

    #[test]
    fn current_generations_are_not_legacy() {
        for id in [
            "gpt-5.2",
            "gpt-5.3-codex-high",
            "gpt-5.6-sol-high",
            "claude-sonnet-5-thinking-high",
            "claude-opus-5-max",
            "cursor-grok-4.6-high",
            "composer-2.5",
            "default",
        ] {
            assert!(!model(id).is_legacy(), "{id} should stay visible");
        }
    }

    /// A rule that guessed at families it was not written for would hide
    /// models on a vendor Cursor adds next month.
    #[test]
    fn unknown_families_are_never_hidden() {
        assert!(!model("gemini-2.0-flash").is_legacy());
        assert!(!model("deepseek-v3").is_legacy());
        assert!(!model("some-new-vendor-model-1").is_legacy());
    }

    #[test]
    fn version_parsing_handles_the_shapes_cursor_ships() {
        assert!(below_version("4.1-mini", 5.0));
        assert!(below_version("4-sonnet", 4.5));
        assert!(!below_version("5.3-codex", 5.0));
        assert!(!below_version("5", 5.0));
        // Unparseable is not old.
        assert!(!below_version("sonnet-latest", 5.0));
        assert!(!below_version("", 5.0));
    }

    /// Cursor writes the same version two ways. Reading `4-5` as plain `4` is
    /// how Opus 4.5 gets hidden as though it were Opus 4.
    #[test]
    fn a_dash_between_numbers_is_a_decimal_point() {
        assert_eq!(below_version("4-5", 4.5), false, "4-5 is 4.5, not 4.0");
        assert_eq!(below_version("4-8-high", 4.5), false, "4-8 is 4.8");
        assert!(below_version("4-1", 4.5), "4-1 is 4.1");
        // Both spellings must agree.
        assert_eq!(below_version("4-5", 4.5), below_version("4.5", 4.5));
    }

    #[test]
    fn clear_empties_the_catalogue_on_sign_out() {
        let conn = db();
        let repo = CursorModelsRepository::new(&conn);
        repo.replace_all(&[model("a"), model("b")], "t1").unwrap();

        repo.clear().unwrap();

        assert_eq!(repo.count().unwrap(), 0);
        assert!(repo.fetched_at().unwrap().is_none());
    }
}
