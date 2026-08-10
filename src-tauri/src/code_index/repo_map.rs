//! Renders a built index as the `<repo_map>` block handed to the model.
//!
//! This is **data, not instruction**. It never goes in the system prompt: the
//! system prompt is how-to-behave text that is identical for every project,
//! while this is a set of facts about one specific workspace. It rides in the
//! conversation the same way `<steering_context>` does.
//!
//! The entire value is in what it LEAVES OUT. A dump of 21,000 symbols is worse
//! than nothing — it would cost more context than the files it was meant to
//! save. So the map is aggressively filtered and hard-capped, and when it drops
//! something it says so rather than trailing off (a truncation that does not
//! name itself reads as "this is the whole project").

use super::store::{CodeIndex, Symbol};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Default ceiling for the rendered block, in TOKENS.
///
/// Expressed in tokens rather than bytes because that is the resource actually
/// being spent, and because the number has to be reasoned about against the
/// model's context window. 5k buys the shape of a whole repository for roughly
/// what one medium source file costs to read.
pub const DEFAULT_BUDGET_TOKENS: usize = 5_000;

/// Hard ceiling regardless of configuration. Past this the map stops being
/// orientation and starts being a second copy of the codebase — at which point
/// the `code` tool is strictly better, because it answers the actual question
/// instead of paying for 40k tokens of names on every single turn.
pub const MAX_BUDGET_TOKENS: usize = 10_000;

/// Aurora's standing estimate elsewhere (`1 token ~ 4 chars`). Exact tokenizer
/// counting would need the model's encoding, and being a few percent out on a
/// budget this size changes nothing.
const CHARS_PER_TOKEN: usize = 4;

/// Convert a token budget to the character budget `render` works in.
pub fn budget_chars(tokens: usize) -> usize {
    tokens.min(MAX_BUDGET_TOKENS) * CHARS_PER_TOKEN
}

/// Kinds worth naming in a map. Variables, fields, consts and enum variants are
/// deliberately excluded: they are the bulk of the symbol table and almost
/// never what someone needs to locate a piece of behaviour.
fn is_landmark(kind: &str) -> bool {
    matches!(
        kind,
        "class" | "struct" | "interface" | "trait" | "enum" | "function" | "method" | "type"
    )
}

/// Types before functions, so a file reads as "what it defines" rather than
/// alphabetically.
fn kind_order(kind: &str) -> u8 {
    match kind {
        "class" | "struct" | "interface" | "trait" => 0,
        "enum" | "type" => 1,
        _ => 2,
    }
}

/// How much a symbol of this kind suggests "architecture" rather than
/// "vocabulary". A class or struct is a unit of behaviour someone built the
/// system around; a bag of type aliases usually is not, however often it is
/// imported.
fn kind_weight(kind: &str) -> f64 {
    match kind {
        "class" | "struct" => 4.0,
        "trait" => 3.0,
        "interface" | "enum" | "function" => 2.0,
        _ => 1.0,
    }
}

/// Lines a single directory may claim before every other directory has had a
/// chance. Measured on a real 594-file Electron app (156 directories):
/// cap 2 covers 63 directories in a 5k-token budget where an uncapped sort
/// covers 49 — and orientation is exactly the job breadth does.
const DIR_CAP: usize = 2;

/// Room held back for the closing tag and the "N more omitted" notice, both of
/// which are written after selection has finished spending. Without it the
/// block overshoots its own budget by its footer — measured at 20,068 chars
/// against a 20,000 budget on a real 594-file repository.
const FOOTER_RESERVE: usize = 128;

fn dir_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[..i],
        None => ".",
    }
}

fn file_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[i + 1..],
        None => path,
    }
}

