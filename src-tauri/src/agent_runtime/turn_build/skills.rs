//! Skills, found and chosen by the engine.
//!
//! A port of the discovery and filtering half of `services/skills/skills.ts`:
//! skill files under `<project>/.aurora/skills`, `<project>/.agents/skills`
//! and `~/.agents/skills`, each either `<root>/<name>.md` or
//! `<root>/<name>/skill.md` with optional frontmatter; which are switched on
//! per project (`skillToggles`, default off, at most ten); which the user
//! attached to the message. Aurora ships no built-in skills.
//!
//! One known difference: the window sorted by name with `localeCompare`
//! (ICU). [`locale_cmp`] matches it for letters, digits and case, not for
//! the relative order of punctuation marks against each other.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use crate::workspace::fs::list_directory;

use super::prompt::{PromptSkill, PromptSkills};

/// Project folders scanned for skills, in priority order.
pub const WORKSPACE_SKILL_FOLDERS: [&str; 2] = [".aurora/skills", ".agents/skills"];
/// Most switched-on skills previewed in the prompt.
pub const MAX_ENABLED_SKILLS: usize = 10;
/// Leading non-empty body lines kept as a preview.
const SKILL_PREVIEW_LINE_COUNT: usize = 5;
const SKILL_FILE_NAME: &str = "skill.md";
/// Toggle bucket used when no project is open.
pub const GLOBAL_SKILL_SCOPE_KEY: &str = "__global__";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillSource {
    Workspace,
    Global,
}

impl SkillSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::Global => "global",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub triggers: Vec<String>,
    pub content: String,
    pub preview_lines: Vec<String>,
    pub source: SkillSource,
    pub source_path: String,
    /// The skill's own folder, for the `<root>/<name>/skill.md` form.
    pub source_dir: Option<String>,
    /// What the toggles are keyed by: `<source>:<path, forward slashes, lower case>`.
    pub storage_key: String,
}

impl Skill {
    fn to_prompt(&self) -> PromptSkill {
        PromptSkill {
            id: self.id.clone(),
            description: self.description.clone(),
            preview_lines: self.preview_lines.clone(),
            source: self.source.as_str().to_string(),
            source_path: Some(self.source_path.clone()),
        }
    }
}

/// `~/.agents/skills`, the shared global folder (`get_global_skills_path`).
#[must_use]
pub fn global_skills_root() -> Option<String> {
    dirs::home_dir().map(|home| home.join(".agents").join("skills").to_string_lossy().to_string())
}

/// Every skill on disk for this project plus the global folder, unfiltered.
#[must_use]
pub fn load_all_skills(workspace: Option<&str>, global_root: Option<&str>) -> Vec<Skill> {
    let mut all = load_workspace_skills(workspace);
    all.extend(load_skills_from_root(global_root, SkillSource::Global));
    all
}

/// The skills for one turn's prompt: the catalogue of switched-on skills and
/// those attached with `/` (`resolveSkillsForPrompt`).
#[must_use]
pub fn resolve_for_prompt(
    all: &[Skill],
    toggles: &HashMap<String, HashMap<String, bool>>,
    skills_enabled: bool,
    workspace: Option<&str>,
    explicit_keys: &[String],
) -> PromptSkills {
    let bucket = toggles.get(&toggle_scope_key(workspace));
    let wanted: HashSet<String> =
        explicit_keys.iter().map(|key| normalize_storage_key(key)).filter(|key| !key.is_empty()).collect();
    let explicit = all
        .iter()
        .filter(|skill| wanted.contains(&normalize_storage_key(&skill.storage_key)))
        .map(Skill::to_prompt)
        .collect();
    let enabled = if skills_enabled {
        all.iter()
            .filter(|skill| bucket.and_then(|b| b.get(&skill.storage_key)).copied().unwrap_or(false))
            .take(MAX_ENABLED_SKILLS)
            .map(Skill::to_prompt)
            .collect()
    } else {
        Vec::new()
    };
    PromptSkills { total_count: all.len(), enabled, explicit }
}

/// The key a project's skill toggles are kept under.
#[must_use]
pub fn toggle_scope_key(workspace: Option<&str>) -> String {
    match workspace.map(str::trim).filter(|root| !root.is_empty()) {
        None => GLOBAL_SKILL_SCOPE_KEY.to_string(),
        Some(root) => root.replace('\\', "/").trim_end_matches('/').to_lowercase(),
    }
}

