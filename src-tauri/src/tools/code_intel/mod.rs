//! `code` — symbol-level questions about the workspace.
//!
//! One tool with a typed `op` rather than three tool names, matching the `todo`
//! precedent. Every tool's schema is re-sent on every request, so each new name
//! is a permanent per-turn cost; three closely-related lookups do not earn
//! three entries in the catalogue.
//!
//! It is a **complement to `grep`, not a replacement**. `grep` finds text and
//! is right whenever the target is text (a string literal, a comment, a config
//! key, a TODO). `code` finds definitions and usages, and is right whenever the
//! target is a symbol — where grep returns every comment and string that
//! happens to contain the word.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor, ToolRegistry};
use crate::code_index::store::CodeIndex;

pub const TOOL_NAMES: &[&str] = &["code"];

/// Caps on what one call may return. The index can answer "every reference to
/// `get`" with 500 rows; pouring that into the context is worse than not
/// answering, so results are bounded and the cut is always stated.
const MAX_ROWS: usize = 40;
const MAX_OUTLINE_ROWS: usize = 200;

pub struct CodeTool;

fn workspace_of(ctx: &ToolContext) -> Result<std::path::PathBuf, ToolError> {
    ctx.workspace_root.clone().ok_or_else(|| {
        ToolError::InvalidInput(
            "No workspace is open, so there is no code to index. Open a folder in Aurora first."
                .into(),
        )
    })
}

fn index_for(ctx: &ToolContext) -> Result<Arc<CodeIndex>, ToolError> {
    let workspace = workspace_of(ctx)?;
    crate::code_index::service()
        .get_or_build(&workspace)
        .map_err(|e| {
            // Never a bare failure: the model needs to know the fallback exists,
            // or it will retry this tool instead of reaching for `grep`.
            ToolError::Execution(format!(
                "Could not build the code index for {}: {e:#}. Use `grep` for this search instead.",
                workspace.display()
            ))
        })
}

fn required_name(input: &Value, op: &str) -> Result<String, ToolError> {
    input
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            ToolError::InvalidInput(format!(
                "`{op}` needs a `name` — the function, class, type or method to look up."
            ))
        })
}

/// `in_file` narrows here too, and must.
///
/// Observed live: the model sent `in_file` to `definition` three times in one
/// turn, got every homonym back because only `usages` honoured it, and then
/// told the user it had "resolved the ambiguity by restricting the search to
/// that one file". A parameter the schema advertises but the runtime
/// ignores does not merely fail — it makes the caller narrate a filter that
/// never ran. Any option offered at the top of a schema is offered to every op
/// that could plausibly use it.
fn op_definition(idx: &CodeIndex, name: &str, in_file: Option<&str>) -> Value {
    let all = idx.definitions(name);
    let fragment = in_file.map(str::trim).filter(|f| !f.is_empty());
    let defs: Vec<_> = match fragment {
        Some(f) => all
            .iter()
            .copied()
            .filter(|s| idx.file_path(s.file).contains(f))
            .collect(),
        None => all.clone(),
    };

    if defs.is_empty() {
        // Distinguish "no such symbol" from "not in the file you named" — they
        // demand different corrections, and collapsing them would send the
        // caller looking for a symbol that does exist.
        let message = match fragment {
            Some(f) if !all.is_empty() => format!(
                "`{name}` is defined in this workspace, but not in any file matching `{f}`. \
                 Drop `in_file` to see all {} definition(s).",
                all.len()
            ),
            // The coverage gap OUTRANKS the dependency guess. Both are
            // plausible, only one is checkable, and guessing "dependency" at a
            // symbol that is actually defined in an unread language is the
            // answer that gets acted on and is wrong.
            _ => match idx.coverage_gap() {
                Some(gap) => format!(
                    "No definition of `{name}` among the files this index reads. {gap}. It may \
                     also come from a dependency or be built by a macro or string name. `grep` \
                     searches every file regardless of language."
                ),
                None => format!(
                    "No definition of `{name}` in this workspace. It may come from a dependency, \
                     be built by a macro or string name, or simply not exist. `grep` will find it \
                     if it is only mentioned in text."
                ),
            },
        };
        return json!({
            "success": true,
            "op": "definition",
            "name": name,
            "found": 0,
            "message": message,
        });
    }

    let mut out = json!({
        "success": true,
        "op": "definition",
        "name": name,
        "found": defs.len(),
        "definitions": defs.iter().take(MAX_ROWS).map(|s| json!({
            "symbol": s.qualified(),
            "kind": s.kind,
            "file": idx.file_path(s.file),
            "line": s.line,
            "exported": s.exported,
        })).collect::<Vec<_>>(),
    });
    // Say that a filter ran and what it hid, so the count cannot be read as
    // "this is every definition of the name".
    if fragment.is_some() && all.len() > defs.len() {
        out["filteredBy"] = json!(fragment);
        out["alsoDefinedElsewhere"] = json!(all.len() - defs.len());
    }
    out
}

/// Plain-English name for a reference kind, for the coupling breakdown.
///
/// One undifferentiated "47 usages" hides the thing the reader needs most:
/// 47 calls is a normal contract, while 12 writes from outside means other
/// modules are reaching past whatever interface this one intended. They demand
/// different responses to the same total.
fn coupling_label(kind: &str) -> &'static str {
    match kind {
        "call" => "calls",
        "write" => "writes (reaches past the interface)",
        "jsx" => "rendered as a component",
        "macro" => "macro invocations",
        "type" => "type references",
        "import" => "imports",
        _ => "reads",
    }
}

/// Order the breakdown by how much a reader should care, not alphabetically.
fn coupling_order(kind: &str) -> u8 {
    match kind {
        "write" => 0,
        "call" => 1,
        "jsx" => 2,
        "macro" => 3,
        "type" => 4,
        "import" => 5,
        _ => 6,
    }
}