/// Build the block. Returns `None` when the workspace has nothing worth
/// mapping — an empty `<repo_map>` is noise, so nothing is emitted at all.
pub fn render(idx: &CodeIndex, budget: usize) -> Option<String> {
    // Group landmark symbols by file, keeping only what a reader would call a
    // definition of something.
    let mut by_file: BTreeMap<&str, Vec<&Symbol>> = BTreeMap::new();
    for s in &idx.symbols {
        if !s.exported || !is_landmark(&s.kind) {
            continue;
        }
        // A method is already implied by its class; listing both doubles the
        // map for no new information. Methods appear only in the parenthesised
        // tail of their container's line, below.
        if s.kind == "method" {
            continue;
        }
        by_file.entry(idx.file_path(s.file)).or_default().push(s);
    }
    if by_file.is_empty() {
        return None;
    }

    // Methods, keyed by the container they belong to, so a class line can carry
    // a short preview of what it does.
    let mut methods: BTreeMap<(&str, &str), Vec<&str>> = BTreeMap::new();
    for s in &idx.symbols {
        if s.kind == "method" && s.exported {
            if let Some(c) = &s.container {
                methods
                    .entry((idx.file_path(s.file), c.as_str()))
                    .or_default()
                    .push(&s.name);
            }
        }
    }

    // Which distinct FILES reach for each name. Distinct files, not raw
    // mentions: a helper called five times in one file is one consumer, not
    // five.
    let mut ref_files: HashMap<&str, HashSet<u32>> = HashMap::new();
    for r in &idx.refs {
        ref_files.entry(r.name.as_str()).or_default().insert(r.file);
    }

    // What "worth knowing about" actually means, measured against the live
    // failure — a large Electron app's central orchestrator class:
    //
    // Two rankings shipped wrong before this one. Counting exported landmarks
    // lost the file that exports exactly ONE thing — the class at the heart of
    // the app. Counting inbound references put the Tailwind `cn()` helper and
    // shared `types.ts` bags on top, because a singleton is constructed once
    // and used through an instance: utility noise outranks architecture.
    //
    // Three changes fix it, verified against the real index (rank 219 → 10):
    //
    // 1. **Behaviour counts.** Every exported method adds a point — a class
    //    with 45 methods IS the architecture whether or not its name appears
    //    in many files.
    // 2. **Kinds are weighted.** A class outranks a type alias at the same
    //    fan-in; fan-in itself is log-damped and counted in distinct files.
    // 3. **Aggregation is concave.** Per-symbol scores are summed with 1/n
    //    decay, so a file is judged by its strongest symbols and a bag of
    //    twenty similar types cannot out-sum one central class.
    // Commits per file, for the volatility term below.
    let churn_of: HashMap<&str, u32> = idx
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.churn))
        .collect();

    let file_score = |path: &str, syms: &[&Symbol]| -> f64 {
        let mut parts: Vec<f64> = syms
            .iter()
            .map(|s| {
                let fan_in = ref_files.get(s.name.as_str()).map_or(0, HashSet::len);
                let mut p = kind_weight(&s.kind) * (1.0 + (1.0 + fan_in as f64).ln());
                if let Some(ms) = methods.get(&(path, s.name.as_str())) {
                    p += ms.len() as f64;
                }
                p
            })
            .collect();
        parts.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
        let structural: f64 = parts
            .iter()
            .enumerate()
            .map(|(i, p)| p / (i as f64 + 1.0))
            .sum();

        // Recently-worked-on code is likelier to be what the next question is
        // about, and a file that is both depended upon AND changing often is
        // where the risk lives. Deliberately a gentle MULTIPLIER, not an
        // additive term: churn should reorder files of similar importance, not
        // let a busy config file outrank an architectural class. A workspace
        // with no git history has churn 0 everywhere, so the factor is exactly
        // 1.0 and ranking falls back to structure alone.
        let commits = churn_of.get(path).copied().unwrap_or(0) as f64;
        structural * (1.0 + 0.15 * (1.0 + commits).ln())
    };

    let mut files: Vec<(&str, Vec<&Symbol>, f64)> = by_file
        .into_iter()
        .map(|(path, syms)| {
            let score = file_score(path, &syms);
            (path, syms, score)
        })
        .collect();
    files.sort_by(|a, b| {
        b.2.partial_cmp(&a.2)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(b.0))
    });

    let mut out = String::from("<repo_map>\n");
    out.push_str(&format!(
        "{} files, {} symbols. Landmarks only — use the `code` tool for anything not listed.\n",
        idx.stats.files, idx.stats.symbols
    ));

    // Pre-render every candidate line once; selection needs the exact cost.
    let lines: Vec<String> = files
        .iter()
        .map(|(path, syms, _)| {
            let mut syms = syms.clone();
            syms.sort_by_key(|s| (kind_order(&s.kind), s.line));
            let mut names: Vec<String> = Vec::new();
            for s in syms.iter().take(8) {
                let mut entry = format!("{} {}", s.kind, s.name);
                if let Some(ms) = methods.get(&(*path, s.name.as_str())) {
                    let preview: Vec<&str> = ms.iter().take(4).copied().collect();
                    let more = if ms.len() > preview.len() {
                        ", …"
                    } else {
                        ""
                    };
                    entry.push_str(&format!(" ({}{})", preview.join(", "), more));
                }
                names.push(entry);
            }
            if syms.len() > 8 {
                names.push(format!("+{} more", syms.len() - 8));
            }
            format!("  {}  {}\n", file_of(path), names.join(" · "))
        })
        .collect();

    // Selection in two passes over the score order. Pass 1 lets no directory
    // take more than `DIR_CAP` lines, so every area of the codebase surfaces
    // before any area goes deep — a map that names one file from each of 60
    // directories orients better than one that details 3 directories. Pass 2
    // refills whatever budget is left ignoring the cap, so a small or flat
    // repository (one directory, plenty of room) is not starved by a rule
    // built for large ones.
    let budget = budget.saturating_sub(FOOTER_RESERVE);

    let mut used = out.len();
    let mut taken: Vec<bool> = vec![false; files.len()];
    let mut dirs_open: HashSet<&str> = HashSet::new();
    let mut per_dir: HashMap<&str, usize> = HashMap::new();
    for capped in [true, false] {
        for (i, (path, _, _)) in files.iter().enumerate() {
            if taken[i] {
                continue;
            }
            let dir = dir_of(path);
            if capped && per_dir.get(dir).copied().unwrap_or(0) >= DIR_CAP {
                continue;
            }
            let cost = lines[i].len()
                + if dirs_open.contains(dir) {
                    0
                } else {
                    dir.len() + 2
                };
            if used + cost > budget {
                continue;
            }
            used += cost;
            taken[i] = true;
            dirs_open.insert(dir);
            *per_dir.entry(dir).or_default() += 1;
        }
    }

    let mut rendered: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    let mut dropped = 0usize;
    for (i, (path, _, _)) in files.iter().enumerate() {
        if taken[i] {
            rendered
                .entry(dir_of(path))
                .or_default()
                .push(lines[i].clone());
        } else {
            dropped += 1;
        }
    }

    for (dir, lines) in rendered {
        out.push_str(&format!("{dir}/\n"));
        for l in lines {
            out.push_str(&l);
        }
    }
    if dropped > 0 {
        out.push_str(&format!(
            "… {dropped} more file(s) omitted for space — ask with `code` if you need them.\n"
        ));
    }
    out.push_str("</repo_map>");
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(files: &[(&str, &str)]) -> (tempfile::TempDir, CodeIndex) {
        let dir = tempfile::tempdir().unwrap();
        for (name, body) in files {
            let p = dir.path().join(name);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
        let idx = CodeIndex::build(dir.path()).unwrap();
        (dir, idx)
    }

    #[test]
    fn names_types_and_their_methods_but_not_private_or_trivial_symbols() {
        let (_d, idx) = build(&[(
            "src/session.rs",
            "pub struct Session;\nimpl Session {\n pub fn append(&self) {}\n pub fn flush(&self) {}\n}\nstruct Hidden;\npub const CAP: u8 = 4;\n",
        )]);
        let map = render(&idx, budget_chars(DEFAULT_BUDGET_TOKENS)).expect("a map");

        assert!(map.contains("struct Session"), "{map}");
        assert!(map.contains("append"), "methods preview the class: {map}");
        assert!(!map.contains("Hidden"), "private types stay out: {map}");
        assert!(!map.contains("CAP"), "consts are not landmarks: {map}");
        assert!(map.starts_with("<repo_map>") && map.ends_with("</repo_map>"));
    }

    #[test]
    fn the_budget_is_honoured_and_the_omission_is_stated() {
        let files: Vec<(String, String)> = (0..60)
            .map(|i| {
                (
                    format!("src/mod{i}.ts"),
                    format!("export class Service{i} {{ run() {{}} }}\n"),
                )
            })
            .collect();
        let refs: Vec<(&str, &str)> = files
            .iter()
            .map(|(a, b)| (a.as_str(), b.as_str()))
            .collect();
        let (_d, idx) = build(&refs);

        // The budget is a ceiling on the WHOLE block, footer included — an
        // earlier version measured only the file lines and overshot by its own
        // closing tag and omission notice (caught rendering a real 594-file
        // repository: 20,068 chars against a 20,000 budget).
        for budget in [400, 700, 1500, 4000] {
            let map = render(&idx, budget).expect("a map");
            assert!(
                map.len() <= budget,
                "budget {budget} produced {} chars",
                map.len()
            );
        }
        let map = render(&idx, 700).expect("a map");
        assert!(
            map.contains("more file(s) omitted"),
            "a silent cut reads as a complete map: {map}"
        );
    }

    #[test]
    fn a_heavily_used_single_export_outranks_a_file_full_of_unused_ones() {
        // The live failure this fixes: the class at the centre of the app
        // exported one symbol, ranked last, and fell off the end of the map.
        let mut files: Vec<(String, String)> = (0..30)
            .map(|i| {
                (
                    format!("src/noise{i}.ts"),
                    format!(
                        "export type Unused{i} = string;
"
                    ),
                )
            })
            .collect();
        files.push((
            "src/core.ts".into(),
            "export class Orchestrator { run() {} }
"
            .into(),
        ));
        // Twelve files reach for Orchestrator; nothing touches the noise types.
        for i in 0..12 {
            files.push((
                format!("src/user{i}.ts"),
                "import { Orchestrator } from './core';
export function go() { new Orchestrator(); }
"
                .into(),
            ));
        }
        let refs: Vec<(&str, &str)> = files
            .iter()
            .map(|(a, b)| (a.as_str(), b.as_str()))
            .collect();
        let (_d, idx) = build(&refs);

        // A budget too small for everything: what survives is what matters.
        let map = render(&idx, 420).expect("a map");
        assert!(
            map.contains("Orchestrator"),
            "the most-referenced symbol must survive a tight budget: {map}"
        );
    }

    #[test]
    fn a_class_with_behaviour_outranks_a_bag_of_referenced_types() {
        // The second live failure: ranking by inbound references put shared
        // `types.ts` bags and the `cn()` helper on top while the 45-method
        // orchestrator class ranked 219th. Behaviour must beat vocabulary.
        let mut files: Vec<(String, String)> = vec![
            (
                "src/core.ts".into(),
                "export class Orchestrator { m0() {} m1() {} m2() {} m3() {} m4() {} m5() {} }\n"
                    .into(),
            ),
            (
                "src/types.ts".into(),
                "export type A = 1;\nexport type B = 2;\nexport type C = 3;\n".into(),
            ),
            (
                "src/use_core.ts".into(),
                "import { Orchestrator } from './core';\nnew Orchestrator();\n".into(),
            ),
        ];
        // The type bag is imported far more widely than the class — exactly
        // the shape that fooled the inbound-reference ranking.
        for i in 0..6 {
            files.push((
                format!("src/use_types{i}.ts"),
                "import { A, B, C } from './types';\n".into(),
            ));
        }
        let refs: Vec<(&str, &str)> = files
            .iter()
            .map(|(a, b)| (a.as_str(), b.as_str()))
            .collect();
        let (_d, idx) = build(&refs);

        // Budget for exactly one file line (plus the footer reserve): the
        // survivor must be the class.
        let map = render(&idx, 170 + FOOTER_RESERVE).expect("a map");
        assert!(
            map.contains("Orchestrator"),
            "the behaviour-bearing class must survive a tight budget: {map}"
        );
        assert!(
            !map.contains("type A"),
            "the widely-imported type bag must not displace it: {map}"
        );
    }

    #[test]
    fn every_directory_surfaces_before_one_directory_goes_deep() {
        // Breadth: a map that names one file from many areas orients better
        // than one that details a single area. Directory `a` has four strong
        // files; a pure score sort would spend the whole budget there and
        // `b/beacon.ts` — the only file of its area — would never appear.
        let mut files: Vec<(String, String)> = (0..4)
            .map(|i| {
                (
                    format!("a/svc{i}.ts"),
                    format!("export class Svc{i} {{ run() {{}} stop() {{}} }}\n"),
                )
            })
            .collect();
        files.push(("b/beacon.ts".into(), "export function beacon() {}\n".into()));
        let refs: Vec<(&str, &str)> = files
            .iter()
            .map(|(a, b)| (a.as_str(), b.as_str()))
            .collect();
        let (_d, idx) = build(&refs);

        // Fits about three file lines — fewer than directory `a` could fill.
        let map = render(&idx, 320 + FOOTER_RESERVE).expect("a map");
        assert!(
            map.contains("beacon"),
            "the only file of area `b` must surface before `a` goes deep: {map}"
        );
    }

    #[test]
    fn a_flat_single_directory_repo_fills_past_the_breadth_cap() {
        // The refill pass: DIR_CAP exists for repositories with many
        // directories, and must not starve a small flat one where everything
        // lives in `src/`.
        let files: Vec<(String, String)> = (0..5)
            .map(|i| {
                (
                    format!("src/part{i}.ts"),
                    format!("export class Part{i} {{ go() {{}} }}\n"),
                )
            })
            .collect();
        let refs: Vec<(&str, &str)> = files
            .iter()
            .map(|(a, b)| (a.as_str(), b.as_str()))
            .collect();
        let (_d, idx) = build(&refs);

        let map = render(&idx, budget_chars(DEFAULT_BUDGET_TOKENS)).expect("a map");
        for i in 0..5 {
            assert!(
                map.contains(&format!("Part{i}")),
                "with room to spare every file appears, cap or no cap: {map}"
            );
        }
    }

    /// Measurement harness, not a CI test. Renders the map for a real
    /// workspace so ranking changes can be judged against a real repository
    /// rather than a fixture:
    ///
    /// ```text
    /// AURORA_INDEX_ROOT=E:/some/repo \
    ///   cargo test --lib repo_map_over_a_real_workspace -- --ignored --nocapture
    /// ```
    ///
    /// Builds from source rather than loading a cache, so it cannot be fooled
    /// by a stale file written before a format change.
    #[test]
    #[ignore = "needs AURORA_INDEX_ROOT pointing at a real workspace"]
    fn repo_map_over_a_real_workspace() {
        let root = std::env::var("AURORA_INDEX_ROOT").expect("set AURORA_INDEX_ROOT");
        let idx = CodeIndex::build(std::path::Path::new(&root)).unwrap();
        let map = render(&idx, budget_chars(DEFAULT_BUDGET_TOKENS)).expect("a map");
        let files = map.lines().filter(|l| l.starts_with("  ")).count();
        let dirs = map.lines().filter(|l| l.ends_with('/')).count();
        println!("{map}");
        println!(
            "\n== {files} file lines across {dirs} directories, {} chars of {} budget ==",
            map.len(),
            budget_chars(DEFAULT_BUDGET_TOKENS)
        );
    }

    #[test]
    fn a_workspace_with_no_public_api_produces_no_block_at_all() {
        // An empty <repo_map> is pure cost: it occupies context and tells the
        // model nothing it did not already know.
        let (_d, idx) = build(&[("src/x.rs", "fn private_only() {}\n")]);
        assert!(render(&idx, budget_chars(DEFAULT_BUDGET_TOKENS)).is_none());
    }
}
