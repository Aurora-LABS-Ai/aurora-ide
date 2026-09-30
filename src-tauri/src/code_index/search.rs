//! Ranked local text search, followed by syntax-aware source extraction.
//! Scores rank word matches; they are never probabilities or call relationships.
use super::{jobs::IndexSettings, lang::{Lang, LangSet}, store::CodeIndex};
use anyhow::Result;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

fn words(text: &str) -> Vec<String> {
    let mut separated = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    for (i, &ch) in chars.iter().enumerate() {
        if ch.is_uppercase() && i > 0 && (chars[i-1].is_lowercase()
            || (chars[i-1].is_uppercase() && chars.get(i+1).is_some_and(|c| c.is_lowercase()))) { separated.push(' '); }
        separated.push(if ch.is_alphanumeric() { ch } else { ' ' });
    }
    separated.split_whitespace().map(str::to_lowercase).collect()
}

struct Candidate { file: usize, source: String, counts: HashMap<String, usize>, length: usize, score: f64 }

pub fn query(index: &CodeIndex, query: &str, in_file: Option<&str>, settings: &IndexSettings) -> Result<Value> {
    settings.validate()?;
    anyhow::ensure!(query.len() <= 1_000, "Search query must be at most 1,000 bytes.");
    let terms: HashSet<String> = words(query).into_iter().collect();
    anyhow::ensure!(!terms.is_empty() && terms.len() <= 32, "Use between 1 and 32 search words.");
    let mut candidates = Vec::new(); let mut frequency: HashMap<String, usize> = HashMap::new();
    let mut total_length = 0; let mut scanned = 0; let mut bytes = 0usize;
    let mut skipped = Vec::new(); let mut limited = false;
    for (id, file) in index.files.iter().enumerate() {
        if in_file.is_some_and(|filter| !file.path.contains(filter)) { continue; }
        let path = index.root.join(&file.path);
        let source = match super::incremental::read_source(&path) {
            Ok(source) => source,
            Err(error) => { skipped.push(json!({"path":file.path,"reason":error.to_string()})); continue; }
        };
        if super::incremental::hash(&source) != file.content_hash {
            skipped.push(json!({"path":file.path,"reason":"Source changed during search; retry the query."})); continue;
        }
        bytes += source.len();
        if bytes > 128 * 1024 * 1024 { limited = true; break; }
        scanned += 1;
        let tokens = words(&source); total_length += tokens.len();
        let mut counts = HashMap::new();
        for token in &tokens { if terms.contains(token) { *counts.entry(token.clone()).or_insert(0) += 1; } }
        // File names participate, but are explicitly identified in output.
        for token in words(&file.path) { if terms.contains(&token) { *counts.entry(token).or_insert(0) += 1; } }
        for term in counts.keys() { *frequency.entry(term.clone()).or_insert(0usize) += 1; }
        if !counts.is_empty() { candidates.push(Candidate { file: id, source, counts, length: tokens.len(), score: 0.0 }); }
    }
    let average = (total_length as f64 / scanned.max(1) as f64).max(1.0);
    let exact_files: HashSet<usize> = index.symbols.iter().filter(|s| s.name.eq_ignore_ascii_case(query.trim())).map(|s| s.file as usize).collect();
    for candidate in &mut candidates {
        for (term, &count) in &candidate.counts {
            let df = *frequency.get(term).unwrap_or(&0) as f64;
            let idf = (1.0 + (scanned as f64 - df + 0.5) / (df + 0.5)).ln();
            let tf = count as f64;
            candidate.score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * candidate.length as f64 / average));
        }
        // A query naming a declaration should find its owning file first.
        if exact_files.contains(&candidate.file) { candidate.score += 8.0; }
        candidate.score *= candidate.counts.len() as f64 / terms.len() as f64;
    }
    candidates.sort_by(|a,b| b.score.total_cmp(&a.score).then(index.files[a.file].path.cmp(&index.files[b.file].path)));
    let matches = candidates.len(); let mut results = Vec::new(); let mut remaining = settings.search_bytes;
    let langs = LangSet::new()?; let mut parser = tree_sitter::Parser::new();
    for candidate in candidates.into_iter().take(settings.search_results) {
        let file = &index.files[candidate.file];
        // Do not publish a snippet for a file edited/deleted after ranking.
        if super::incremental::read_source(&index.root.join(&file.path)).ok().as_deref() != Some(candidate.source.as_str()) {
            skipped.push(json!({"path":file.path,"reason":"Source changed during search; retry the query."})); continue;
        }
        let lines: Vec<&str> = candidate.source.lines().collect();
        let hit = lines.iter().enumerate().max_by_key(|(line, text)| {
            let hits = words(text).into_iter().filter(|w| terms.contains(w)).collect::<HashSet<_>>().len();
            (hits, std::cmp::Reverse(*line))
        }).map_or(0, |(i,_)| i);
        let mut start = hit.saturating_sub(4); let mut end = (hit+9).min(lines.len()); let mut kind = "excerpt";
        let mut parse_error = file.had_parse_error;
        if let Some(lang) = Lang::from_path(std::path::Path::new(&file.path)) {
            parser.set_language(&langs.spec(lang).language)?;
            if let Some(tree) = parser.parse(&candidate.source, None) {
                parse_error = tree.root_node().has_error();
                let lower = lines.get(hit).unwrap_or(&"").to_lowercase();
                let column = terms.iter().filter_map(|term| lower.find(term)).min().unwrap_or(0);
                if let Some(node) = tree.root_node().descendant_for_point_range(tree_sitter::Point::new(hit,column), tree_sitter::Point::new(hit,column)) {
                    let mut current = Some(node);
                    while let Some(node) = current {
                        if matches!(node.kind(), "function_item" | "function_declaration" | "function_definition" | "method_definition" | "method_declaration" | "constructor_declaration" | "method" | "singleton_method" | "arrow_function" | "function_expression") {
                            start = node.start_position().row;
                            end = (node.end_position().row + usize::from(node.end_position().column > 0)).min(lines.len());
                            kind = "function"; break;
                        }
                        current = node.parent();
                    }
                }
            }
        }
        let full_end = end;
        let original_start = start;
        let per_result = remaining.min(8_000);
        let mut text = String::new(); let mut actual_end = start;
        for line in &lines[start..end] {
            let needed = line.len() + usize::from(!text.is_empty());
            if text.len() + needed > per_result { break; }
            if !text.is_empty() { text.push('\n'); } text.push_str(line); actual_end += 1;
        }
        // Long functions must include the matching line, not just their header.
        if actual_end <= hit && hit >= start && hit < full_end {
            start = hit.saturating_sub(2).max(start); text.clear(); actual_end = start; kind = "excerpt";
            for line in &lines[start..full_end] {
                if text.len()+line.len()+1 > per_result { break; }
                if !text.is_empty() { text.push('\n'); } text.push_str(line); actual_end += 1;
            }
        }
        if text.is_empty() { limited = true; continue; }
        end = actual_end; remaining -= text.len();
        // Terms are credited to the passage the reader gets, not to the file it
        // was cut from. The file-wide list let `add()` be labelled as matching
        // "stock" when the only "stock" sat in `remove()` further down — false
        // evidence an agent cannot tell from true evidence.
        let in_passage: HashSet<String> = words(&text).into_iter().filter(|w| terms.contains(w)).collect();
        let in_name: HashSet<String> = words(&file.path).into_iter().filter(|w| terms.contains(w)).collect();
        let mut matched: Vec<_> = in_passage.iter().cloned().collect(); matched.sort();
        let mut matched_in_name: Vec<_> = in_name.iter().cloned().collect(); matched_in_name.sort();
        let mut elsewhere: Vec<_> = candidate.counts.keys().filter(|t| !in_passage.contains(*t) && !in_name.contains(*t)).cloned().collect(); elsewhere.sort();
        results.push(json!({"path":file.path,"startLine":start+1,"endLine":end,"text":text,
            "kind":kind,"truncated":start>original_start || end<full_end,"parseError":parse_error,
            "matchedTerms":matched,"matchedInFileName":matched_in_name,"matchedElsewhereInFile":elsewhere,"score":candidate.score}));
        if remaining == 0 { limited = true; break; }
    }
    let skipped_count = skipped.len(); skipped.truncate(20);
    Ok(json!({"success":true,"op":"search","query":query,"matches":matches,
        "truncated":limited || results.len()<matches,"results":results,"scannedFiles":scanned,
        "skippedFiles":skipped,"skippedFileCount":skipped_count,"coverageGap":index.coverage_gap(),
        "coverageLimited":limited || skipped_count>0 || index.coverage_gap().is_some(),
        "notice":"Ranked word matches in source code and file names. matchedTerms are the query words in the returned text; matchedElsewhereInFile are words the file has outside it, and the score ranks the whole file. Scores indicate relevance, not confirmed relationships. Unsupported languages and ignored/generated files are excluded. Missing matches do not prove code is absent."}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "set AURORA_INDEX_ROOT to run a read-only real-project measurement"]
    fn real_project_search_and_incremental_measurement() {
        let root = std::path::PathBuf::from(std::env::var("AURORA_INDEX_ROOT").unwrap());
        let start = std::time::Instant::now();
        let index = CodeIndex::build(&root).unwrap();
        println!("initial: {} files, {} symbols, {}ms", index.stats.files, index.stats.symbols, start.elapsed().as_millis());
        let updated = CodeIndex::build_incremental(&root,Some(&index),&|_,_,_|{}).unwrap();
        println!("unchanged rebuild: {} files reused, {}ms", updated.stats.reused_files, updated.stats.build_ms);
        for text in ["refresh token", "sender guard", "search messages", "theme store"] {
            let start = std::time::Instant::now();
            let result = query(&updated,text,None,&IndexSettings::default()).unwrap();
            let paths: Vec<_> = result["results"].as_array().unwrap().iter().map(|row| row["path"].as_str().unwrap()).collect();
            println!("{text}: {}ms {paths:?}",start.elapsed().as_millis());
        }
    }
    #[test]
    fn searches_identifier_words_returns_real_functions_and_never_serves_stale_text() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("auth.ts");
        std::fs::write(&path, "export function refreshSession() {\n  return renewToken();\n}\nfunction unrelated() {}\n").unwrap();
        let index = CodeIndex::build(dir.path()).unwrap();
        let result = query(&index, "refresh session", None, &IndexSettings::default()).unwrap();
        assert_eq!(result["results"][0]["path"], "auth.ts");
        assert_eq!(result["results"][0]["endLine"], 3);
        assert!(result["results"][0]["text"].as_str().unwrap().contains("return renewToken"));
        assert_eq!(query(&index,"absentneedle",None,&IndexSettings::default()).unwrap()["matches"], 0);
        std::fs::write(&path,"export function removed() {}\n").unwrap();
        let stale = query(&index,"refresh",None,&IndexSettings::default()).unwrap();
        assert!(stale["results"].as_array().unwrap().is_empty());
        assert_eq!(stale["coverageLimited"], true);
        std::fs::remove_file(path).unwrap();
        assert_eq!(query(&index,"refresh",None,&IndexSettings::default()).unwrap()["coverageLimited"], true);
    }
    /// Issue 2 of the 2026-09-28 harness report: `add()` came back labelled as
    /// matching "stock" when the only "stock" in the file was in `remove()`.
    #[test]
    fn matched_terms_name_the_words_in_the_passage_not_the_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("inventory.ts"),
            "export function add(quantity: number) {\n  if (quantity < 0) throw new Error(\"negative\");\n}\n\nexport function remove() {\n  return stock;\n}\n",
        )
        .unwrap();
        let index = CodeIndex::build(dir.path()).unwrap();
        let result = query(&index, "stock quantity negative", None, &IndexSettings::default()).unwrap();
        let first = &result["results"][0];
        assert_eq!(first["kind"], "function");
        assert!(first["text"].as_str().unwrap().starts_with("export function add"), "{first}");
        assert_eq!(first["matchedTerms"], json!(["negative", "quantity"]));
        assert_eq!(first["matchedElsewhereInFile"], json!(["stock"]));
        assert_eq!(first["matchedInFileName"], json!([]));
    }

    #[test]
    fn splitting_and_output_budget_are_explicit() {
        assert_eq!(words("HTTPServer refresh_token"), ["http","server","refresh","token"]);
        let dir = tempfile::tempdir().unwrap();
        let source = format!("function work() {{\n{}\nneedle();\n}}", "let item = 1;\n".repeat(1000));
        std::fs::write(dir.path().join("large.ts"),source).unwrap();
        let index = CodeIndex::build(dir.path()).unwrap();
        let settings = IndexSettings { search_bytes: 2_000, ..Default::default() };
        let result = query(&index,"needle",None,&settings).unwrap();
        let text = result["results"][0]["text"].as_str().unwrap();
        assert!(text.len()<=2_000 && text.contains("needle"));
        assert_eq!(result["results"][0]["kind"],"excerpt");
    }
}