/// Kinds that something can meaningfully *call* or *construct*.
///
/// `variable`, `field`, `const` and `variant` are excluded on purpose. A name
/// like `handle` is 23 struct fields and locals in a real codebase; asking who
/// "calls" it is a category error, and answering with a merged list of every
/// read of every unrelated `handle` looks authoritative while being nonsense.
const CALLABLE_KINDS: &[&str] = &[
    "function",
    "method",
    "class",
    "struct",
    "trait",
    "interface",
    "enum",
    "type",
    "macro",
];

fn is_callable_kind(kind: &str) -> bool {
    CALLABLE_KINDS.contains(&kind)
}

/// Would re-asking with a qualified name NARROW this candidate set?
///
/// Only if the candidates do not all share one qualified name. A C++ class
/// declared in several headers, or a set of module-level functions with no
/// container, all answer to the same string — and a suggestion that reproduces
/// the same ambiguous query is worse than no suggestion, because it reads as a
/// way out and costs an iteration. Reported live: nine candidates for one
/// class, every one carrying an identical `ask`.
///
/// **This is the single source for that judgement.** The refusal message and
/// the per-candidate `ask` both read it, so the prose can never point at a
/// field that is not there — which is the shape of the bug being fixed.
fn qualified_narrows(defs: &[&crate::code_index::store::Symbol]) -> bool {
    let mut quals: Vec<String> = defs.iter().map(|s| s.qualified()).collect();
    quals.sort_unstable();
    quals.dedup();
    quals.len() > 1
}

/// The choices, each carrying how many callers it actually has.
///
/// The count is what makes this list actionable rather than a shrug: given
/// three `save` functions, "12 callers / 3 callers / 0 callers" usually
/// identifies the one the caller meant, and it is now cheap to compute because
/// each reference resolves to a specific definition.
fn candidate_list(idx: &CodeIndex, defs: &[&crate::code_index::store::Symbol]) -> Value {
    let shown: Vec<&crate::code_index::store::Symbol> =
        defs.iter().take(MAX_ROWS).copied().collect();

    let qualified_narrows = qualified_narrows(&shown);

    json!(shown
        .iter()
        .map(|s| {
            let (hits, _) = idx.references_to(s);
            // Imports excluded for the same reason as in `op_usages`: they are
            // wiring, and counting them would make every candidate in a
            // TypeScript codebase look one busier than it is.
            let used = hits.iter().filter(|r| r.kind != "import").count();
            let file = idx.file_path(s.file);
            json!({
                "symbol": s.qualified(),
                "kind": s.kind,
                "file": file,
                "line": s.line,
                "callers": used,
                // Only offered when it genuinely narrows the set.
                "ask": if qualified_narrows {
                    s.container.as_ref().map(|c| format!("{c}::{}", s.name))
                } else {
                    None
                },
                // Always present, and always distinct, because a file path is
                // the one thing every candidate has that the others do not.
                // This is the value to pass as `in_file`.
                "in_file": file,
            })
        })
        .collect::<Vec<_>>())
}

