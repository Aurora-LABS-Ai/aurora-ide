//! Probe CLI. Exists to make the index measurable by hand; the eventual
//! in-app surface is a set of agent tools, not a binary.
//!
//!   code-index build   <root> [--out <file>]   build + report
//!   code-index def     <name> [--index <file>]
//!   code-index refs    <name> [--index <file>]
//!   code-index callers <name> [--index <file>]
//!   code-index outline <path-substring>
//!   code-index dead    [--exported-only]
//!   code-index stats

use anyhow::{bail, Result};
use code_index::CodeIndex;
use std::path::PathBuf;

const DEFAULT_INDEX: &str = "code-index.json";

fn flag(args: &[String], name: &str) -> Option<String> {
    let i = args.iter().position(|a| a == name)?;
    args.get(i + 1).cloned()
}

fn has(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn load(args: &[String]) -> Result<CodeIndex> {
    let path = flag(args, "--index").unwrap_or_else(|| DEFAULT_INDEX.to_string());
    CodeIndex::load(&PathBuf::from(path))
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first().map(String::as_str) else {
        bail!("usage: code-index <build|def|refs|callers|outline|dead|stats> [args]");
    };
    let arg1 = args.get(1).cloned().unwrap_or_default();

    match cmd {
        "build" => {
            if arg1.is_empty() || arg1.starts_with("--") {
                bail!("usage: code-index build <root> [--out <file>]");
            }
            let out = flag(&args, "--out").unwrap_or_else(|| DEFAULT_INDEX.to_string());
            let idx = CodeIndex::build(&PathBuf::from(&arg1))?;
            let bytes = idx.save(&PathBuf::from(&out))?;
            report(&idx, &out, bytes);
        }
        "def" => {
            let idx = load(&args)?;
            let defs = idx.definitions(&arg1);
            if defs.is_empty() {
                println!("no definition of `{arg1}` in the index");
            }
            for s in defs {
                let vis = if s.exported { "pub " } else { "" };
                println!(
                    "{vis}{:<10} {:<40} {}:{}",
                    s.kind,
                    s.qualified(),
                    idx.file_path(s.file),
                    s.line
                );
            }
        }
        "refs" => {
            let idx = load(&args)?;
            let refs = idx.references(&arg1);
            println!("{} references to `{arg1}`", refs.len());
            for r in refs.iter().take(60) {
                println!(
                    "  {:<7} {}:{:<5} in {}",
                    r.kind,
                    idx.file_path(r.file),
                    r.line,
                    r.from.as_deref().unwrap_or("<top level>")
                );
            }
            if refs.len() > 60 {
                println!("  … {} more (narrow with `callers`)", refs.len() - 60);
            }
        }
        "callers" => {
            let idx = load(&args)?;
            let defs = idx.definitions(&arg1);
            let callers = idx.callers(&arg1);
            println!(
                "`{arg1}` — {} definition(s), {} distinct caller(s)",
                defs.len(),
                callers.len()
            );
            if defs.len() > 1 {
                println!("  ! ambiguous name; edges below may belong to any of:");
                for s in &defs {
                    println!("      {} at {}:{}", s.qualified(), idx.file_path(s.file), s.line);
                }
            }
            for (who, n) in callers.iter().take(40) {
                println!("  {n:>3}x  {who}");
            }
        }
        "outline" => {
            let idx = load(&args)?;
            let mut last = "";
            for (path, s) in idx.outline(&arg1) {
                if path != last {
                    println!("\n{path}");
                    last = path;
                }
                let vis = if s.exported { "*" } else { " " };
                println!("  {vis} {:<10} {:<4} {}", s.kind, s.line, s.qualified());
            }
        }
        "dead" => {
            let idx = load(&args)?;
            let exported_only = has(&args, "--exported-only");
            let dead: Vec<_> = idx
                .unreferenced()
                .into_iter()
                .filter(|s| !exported_only || s.exported)
                .collect();
            println!(
                "{} unreferenced definitions (candidates — dynamic dispatch, macro \
                 and cross-workspace use are invisible to a syntax index)",
                dead.len()
            );
            for s in dead.iter().take(50) {
                println!(
                    "  {:<10} {:<40} {}:{}",
                    s.kind,
                    s.qualified(),
                    idx.file_path(s.file),
                    s.line
                );
            }
        }
        "stats" => {
            let idx = load(&args)?;
            report(&idx, "(loaded)", 0);
        }
        other => bail!("unknown command `{other}`"),
    }
    Ok(())
}

fn report(idx: &CodeIndex, out: &str, bytes: u64) {
    let s = &idx.stats;
    let r = &s.resolution;
    let total_refs = (r.unique + r.ambiguous + r.external).max(1);
    let pct = |n: usize| (n as f64 * 100.0 / total_refs as f64).round();

    println!("root          {}", idx.root.display());
    println!(
        "files         {} ({:.1} MB of source)",
        s.files,
        s.bytes as f64 / 1_048_576.0
    );
    println!(
        "skipped       {} generated/minified, {} too large",
        s.skipped_generated, s.skipped_too_large
    );
    if !s.skipped_dirs.is_empty() {
        println!("excluded dirs {}", s.skipped_dirs.join(", "));
    }
    println!("symbols       {}", s.symbols);
    println!("references    {}", s.refs);
    println!(
        "resolution    {} unique ({}%) · {} ambiguous ({}%) · {} external ({}%)",
        r.unique,
        pct(r.unique),
        r.ambiguous,
        pct(r.ambiguous),
        r.external,
        pct(r.external)
    );
    println!(
        "parse errors  {} file(s) needed error recovery",
        s.files_with_parse_errors
    );
    println!(
        "build         {} ms  ({:.1} files/s)",
        s.build_ms,
        s.files as f64 / (s.build_ms.max(1) as f64 / 1000.0)
    );
    if bytes > 0 {
        println!(
            "index         {} ({:.1} MB json, {:.0}% of source size)",
            out,
            bytes as f64 / 1_048_576.0,
            bytes as f64 * 100.0 / s.bytes.max(1) as f64
        );
    }
}