fn load_workspace_skills(workspace: Option<&str>) -> Vec<Skill> {
    let Some(workspace) = workspace.filter(|w| !w.is_empty()) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut merged: Vec<Skill> = WORKSPACE_SKILL_FOLDERS
        .iter()
        .flat_map(|folder| load_skills_from_root(Some(&join_workspace_subpath(workspace, folder)), SkillSource::Workspace))
        .filter(|skill| seen.insert(normalize_storage_key(&skill.storage_key)))
        .collect();
    merged.sort_by(|a, b| locale_cmp(&a.name, &b.name));
    merged
}

fn load_skills_from_root(root: Option<&str>, source: SkillSource) -> Vec<Skill> {
    let Some(root) = root.filter(|r| !r.is_empty()) else {
        return Vec::new();
    };
    let Ok(entries) = list_directory(root, true) else {
        return Vec::new();
    };
    let mut skills: Vec<Skill> = Vec::new();
    for entry in entries {
        let (file, fallback_id, container) = if entry.is_dir {
            let Ok(inner) = list_directory(&entry.path, true) else {
                crate::logging::log_warn("skills", &format!("could not read skill folder {}", entry.path));
                continue;
            };
            let Some(file) = inner.into_iter().find(|item| item.is_file && item.name.to_lowercase() == SKILL_FILE_NAME)
            else {
                continue;
            };
            (file.path, entry.name, Some(entry.path))
        } else if entry.is_file && entry.name.ends_with(".md") {
            let fallback = strip_md_suffix(&entry.name);
            (entry.path, fallback, None)
        } else {
            continue;
        };
        match std::fs::read_to_string(&file) {
            Ok(document) => {
                if let Some(skill) = parse_skill_document(&document, &fallback_id, source, &file, container) {
                    skills.push(skill);
                }
            }
            Err(error) => {
                crate::logging::log_warn("skills", &format!("could not read {} skill {file}: {error}", source.as_str()));
            }
        }
    }
    skills.sort_by(|a, b| locale_cmp(&a.name, &b.name));
    skills
}

/// `name.replace(/\.md$/i, "")`.
fn strip_md_suffix(name: &str) -> String {
    if name.len() >= 3 && name[name.len() - 3..].eq_ignore_ascii_case(".md") {
        name[..name.len() - 3].to_string()
    } else {
        name.to_string()
    }
}

fn join_workspace_subpath(workspace: &str, subpath: &str) -> String {
    let windows = workspace.contains('\\');
    let sub = if windows { subpath.replace('/', "\\") } else { subpath.to_string() };
    let sep = if windows { "\\" } else { "/" };
    if workspace.ends_with(sep) {
        format!("{workspace}{sub}")
    } else {
        format!("{workspace}{sep}{sub}")
    }
}

/// A frontmatter value: one string, or a list.
#[derive(Debug, Clone, PartialEq)]
enum Meta {
    Text(String),
    List(Vec<String>),
}

/// The window's small frontmatter reader (`parseFrontmatter`): `key: value`,
/// `key: [a, b]`, and `key:` followed by `- item` lines.
fn parse_frontmatter(document: &str) -> (HashMap<String, Meta>, String) {
    if !document.starts_with("---") {
        return (HashMap::new(), js_trim(document).to_string());
    }
    let Some(end) = document[3..].find("\n---").map(|i| i + 3) else {
        return (HashMap::new(), js_trim(document).to_string());
    };
    let raw = js_trim(&document[3..end]);
    let body = js_trim(&document[end + "\n---".len()..]).to_string();
    let mut meta: HashMap<String, Meta> = HashMap::new();
    let mut array_key: Option<String> = None;
    for raw_line in raw.split('\n') {
        let line = js_trim(raw_line.strip_suffix('\r').unwrap_or(raw_line));
        if line.is_empty() {
            continue;
        }
        if let (Some(item), Some(key)) = (line.strip_prefix("- "), array_key.as_ref()) {
            let value = js_trim(item).to_string();
            match meta.get_mut(key) {
                Some(Meta::List(list)) => list.push(value),
                _ => {
                    meta.insert(key.clone(), Meta::List(vec![value]));
                }
            }
            continue;
        }
        array_key = None;
        let Some(colon) = line.find(':') else { continue };
        let key = normalize(&line[..colon]);
        let value = js_trim(&line[colon + 1..]);
        if value.is_empty() {
            meta.insert(key.clone(), Meta::List(Vec::new()));
            array_key = Some(key);
            continue;
        }
        if value.starts_with('[') && value.ends_with(']') && value.len() >= 2 {
            meta.insert(key, Meta::List(split_inline_list(&value[1..value.len() - 1])));
            continue;
        }
        meta.insert(key, Meta::Text(strip_one_quote_each_end(value)));
    }
    (meta, body)
}