/// Who uses this symbol?
///
/// Refuses to answer when the question is unanswerable as asked. An advisory
/// "this might be ambiguous" field does not work — verified live against a real
/// codebase, where the model received exactly such a field for a name with 23
/// definitions, dropped it, and presented 27 merged callers as though they
/// belonged to one function. A caveat the caller can ignore is not a safeguard,
/// so ambiguity is now a structural refusal that names the way forward.
fn op_usages(idx: &CodeIndex, name: &str, in_file: Option<&str>) -> Value {
    let defs = idx.definitions(name);
    let qualified = name.contains("::");
    let mut callable: Vec<_> = defs
        .iter()
        .copied()
        .filter(|s| is_callable_kind(&s.kind))
        .collect();
    let homonyms = defs.len() - callable.len();

    // `in_file` is how a caller picks between homonyms that no qualified name
    // can separate — seven module-level `handle` functions in seven files.
    if let Some(fragment) = in_file.map(str::trim).filter(|f| !f.is_empty()) {
        let narrowed: Vec<_> = callable
            .iter()
            .copied()
            .filter(|s| idx.file_path(s.file).contains(fragment))
            .collect();
        if narrowed.is_empty() {
            return json!({
                "success": true,
                "op": "usages",
                "name": name,
                "resolved": false,
                "reason": "no_such_definition",
                "message": format!(
                    "No definition of `{name}` in a file matching `{fragment}`. The candidates are \
                     listed — use one of their `file` values."
                ),
                "candidates": candidate_list(idx, &callable),
            });
        }
        callable = narrowed;
    }

    if defs.is_empty() {
        return json!({
            "success": true,
            "op": "usages",
            "name": name,
            "resolved": false,
            "reason": "not_defined_here",
            // Read carefully before editing: this is the answer that ends
            // "so there are no callers, the refactor is safe". It must never
            // sound more certain than it is.
            "message": match idx.coverage_gap() {
                Some(gap) => format!(
                    "`{name}` is not defined among the files this index reads, so its usages \
                     cannot be attributed. {gap}. Do not read this as \"nothing calls it\" — \
                     `grep` searches every file regardless of language."
                ),
                None => format!(
                    "`{name}` is not defined in this workspace, so its usages cannot be \
                     attributed. It may come from a dependency. `grep` will find the text if you \
                     need it."
                ),
            },
        });
    }

    // Nothing callable under this name — the question does not apply.
    if callable.is_empty() {
        return json!({
            "success": true,
            "op": "usages",
            "name": name,
            "resolved": false,
            "reason": "not_callable",
            "message": format!(
                "`{name}` names {} field(s)/variable(s) in this workspace, not a function or \
                 type. Nothing calls it. If you meant a property, `grep` is the right tool.",
                defs.len()
            ),
            "definitions": candidate_list(idx, &defs),
        });
    }

    // Several distinct callables share the name. Which one the CALLER meant is
    // a question only they can answer — but each one's usages are now
    // individually answerable, so the list carries a caller count per
    // candidate instead of being a bare shrug.
    if !qualified && callable.len() > 1 {
        // Having a container is NOT enough — the qualified names must actually
        // differ. Seven module-level `handle` functions have no container at
        // all (a real case), and nine C++ candidates for one class have the
        // same container as each other (another). Both end up pointed at
        // `in_file`, which is the route that exists in every case.
        let qualifiable = qualified_narrows(&callable.iter().copied().collect::<Vec<_>>());
        let how = if qualifiable {
            "one of the qualified names in `candidates[].ask`, or `in_file` set to a candidate's \
             `file`"
        } else {
            "`in_file` set to one of the candidates' `file` values"
        };
        return json!({
            "success": true,
            "op": "usages",
            "name": name,
            "resolved": false,
            "reason": "ambiguous",
            "qualifiable": qualifiable,
            "message": format!(
                "`{name}` names {} different definitions here, so \"who calls it\" has no single \
                 answer. Each candidate's own caller count is listed. Re-ask with {how}.",
                callable.len()
            ),
            "candidates": candidate_list(idx, &callable),
        });
    }

    // Resolved usages: every reference is tied back to a definition through the
    // importing file's own import statements, so callers of a same-named
    // function in another module are not counted here.
    let target = callable[0];
    let (resolved, unresolved) = idx.references_to(target);

    // An `import` is wiring, not a use: it is what makes the call possible,
    // and counting it puts a `<top level of …>` row against every importing
    // file while inflating the total by one per file. The fact is still worth
    // reporting, so it is reported as its own number.
    let (imports, uses): (Vec<&crate::code_index::store::Reference>, Vec<_>) =
        resolved.into_iter().partition(|r| r.kind == "import");

    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for r in &uses {
        let who = r
            .from
            .clone()
            .unwrap_or_else(|| format!("<top level of {}>", idx.file_path(r.file)));
        *counts.entry(who).or_default() += 1;
    }
    let mut callers: Vec<_> = counts.into_iter().collect();
    callers.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));

    let files: std::collections::BTreeSet<&str> = uses
        .iter()
        .chain(imports.iter())
        .map(|r| idx.file_path(r.file))
        .collect();

    // Coupling broken down by KIND. `usages: 47` is one number that can mean
    // two very different situations; this says which one it is.
    let mut by_kind: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for r in uses.iter().chain(imports.iter()) {
        *by_kind.entry(r.kind.as_str()).or_default() += 1;
    }
    let mut coupling: Vec<(&str, usize)> = by_kind.into_iter().collect();
    coupling.sort_by_key(|(k, _)| coupling_order(k));

    let hits = uses;

    let mut out = json!({
        "success": true,
        "op": "usages",
        "resolved": true,
        "name": name,
        "symbol": target.qualified(),
        "definedAt": format!("{}:{}", idx.file_path(target.file), target.line),
        "totalUsages": hits.len(),
        "distinctCallers": callers.len(),
        "acrossFiles": files.len(),
        "importedByFiles": imports.len(),
        "coupling": coupling.iter().map(|(kind, n)| json!({
            "kind": coupling_label(kind),
            "count": n,
        })).collect::<Vec<_>>(),
        "usedBy": callers.iter().take(MAX_ROWS).map(|(who, n)| json!({
            "caller": who,
            "count": n,
        })).collect::<Vec<_>>(),
    });

    if callers.len() > MAX_ROWS {
        out["truncated"] = json!(format!(
            "showing the {MAX_ROWS} most frequent of {} callers",
            callers.len()
        ));
    }
    // Usages that could not be tied to any one definition are excluded from the
    // list rather than mixed into it, and said out loud — a count that silently
    // omits work would understate a blast radius, which is the one direction
    // this answer must never fail in.
    if unresolved > 0 {
        out["note"] = json!(format!(
            "{unresolved} further mention(s) of `{}` could not be attributed to a specific \
             definition and are not counted above. `grep` will show them if the exact number \
             matters.",
            target.name
        ));
    }
    if homonyms > 0 {
        out["homonyms"] = json!(format!(
            "{homonyms} unrelated field(s)/variable(s) also carry this name.",
        ));
    }
    if hits.is_empty() {
        out["message"] = json!(format!(
            "Nothing in this workspace uses `{}`. It may still be reached dynamically, by macro, \
             or from outside the workspace — this index sees syntax only.",
            target.qualified()
        ));
    }
    out
}

/// How the workspace is wired above the level of a single symbol.
///
/// The one question the index could not answer before imports carried their
/// module: not "who calls this function" but "which parts of this project
/// depend on which". Cycles are the payload most worth having — and they are
/// deliberately reported small, because a loop spanning seventy directories
/// (measured with another tool on a real app) names no edge anyone can break.
fn op_modules(idx: &CodeIndex, granularity: Option<&str>) -> Value {
    use crate::code_index::module_graph::{build, Granularity};

    let requested = granularity.unwrap_or("dir");
    let Some(g) = Granularity::parse(requested) else {
        return json!({
            "success": false,
            "op": "modules",
            "message": format!(
                "`{requested}` is not a granularity. Use `area` (top-level areas), \
                 `dir` (default), or `file`."
            ),
        });
    };
    let graph = build(idx, g);
    if graph.nodes.is_empty() {
        return json!({
            "success": true,
            "op": "modules",
            "message": "Nothing indexed in this workspace, so there is no dependency graph.",
        });
    }

    const MAX_NODES: usize = 30;
    const MAX_CYCLES: usize = 10;
    let mut out = json!({
        "success": true,
        "op": "modules",
        "granularity": requested,
        "groups": graph.nodes.len(),
        "dependencies": graph.edges.len(),
        // Most depended-upon first — the reading order for "what is load
        // bearing here". `fanIn` counts other groups that import this one.
        "mostDependedOn": graph.nodes.iter().take(MAX_NODES).map(|n| json!({
            "name": n.name,
            "fanIn": n.fan_in,
            "fanOut": n.fan_out,
            "files": n.files,
        })).collect::<Vec<_>>(),
        "cycles": graph.cycles.iter().take(MAX_CYCLES).map(|c| match c.summarized_size {
            Some(size) => json!({
                "size": size,
                "sample": c.members,
                "note": "too large to list — this many groups are mutually dependent",
            }),
            None => json!({ "size": c.members.len(), "members": c.members }),
        }).collect::<Vec<_>>(),
    });
    if graph.nodes.len() > MAX_NODES {
        out["truncated"] = json!(format!(
            "showing the {MAX_NODES} most depended-upon of {} groups",
            graph.nodes.len()
        ));
    }
    if graph.cycles.is_empty() {
        out["cyclesNote"] = json!("No dependency cycles at this granularity.");
    }
    out
}

fn op_outline(idx: &CodeIndex, path: &str) -> Value {
    let rows = idx.outline(path);
    if rows.is_empty() {
        // Outline is the one operation handed a PATH, so it can name the exact
        // reason instead of describing the index's state. "No indexed file
        // matches" is true and useless when the file is sitting right there and
        // only its language is unsupported.
        let unreadable = std::path::Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .filter(|ext| crate::code_index::Lang::from_extension(ext).is_none());
        let message = match unreadable {
            Some(ext) => format!(
                "`{path}` is not a language this index reads (`.{ext}`) — {}. Use `grep` or \
                 `file_read` for this file.",
                crate::code_index::Lang::UNINDEXED_HINT
            ),
            None => format!(
                "No indexed file matches `{path}`. Check the path, or `code {{ op: \"refresh\" }}` \
                 if it was just created."
            ),
        };
        return json!({
            "success": true,
            "op": "outline",
            "path": path,
            "symbols": 0,
            "message": message,
        });
    }
    let shown = rows.len().min(MAX_OUTLINE_ROWS);
    let mut out = json!({
        "success": true,
        "op": "outline",
        "path": path,
        "symbols": rows.len(),
        "outline": rows.iter().take(MAX_OUTLINE_ROWS).map(|(p, s)| json!({
            "file": p,
            "line": s.line,
            "kind": s.kind,
            "symbol": s.qualified(),
            "exported": s.exported,
        })).collect::<Vec<_>>(),
    });
    if rows.len() > shown {
        out["truncated"] = json!(format!(
            "showing {shown} of {} symbols — narrow `path` to a single file",
            rows.len()
        ));
    }
    out
}

/// Force a rebuild and report what changed.
///
/// The index already re-checks the tree before every answer, so this is a
/// belt-and-braces control rather than the primary mechanism: the automatic
/// check compares modification times, which have one-second resolution, so an
/// edit landing in the same second as the previous newest file can slip past
/// it. Calling this after a batch of edits closes that window.
fn op_refresh(ctx: &ToolContext) -> Result<Value, ToolError> {
    let workspace = workspace_of(ctx)?;
    let idx = crate::code_index::service()
        .rebuild(&workspace)
        .map_err(|e| ToolError::Execution(format!("Could not rebuild the code index: {e:#}")))?;
    Ok(json!({
        "success": true,
        "op": "refresh",
        "files": idx.stats.files,
        "symbols": idx.stats.symbols,
        "buildMs": idx.stats.build_ms,
        "message": format!(
            "Index rebuilt from {} files ({} symbols) in {} ms.",
            idx.stats.files, idx.stats.symbols, idx.stats.build_ms
        ),
    }))
}