/// `value.replace(/^['"]|['"]$/g, "")`: one quote mark off each end, either kind.
fn strip_one_quote_each_end(value: &str) -> String {
    let mut text = value;
    if let Some(rest) = text.strip_prefix(['"', '\'']) {
        text = rest;
    }
    if let Some(rest) = text.strip_suffix(['"', '\'']) {
        text = rest;
    }
    text.to_string()
}

fn split_inline_list(value: &str) -> Vec<String> {
    value.split(',').map(js_trim).filter(|item| !item.is_empty()).map(str::to_string).collect()
}

fn parse_skill_document(
    document: &str,
    fallback_id: &str,
    source: SkillSource,
    source_path: &str,
    source_dir: Option<String>,
) -> Option<Skill> {
    let (meta, body) = parse_frontmatter(document);
    let text = |key: &str| match meta.get(key) {
        Some(Meta::Text(value)) => Some(value.as_str()),
        _ => None,
    };
    let content = js_trim(&body).to_string();
    if content.is_empty() {
        return None;
    }
    let name = text("name").map_or_else(|| fallback_id.to_string(), |name| js_trim(name).to_string());
    let description = text("description")
        .map(js_trim)
        .filter(|d| !d.is_empty())
        .unwrap_or("No description provided.")
        .to_string();
    let triggers = match meta.get("triggers") {
        Some(Meta::List(list)) => list.clone(),
        Some(Meta::Text(value)) => split_inline_list(value),
        None => Vec::new(),
    };
    let id_source = text("id").filter(|id| !js_trim(id).is_empty()).unwrap_or(fallback_id);
    Some(Skill {
        id: collapse_whitespace_to_dash(&normalize(id_source)),
        name,
        description,
        triggers: unique_strings(&triggers),
        preview_lines: preview_lines(&content),
        content,
        source,
        source_path: source_path.to_string(),
        source_dir,
        storage_key: format!("{}:{}", source.as_str(), source_path.replace('\\', "/").to_lowercase()),
    })
}

fn preview_lines(body: &str) -> Vec<String> {
    body.split('\n')
        .map(|line| js_trim(line.strip_suffix('\r').unwrap_or(line)))
        .filter(|line| !line.is_empty())
        .take(SKILL_PREVIEW_LINE_COUNT)
        .map(str::to_string)
        .collect()
}

fn unique_strings(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .iter()
        .filter(|value| {
            let key = normalize(value);
            !key.is_empty() && seen.insert(key)
        })
        .map(|value| js_trim(value).to_string())
        .collect()
}