#[async_trait]
impl ToolExecutor for CodeTool {
    fn name(&self) -> &str {
        "code"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "code".into(),
            description: "Ask where a symbol is defined, who uses it, or what a file contains — \
answered from an index of the whole workspace, not by searching text.

Use it instead of `grep` whenever you are looking for a FUNCTION, CLASS, TYPE or METHOD:
  • `definition` — where is `X` defined? One answer with the exact file and line, instead of every \
line that mentions the word.
  • `usages` — who calls `X`? The list of functions that use it, so you know what a change breaks \
before you make it.
  • `outline` — what does this file define? Names and line numbers only, so you can pick the one \
line to read instead of loading a 3000-line file.
  • `modules` — how is this project wired? Which areas depend on which, what is most depended upon, \
and which directories import each other in a circle. Use it to orient before a refactor.

Keep using `grep` for text: string literals, comments, config keys, error messages, TODOs.

It reads Rust, TypeScript/JavaScript, Python, C, C++, Go, Java, C#, Ruby, PHP, Kotlin and Swift. A \
file in any other language is not in the index at all, so a miss can mean \"not written in a \
language I read\" rather than \"does not exist\" — the answers say which. `grep` searches every \
file whatever it is written in.

Usages are resolved through each file's own import statements, so callers of a same-named function \
in another module are not counted. When one name still has several possible definitions the result \
lists them with a caller count each — re-ask with `in_file` to pick one. Do NOT choose from that \
list by eye: those entries are different symbols that merely share a name, so picking the \
biggest-looking one and carrying on produces a confident answer about the wrong code.

The index keeps itself current on its own. Call `refresh` only after creating, deleting or renaming \
several files, when the next answer has to be certain to include them.

Limits worth knowing: the index reads syntax, not types, so it cannot tell you what something \
RETURNS and will not catch type errors — use `read_lints` for that. It finds the files a change \
affects; `read_lints` is what confirms which of them actually broke."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "op": {
                        "type": "string",
                        "enum": ["definition", "usages", "outline", "modules", "refresh"],
                        "description": "Which question to ask."
                    },
                    "granularity": {
                        "type": "string",
                        "enum": ["area", "dir", "file"],
                        "description": "For `modules`: how coarsely to group. `area` = top-level areas, `dir` (default) = per directory, `file` = per file."
                    },
                    "name": {
                        "type": "string",
                        "description": "For `definition` and `usages`: the symbol. Accepts a bare name (`append`) or a qualified one (`Session::append`) — qualify it when a bare name turns out to be ambiguous."
                    },
                    "path": {
                        "type": "string",
                        "description": "For `outline`: a file path, or any part of one. A directory fragment outlines every file beneath it."
                    },
                    "in_file": {
                        "type": "string",
                        "description": "For `definition` and `usages`: pick between several definitions sharing one name by naming the file (or part of the path) that holds the one you mean. Use it when a first call returns several definitions or comes back `ambiguous`."
                    }
                },
                "required": ["op"]
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let op = input
            .get("op")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();

        // `refresh` rebuilds rather than reads, so it must not go through the
        // read path that would hand back the very index it is replacing.
        if op == "refresh" {
            return Ok(op_refresh(ctx)?.to_string());
        }

        let idx = index_for(ctx)?;
        let result = match op {
            "definition" => op_definition(
                &idx,
                &required_name(&input, "definition")?,
                input.get("in_file").and_then(Value::as_str),
            ),
            "usages" => op_usages(
                &idx,
                &required_name(&input, "usages")?,
                input.get("in_file").and_then(Value::as_str),
            ),
            "modules" => op_modules(&idx, input.get("granularity").and_then(Value::as_str)),
            "outline" => {
                let path = input
                    .get("path")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        ToolError::InvalidInput(
                            "`outline` needs a `path` — a file, or part of one.".into(),
                        )
                    })?;
                op_outline(&idx, path)
            }
            "" => {
                return Err(ToolError::InvalidInput(
                    "`code` needs an `op`: \"definition\", \"usages\", \"outline\" or \"refresh\"."
                        .into(),
                ))
            }
            other => {
                return Err(ToolError::InvalidInput(format!(
                    "Unknown op `{other}`. Valid ops are \"definition\", \"usages\", \"outline\" and \"refresh\"."
                )))
            }
        };

        Ok(result.to_string())
    }
}

pub fn register(reg: &mut ToolRegistry) {
    reg.register(Arc::new(CodeTool));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::code_index::store::CodeIndex;

    fn fixture() -> (tempfile::TempDir, CodeIndex) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("session.rs"),
            "pub struct Session;\nimpl Session {\n  pub fn append(&self) { flush(); }\n}\nfn flush() {}\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("caller.rs"),
            "fn go(s: &Session) { s.append(); }\n",
        )
        .unwrap();
        let idx = CodeIndex::build(dir.path()).unwrap();
        (dir, idx)
    }

    #[test]
    fn definition_returns_the_one_site_with_its_container() {
        let (_d, idx) = fixture();
        let v = op_definition(&idx, "append", None);
        assert_eq!(v["found"], 1);
        assert_eq!(v["definitions"][0]["symbol"], "Session::append");
        assert_eq!(v["definitions"][0]["line"], 3);
    }

    #[test]
    fn definition_honours_in_file_and_says_what_it_hid() {
        // Reproduces a live failure exactly: the model sent `in_file` to
        // `definition`, the runtime ignored it, three homonyms came back, and
        // the model reported to the user that it had "resolved the ambiguity
        // by restricting the search". The filter must actually run, and the
        // result must admit that other definitions exist.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("core")).unwrap();
        std::fs::create_dir_all(dir.path().join("ui")).unwrap();
        std::fs::write(
            dir.path().join("core/orch.ts"),
            "export class Orch { hasCapability() { return true; } }\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("ui/widget.ts"),
            "export function hasCapability() { return false; }\n",
        )
        .unwrap();
        let idx = CodeIndex::build(dir.path()).unwrap();

        assert_eq!(
            op_definition(&idx, "hasCapability", None)["found"],
            2,
            "fixture must be ambiguous without the filter"
        );

        let v = op_definition(&idx, "hasCapability", Some("core/orch.ts"));
        assert_eq!(v["found"], 1, "the filter must actually run: {v}");
        assert_eq!(v["definitions"][0]["file"], "core/orch.ts");
        assert_eq!(
            v["alsoDefinedElsewhere"], 1,
            "a narrowed count must not read as the whole truth: {v}"
        );
    }

    #[test]
    fn a_symbol_absent_from_the_named_file_is_not_reported_as_absent_entirely() {
        // Two different corrections: "that symbol does not exist" sends the
        // caller away, "it is not in THAT file" keeps them looking.
        let (_d, idx) = fixture();
        let v = op_definition(&idx, "append", Some("does/not/exist.rs"));
        assert_eq!(v["found"], 0);
        let msg = v["message"].as_str().unwrap();
        assert!(
            msg.contains("but not in any file matching"),
            "must distinguish a bad filter from a missing symbol: {msg}"
        );
    }

    #[test]
    fn a_missing_symbol_names_the_fallback_instead_of_just_failing() {
        let (_d, idx) = fixture();
        let v = op_definition(&idx, "nonexistent", None);
        assert_eq!(v["found"], 0);
        assert_eq!(
            v["success"], true,
            "absence is a normal answer, not an error"
        );
        let msg = v["message"].as_str().unwrap();
        assert!(msg.contains("grep"), "must point at the fallback: {msg}");
    }

    #[test]
    fn usages_names_the_calling_functions() {
        let (_d, idx) = fixture();
        let v = op_usages(&idx, "flush", None);
        let callers: Vec<&str> = v["usedBy"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["caller"].as_str().unwrap())
            .collect();
        assert!(
            callers.contains(&"Session::append"),
            "caller must be the qualified function, not a line number: {callers:?}"
        );
    }

    #[test]
    fn a_local_binding_is_not_reported_as_a_usage_of_a_global_same_name() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src/shell")).unwrap();
        std::fs::create_dir_all(dir.path().join("src/commands")).unwrap();
        std::fs::write(
            dir.path().join("src/shell/discovery.rs"),
            "pub fn scan() {}\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("src/commands/mod.rs"),
            "pub fn ripgrep_search() { let scan = 1; take(scan); }\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("src/commands/shell_profiles.rs"),
            "use crate::shell::discovery;\npub fn shell_profiles_scan() { discovery::scan(); }\n",
        )
        .unwrap();
        let idx = CodeIndex::build(dir.path()).unwrap();

        let v = op_usages(&idx, "scan", Some("src/shell/discovery.rs"));
        assert_eq!(v["resolved"], true, "{v}");
        assert_eq!(v["totalUsages"], 1, "the local binding must not leak: {v}");
        let callers: Vec<&str> = v["usedBy"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["caller"].as_str().unwrap())
            .collect();
        assert_eq!(callers, vec!["shell_profiles_scan"], "{v}");
    }

    #[test]
    fn usages_include_calls_through_an_import_alias() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src/a")).unwrap();
        std::fs::create_dir_all(dir.path().join("src/app")).unwrap();
        std::fs::write(
            dir.path().join("src/a/format.ts"),
            "export function formatTokens() {}\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("src/app/use.ts"),
            "import { formatTokens as fmt } from '../a/format';\nexport function go() { return fmt(1); }\n",
        )
        .unwrap();
        let idx = CodeIndex::build(dir.path()).unwrap();
        let v = op_usages(&idx, "formatTokens", Some("src/a/format.ts"));
        assert_eq!(v["resolved"], true, "{v}");
        assert_eq!(
            v["totalUsages"], 1,
            "the alias call must not disappear: {v}"
        );
        assert_eq!(
            v["importedByFiles"], 1,
            "the import is reported separately: {v}"
        );
        assert_eq!(v["usedBy"][0]["caller"], "go", "{v}");
    }

    #[test]
    fn an_ambiguous_name_refuses_to_answer_and_offers_the_choices() {
        // Found live against a real codebase: an advisory "ambiguous" FIELD was
        // simply dropped by the model, which then presented 27 merged callers of
        // 23 unrelated definitions as one confident answer. A caveat the caller
        // can ignore is not a safeguard — refusing is the only version that
        // cannot be skipped.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.rs"),
            "struct A;\nimpl A { fn run(&self) {} }\nstruct B;\nimpl B { fn run(&self) {} }\n",
        )
        .unwrap();
        let idx = CodeIndex::build(dir.path()).unwrap();
        let v = op_usages(&idx, "run", None);

        assert_eq!(v["resolved"], false, "must not answer: {v}");
        assert_eq!(v["reason"], "ambiguous");
        assert!(
            v["usedBy"].is_null(),
            "no merged caller list may be present"
        );
        let asks: Vec<&str> = v["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["ask"].as_str().unwrap())
            .collect();
        assert!(
            asks.contains(&"A::run") && asks.contains(&"B::run"),
            "{asks:?}"
        );
    }

    #[test]
    fn top_level_homonyms_are_not_told_to_qualify_a_name_that_does_not_exist() {
        // The real shape behind this: 7 module-level `handle` functions in 7
        // files. They have no container, so there IS no qualified name — the
        // first version of the refusal told the user to use one anyway.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.ts"), "export function handle() {}\n").unwrap();
        std::fs::write(dir.path().join("b.ts"), "export function handle() {}\n").unwrap();
        let idx = CodeIndex::build(dir.path()).unwrap();
        let v = op_usages(&idx, "handle", None);

        assert_eq!(v["resolved"], false);
        assert_eq!(
            v["qualifiable"], false,
            "no container means no qualified name"
        );
        let msg = v["message"].as_str().unwrap();
        assert!(
            !msg.contains("qualified name"),
            "must not send the caller after a name that cannot exist: {msg}"
        );
        assert!(
            msg.contains("in_file"),
            "must name a route that works — `in_file` is the one that exists for \
             container-less homonyms: {msg}"
        );
    }

    #[test]
    fn in_file_answers_the_question_the_ambiguity_refusal_hands_back() {
        // The refusal is only acceptable because its named way forward works.
        // Two module-level `handle` functions, each called by its own importer.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("a")).unwrap();
        std::fs::create_dir_all(dir.path().join("b")).unwrap();
        std::fs::write(dir.path().join("a/h.ts"), "export function handle() {}\n").unwrap();
        std::fs::write(dir.path().join("b/h.ts"), "export function handle() {}\n").unwrap();
        std::fs::write(
            dir.path().join("a/use.ts"),
            "import { handle } from './h';\nexport function callsA() { handle(); }\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("b/use.ts"),
            "import { handle } from './h';\nexport function callsB() { handle(); }\n",
        )
        .unwrap();
        let idx = CodeIndex::build(dir.path()).unwrap();

        let ambiguous = op_usages(&idx, "handle", None);
        assert_eq!(ambiguous["resolved"], false);
        // Each candidate reports its OWN callers, which is what makes the list
        // an answer rather than a shrug.
        let counts: Vec<u64> = ambiguous["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["callers"].as_u64().unwrap())
            .collect();
        assert_eq!(counts, vec![1, 1], "each definition has exactly one caller");

        let picked = op_usages(&idx, "handle", Some("a/h.ts"));
        assert_eq!(picked["resolved"], true, "{picked}");
        let callers: Vec<&str> = picked["usedBy"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["caller"].as_str().unwrap())
            .collect();
        assert_eq!(
            callers,
            vec!["callsA"],
            "the other module's caller must not appear: {picked}"
        );
    }

    #[test]
    fn qualifying_the_name_unblocks_the_answer() {
        // The refusal is only acceptable because the way forward it names works.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.rs"),
            "struct A;\nimpl A { fn run(&self) {} }\nstruct B;\nimpl B { fn run(&self) {} }\nfn go(a: &A) { a.run(); }\n",
        )
        .unwrap();
        let idx = CodeIndex::build(dir.path()).unwrap();
        let v = op_usages(&idx, "A::run", None);
        assert_eq!(v["resolved"], true, "a qualified name must resolve: {v}");
        assert_eq!(v["symbol"], "A::run");
    }

    #[test]
    fn a_name_that_is_only_fields_and_locals_is_not_a_call_question() {
        // The real `handle` case: 23 definitions, not one of them callable.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.rs"),
            "struct W { handle: u32 }\nstruct V { handle: u64 }\nfn use_it(w: &W) { let _ = w.handle; }\n",
        )
        .unwrap();
        let idx = CodeIndex::build(dir.path()).unwrap();
        let v = op_usages(&idx, "handle", None);
        assert_eq!(v["resolved"], false, "{v}");
        assert_eq!(v["reason"], "not_callable");
        let msg = v["message"].as_str().unwrap();
        assert!(
            msg.contains("grep"),
            "must name the right tool instead: {msg}"
        );
    }

    #[test]
    fn a_homonym_field_is_disclosed_and_does_not_pollute_the_call_count() {
        // One real function plus an unrelated field of the same name. The call
        // count now excludes the field (a call site can only mean something
        // callable), and the collision is still disclosed so the reader knows
        // the name is overloaded in this workspace.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.rs"),
            "struct Cfg { reset: bool }\nfn reset() {}\nfn go() { reset(); }\n",
        )
        .unwrap();
        let idx = CodeIndex::build(dir.path()).unwrap();
        let v = op_usages(&idx, "reset", None);
        assert_eq!(v["resolved"], true, "{v}");
        assert!(
            v["homonyms"].is_string(),
            "the name collision must be disclosed: {v}"
        );
        assert_eq!(
            v["totalUsages"], 1,
            "only the call counts — the field declaration is not a usage: {v}"
        );
    }

    #[test]
    fn modules_reports_what_is_depended_on_and_names_a_real_cycle() {
        let dir = tempfile::tempdir().unwrap();
        for (p, body) in [
            ("src/core/engine.ts", "export class Engine { run() {} }\n"),
            (
                "src/ui/panel.ts",
                "import { Engine } from '../core/engine';\nexport const p = new Engine();\n",
            ),
            (
                "src/a/one.ts",
                "import { Two } from '../b/two';\nexport class One { go() { return Two; } }\n",
            ),
            (
                "src/b/two.ts",
                "import { One } from '../a/one';\nexport class Two { go() { return One; } }\n",
            ),
        ] {
            let f = dir.path().join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, body).unwrap();
        }
        let idx = CodeIndex::build(dir.path()).unwrap();

        let v = op_modules(&idx, None);
        assert_eq!(v["success"], true, "{v}");
        assert_eq!(v["granularity"], "dir", "dir is the default");
        let top = v["mostDependedOn"].as_array().unwrap();
        assert!(
            top.iter()
                .any(|n| n["name"] == "src/core" && n["fanIn"] == 1),
            "the imported directory must report its fan-in: {v}"
        );
        let cycles = v["cycles"].as_array().unwrap();
        assert_eq!(cycles.len(), 1, "one real loop: {v}");
        assert_eq!(
            cycles[0]["size"], 2,
            "and it is small enough to act on: {v}"
        );
    }

    #[test]
    fn an_unknown_granularity_names_the_valid_ones() {
        let (_d, idx) = fixture();
        let v = op_modules(&idx, Some("galaxy"));
        assert_eq!(v["success"], false);
        let msg = v["message"].as_str().unwrap();
        assert!(
            msg.contains("area") && msg.contains("dir") && msg.contains("file"),
            "{msg}"
        );
    }

    #[test]
    fn usages_breaks_coupling_down_by_kind() {
        // One number cannot separate "everyone calls it" from "everyone
        // assigns to it", and those need different reactions.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.ts"),
            "export function tally() {}\nexport function go(o) { tally(); o.tally = 1; }\n",
        )
        .unwrap();
        let idx = CodeIndex::build(dir.path()).unwrap();
        let v = op_usages(&idx, "tally", None);
        assert_eq!(v["resolved"], true, "{v}");
        let kinds: Vec<&str> = v["coupling"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["kind"].as_str().unwrap())
            .collect();
        assert!(kinds.iter().any(|k| k.contains("calls")), "{v}");
        assert!(
            kinds.iter().any(|k| k.contains("writes")),
            "a write must be listed apart from a call: {v}"
        );
        assert_eq!(
            kinds[0], "writes (reaches past the interface)",
            "writes read first: {v}"
        );
    }

    #[test]
    fn outline_lists_symbols_without_the_file_body() {
        let (_d, idx) = fixture();
        let v = op_outline(&idx, "session.rs");
        assert!(v["symbols"].as_u64().unwrap() >= 2);
        let kinds: Vec<&str> = v["outline"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["kind"].as_str().unwrap())
            .collect();
        assert!(
            kinds.contains(&"struct") && kinds.contains(&"function"),
            "{kinds:?}"
        );
    }

    /// A workspace whose real work is in a language this index cannot read.
    fn unreadable_fixture() -> (tempfile::TempDir, CodeIndex) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(
            dir.path().join("grid.dart"),
            "class PianoRollGrid {\n  void paint() {}\n}\n",
        )
        .unwrap();
        let idx = CodeIndex::build(dir.path()).unwrap();
        (dir, idx)
    }

    #[test]
    fn an_ambiguity_refusal_never_suggests_a_query_that_returns_the_same_set() {
        // Reported live: nine candidates for one C++ class, every one carrying
        // the SAME `ask` string, so following the advice re-ran the identical
        // ambiguous call. A suggested next step that cannot narrow anything is
        // worse than none — it reads as a way out and costs an iteration.
        let dir = tempfile::tempdir().unwrap();
        // Three same-named top-level functions: no containers, so no qualified
        // name can separate them.
        for (name, body) in [
            ("a.rs", "pub fn render() {}\n"),
            ("b.rs", "pub fn render() {}\n"),
            ("c.rs", "pub fn render() {}\nfn go() { render(); }\n"),
        ] {
            std::fs::write(dir.path().join(name), body).unwrap();
        }
        let idx = CodeIndex::build(dir.path()).unwrap();

        let v = op_usages(&idx, "render", None);
        let candidates = v["candidates"].as_array().expect("candidates listed");
        assert!(candidates.len() >= 3, "{v}");

        for c in candidates {
            assert!(
                c["ask"].is_null(),
                "a qualified name that cannot narrow the set must not be offered: {c}"
            );
            // The escape that DOES work is always present and always distinct.
            assert!(
                c["in_file"].as_str().is_some_and(|f| !f.is_empty()),
                "every candidate needs a usable `in_file`: {c}"
            );
        }

        let files: Vec<&str> = candidates
            .iter()
            .filter_map(|c| c["in_file"].as_str())
            .collect();
        let mut unique = files.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(
            unique.len(),
            files.len(),
            "`in_file` only helps if it differs per candidate: {files:?}"
        );
    }

    #[test]
    fn a_qualified_name_is_still_offered_when_it_does_narrow_the_set() {
        // The counterpart: withholding `ask` everywhere would throw away the
        // cheaper escape in the case it actually resolves.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.rs"),
            "struct A;\nimpl A { pub fn run(&self) {} }\nstruct B;\nimpl B { pub fn run(&self) {} }\n",
        )
        .unwrap();
        let idx = CodeIndex::build(dir.path()).unwrap();

        let v = op_usages(&idx, "run", None);
        let candidates = v["candidates"].as_array().expect("candidates listed");
        let asks: Vec<&str> = candidates
            .iter()
            .filter_map(|c| c["ask"].as_str())
            .collect();
        assert!(
            asks.contains(&"A::run") && asks.contains(&"B::run"),
            "distinct containers make the qualified name the right suggestion: {v}"
        );
    }

    #[test]
    fn outline_of_an_unreadable_file_names_the_language_not_the_index() {
        // The file is sitting right there. "No indexed file matches" is true
        // and useless; the caller needs to know it must reach for `grep`.
        let (_d, idx) = unreadable_fixture();
        let v = op_outline(&idx, "grid.dart");
        assert_eq!(v["symbols"], 0);
        let msg = v["message"].as_str().unwrap();
        assert!(msg.contains(".dart"), "{msg}");
        assert!(msg.contains("grep"), "the way forward must be named: {msg}");
        assert!(
            !msg.contains("No indexed file matches"),
            "the generic answer hides the real reason: {msg}"
        );
    }

    #[test]
    fn a_missing_definition_states_the_coverage_gap_instead_of_guessing() {
        // The dangerous shape: `success: true` plus a confident "it may come
        // from a dependency" about a symbol that is defined in this very
        // workspace, in a language nothing here parses.
        let (_d, idx) = unreadable_fixture();
        let v = op_definition(&idx, "PianoRollGrid", None);
        assert_eq!(v["found"], 0);
        let msg = v["message"].as_str().unwrap();
        assert!(msg.contains(".dart"), "{msg}");
        assert!(
            !msg.starts_with("No definition of `PianoRollGrid` in this workspace."),
            "it IS in this workspace — only unreadable: {msg}"
        );
    }

    #[test]
    fn missing_usages_refuse_to_be_read_as_nothing_calls_it() {
        // This is the answer that ends "so there are no callers, the refactor
        // is safe". It has to say otherwise in words.
        let (_d, idx) = unreadable_fixture();
        let v = op_usages(&idx, "PianoRollGrid", None);
        assert_eq!(v["resolved"], false);
        let msg = v["message"].as_str().unwrap();
        assert!(msg.contains("nothing calls it"), "{msg}");
        assert!(msg.contains(".dart"), "{msg}");
    }

    #[test]
    fn a_fully_readable_workspace_keeps_the_plain_answers() {
        // The coverage sentence must appear only when there is a gap; adding
        // it everywhere would be noise on the common path.
        let (_d, idx) = fixture();
        let v = op_definition(&idx, "nowhere", None);
        let msg = v["message"].as_str().unwrap();
        assert!(msg.contains("in this workspace"), "{msg}");
        assert!(!msg.contains("cannot read"), "no gap to report: {msg}");
    }

    #[test]
    fn tool_messages_carry_no_collapsed_line_continuations() {
        // Two of these strings shipped with eighteen literal spaces mid-
        // sentence, from a lost `\` continuation. The model reads them
        // verbatim, so the damage is silent.
        let (_d, idx) = fixture();
        for v in [
            op_definition(&idx, "nowhere", None),
            op_usages(&idx, "nowhere", None),
            op_outline(&idx, "nowhere.rs"),
        ] {
            let msg = v["message"].as_str().unwrap().to_string();
            assert!(!msg.contains("   "), "collapsed continuation in: {msg}");
        }
    }
}