/// `value.replace(/\s+/g, "-")`.
fn collapse_whitespace_to_dash(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_space = false;
    for c in value.chars() {
        if c.is_whitespace() {
            if !in_space {
                out.push('-');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

fn normalize(value: &str) -> String {
    js_trim(value).to_lowercase()
}

fn normalize_storage_key(value: &str) -> String {
    js_trim(value).replace('\\', "/").to_lowercase()
}

/// JavaScript's `trim`: Unicode white space plus the byte-order mark.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `a.localeCompare(b)` for skill names: case-insensitive first, then lower
/// case before upper case, as ICU's default collation orders them.
fn locale_cmp(a: &str, b: &str) -> Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| {
        for (x, y) in a.chars().zip(b.chars()) {
            if x != y {
                return match (x.is_lowercase(), y.is_lowercase()) {
                    (true, false) => Ordering::Less,
                    (false, true) => Ordering::Greater,
                    _ => x.cmp(&y),
                };
            }
        }
        a.len().cmp(&b.len())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &std::path::Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn reads_both_forms_with_frontmatter_and_sorts_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_string_lossy().to_string();
        write(
            &dir.path().join(".aurora/skills/react-perf/SKILL.md"),
            "---\nname: React Perf\ndescription: \"Fast renders.\"\ntriggers:\n  - memo\n  - Memo\n  - render\nid: React  Perf\n---\n\n# React\n\nUse memo.\n",
        );
        write(&dir.path().join(".agents/skills/alpha.md"), "Body only.\n");
        write(&dir.path().join(".aurora/skills/empty.md"), "---\nname: Empty\n---\n   \n");
        write(&dir.path().join(".aurora/skills/no-skill-file/readme.md"), "not a skill");

        let skills = load_all_skills(Some(&ws), None);
        let names: Vec<_> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["alpha", "React Perf"]);

        let react = &skills[1];
        assert_eq!(react.id, "react-perf");
        assert_eq!(react.description, "Fast renders.");
        assert_eq!(react.triggers, ["memo", "render"]);
        assert_eq!(react.preview_lines, ["# React", "Use memo."]);
        assert!(react.source_dir.is_some());
        assert!(react.storage_key.starts_with("workspace:"));
        assert!(react.storage_key.ends_with("/.aurora/skills/react-perf/skill.md"));
        assert_eq!(react.storage_key, react.storage_key.to_lowercase());

        assert_eq!(skills[0].description, "No description provided.");
        assert_eq!(skills[0].id, "alpha");
    }

    #[test]
    fn enabled_skills_follow_the_projects_toggles_and_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_string_lossy().to_string();
        for i in 0..12 {
            write(&dir.path().join(format!(".aurora/skills/s{i:02}.md")), "Body.");
        }
        let all = load_all_skills(Some(&ws), None);
        let bucket: HashMap<String, bool> = all.iter().map(|s| (s.storage_key.clone(), true)).collect();
        let toggles = HashMap::from([(toggle_scope_key(Some(&ws)), bucket)]);

        let on = resolve_for_prompt(&all, &toggles, true, Some(&ws), &[]);
        assert_eq!(on.total_count, 12);
        assert_eq!(on.enabled.len(), MAX_ENABLED_SKILLS);
        assert!(resolve_for_prompt(&all, &toggles, false, Some(&ws), &[]).enabled.is_empty());
        // Another project's bucket does not leak in.
        assert!(resolve_for_prompt(&all, &toggles, true, Some("E:\\other"), &[]).enabled.is_empty());

        let key = all[3].storage_key.to_uppercase().replace('/', "\\");
        let picked = resolve_for_prompt(&all, &HashMap::new(), true, Some(&ws), &[format!("  {key} ")]);
        assert_eq!(picked.explicit.len(), 1);
        assert_eq!(picked.explicit[0].id, all[3].id);
    }

    #[test]
    fn frontmatter_edge_cases_match_the_window() {
        let (meta, body) = parse_frontmatter("---\nname: 'quoted\"\ntags: [a, , b]\n---\nBody");
        assert_eq!(meta.get("name"), Some(&Meta::Text("quoted".into())));
        assert_eq!(meta.get("tags"), Some(&Meta::List(vec!["a".into(), "b".into()])));
        assert_eq!(body, "Body");
        let (meta, body) = parse_frontmatter("---\nunterminated");
        assert!(meta.is_empty());
        assert_eq!(body, "---\nunterminated");
    }

    #[test]
    fn scope_keys_and_name_order() {
        assert_eq!(toggle_scope_key(None), GLOBAL_SKILL_SCOPE_KEY);
        assert_eq!(toggle_scope_key(Some("  ")), GLOBAL_SKILL_SCOPE_KEY);
        assert_eq!(toggle_scope_key(Some("E:\\Work\\Shop\\")), "e:/work/shop");
        assert_eq!(locale_cmp("apple", "Banana"), Ordering::Less);
        assert_eq!(locale_cmp("a", "A"), Ordering::Less);
        assert_eq!(locale_cmp("Zed", "zed"), Ordering::Greater);
        assert_eq!(strip_md_suffix("Notes.MD"), "Notes");
    }
}
