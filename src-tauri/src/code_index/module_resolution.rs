//! Configuration-backed JavaScript/TypeScript paths. Files are read once per
//! lookup rebuild; query operations do no filesystem work.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Debug, Default, Clone)]
struct Config {
    directory: PathBuf,
    base_url: Option<PathBuf>,
    paths_base: PathBuf,
    paths: Vec<(String, Vec<String>)>,
    includes: Vec<String>,
    excludes: Vec<String>,
    files: Option<Vec<String>>,
    references: Vec<PathBuf>,
}

#[derive(Debug, Default)]
pub(super) struct ModuleConfig {
    by_file: HashMap<String, Config>,
}

fn normalized(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                result.pop();
            }
            std::path::Component::CurDir => {}
            other => result.push(other.as_os_str()),
        }
    }
    result
}

/// Parse the JSON-with-comments syntax used by tsconfig without changing strings.
fn jsonc(source: &str) -> Option<serde_json::Value> {
    let mut bytes = source.as_bytes().to_vec();
    let mut pos = 0;
    let mut quoted = false;
    while pos < bytes.len() {
        if quoted {
            match bytes[pos] {
                b'\\' => {
                    pos += 2;
                    continue;
                }
                b'"' => quoted = false,
                _ => {}
            }
        } else if bytes[pos] == b'"' {
            quoted = true;
        } else if bytes[pos..].starts_with(b"//") {
            while pos < bytes.len() && bytes[pos] != b'\n' {
                bytes[pos] = b' ';
                pos += 1;
            }
            continue;
        } else if bytes[pos..].starts_with(b"/*") {
            bytes[pos] = b' ';
            bytes[pos + 1] = b' ';
            pos += 2;
            while pos + 1 < bytes.len() && !bytes[pos..].starts_with(b"*/") {
                bytes[pos] = b' ';
                pos += 1;
            }
            if pos + 1 >= bytes.len() {
                return None;
            }
            bytes[pos] = b' ';
            bytes[pos + 1] = b' ';
            pos += 2;
            continue;
        }
        pos += 1;
    }
    quoted = false;
    pos = 0;
    while pos < bytes.len() {
        match bytes[pos] {
            b'\\' if quoted => {
                pos += 2;
                continue;
            }
            b'"' => quoted = !quoted,
            b',' if !quoted => {
                let next = bytes[pos + 1..].iter().find(|b| !b.is_ascii_whitespace());
                if matches!(next, Some(b']' | b'}')) {
                    bytes[pos] = b' ';
                }
            }
            _ => {}
        }
        pos += 1;
    }
    serde_json::from_slice(&bytes).ok()
}

fn strings(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(ToOwned::to_owned))
        .collect()
}

fn config_file(path: PathBuf) -> PathBuf {
    if path.is_dir() {
        path.join("tsconfig.json")
    } else if path.extension().is_none() {
        path.with_extension("json")
    } else {
        path
    }
}

fn extended_path(directory: &Path, value: &str) -> Option<PathBuf> {
    if value.starts_with('.') || Path::new(value).is_absolute() {
        return Some(normalized(&config_file(directory.join(value))));
    }
    for ancestor in directory.ancestors() {
        let candidate = config_file(ancestor.join("node_modules").join(value));
        if candidate.is_file() {
            return Some(normalized(&candidate));
        }
    }
    None
}

fn load(
    path: &Path,
    seen: &mut HashSet<PathBuf>,
    dependencies: &mut Vec<PathBuf>,
    depth: usize,
) -> Option<Config> {
    let path = normalized(path);
    if depth > 32 || !seen.insert(path.clone()) {
        return None;
    }
    dependencies.push(path.clone());
    if std::fs::metadata(&path).ok()?.len() > 1024 * 1024 {
        return None;
    }
    let text = std::fs::read_to_string(&path).ok()?;
    let Some(value) = jsonc(&text) else {
        crate::logging::log_warn(
            "code_index",
            &format!("Could not parse configuration {}", path.display()),
        );
        return None;
    };
    let directory = path.parent()?.to_path_buf();
    let mut config = Config {
        directory: directory.clone(),
        paths_base: directory.clone(),
        ..Default::default()
    };
    let extends = value
        .get("extends")
        .and_then(|v| v.as_str())
        .map(|s| vec![s.to_owned()])
        .unwrap_or_else(|| strings(value.get("extends")));
    for parent in extends {
        if let Some(base) = extended_path(&directory, &parent)
            .and_then(|path| load(&path, seen, dependencies, depth + 1))
        {
            config.base_url = base.base_url;
            if !base.paths.is_empty() {
                config.paths = base.paths;
                config.paths_base = base.paths_base;
            }
        }
    }
    if let Some(options) = value.get("compilerOptions") {
        if let Some(base) = options.get("baseUrl").and_then(|v| v.as_str()) {
            config.base_url = Some(normalized(&directory.join(base)));
        }
        if let Some(paths) = options.get("paths").and_then(|v| v.as_object()) {
            config.paths = paths
                .iter()
                .map(|(key, value)| (key.clone(), strings(Some(value))))
                .collect();
            config.paths_base = directory.clone();
        }
    }
    config.includes = strings(value.get("include"));
    config.excludes = strings(value.get("exclude"));
    config.files = value.get("files").map(|v| strings(Some(v)));
    config.references = value
        .get("references")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|v| v.get("path").and_then(|v| v.as_str()))
        .map(|p| normalized(&config_file(directory.join(p))))
        .collect();
    // Dependencies include project-reference configs even if they own no files yet.
    for reference in &config.references {
        let _ = load(reference, seen, dependencies, depth + 1);
    }
    Some(config)
}

pub(crate) fn configuration_dependencies(path: &Path) -> Vec<PathBuf> {
    let mut dependencies = Vec::new();
    let _ = load(path, &mut HashSet::new(), &mut dependencies, 0);
    dependencies
}

fn path_matches(pattern: &str, path: &str) -> bool {
    let pattern = pattern.trim_start_matches("./");
    if !pattern.contains('*') && !pattern.contains('?') {
        return path == pattern || path.starts_with(&format!("{}/", pattern.trim_end_matches('/')));
    }
    // A bounded state machine avoids exponential backtracking for repeated
    // wildcards in configuration controlled by the indexed repository.
    let pattern = pattern.as_bytes();
    if pattern.len() > 4096 || path.len() > 4096 { return false; }
    let close = |states: &mut [bool]| {
        for at in 0..pattern.len() {
            if states[at] && pattern[at] == b'*' {
                let double = pattern.get(at + 1) == Some(&b'*');
                let next = at + if double { 2 } else { 1 };
                states[next] = true;
                if double && pattern.get(next) == Some(&b'/') { states[next + 1] = true; }
            }
        }
    };
    let mut states = vec![false; pattern.len() + 1];
    states[0] = true;
    close(&mut states);
    for byte in path.bytes() {
        let mut next = vec![false; states.len()];
        for at in 0..pattern.len() {
            if !states[at] { continue; }
            match pattern[at] {
                b'*' if pattern.get(at + 1) == Some(&b'*') || byte != b'/' => next[at] = true,
                b'?' if byte != b'/' => next[at + 1] = true,
                literal if literal == byte => next[at + 1] = true,
                _ => {}
            }
        }
        close(&mut next);
        states = next;
    }
    states[pattern.len()]
}

impl Config {
    fn owns(&self, source: &Path) -> bool {
        let Ok(relative) = source.strip_prefix(&self.directory) else {
            return false;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        if self.excludes.iter().any(|p| path_matches(p, &relative)) {
            return false;
        }
        if self
            .files
            .as_ref()
            .is_some_and(|files| files.iter().any(|p| p.trim_start_matches("./") == relative))
        {
            return true;
        }
        if !self.includes.is_empty() {
            return self.includes.iter().any(|p| path_matches(p, &relative));
        }
        self.files.is_none()
    }
}

impl ModuleConfig {
    pub(super) fn read(root: &Path, files: impl Iterator<Item = String>) -> Self {
        let mut result = Self::default();
        let mut cache: HashMap<PathBuf, Option<Config>> = HashMap::new();
        for file in files {
            let absolute = root.join(&file);
            for directory in absolute.parent().into_iter().flat_map(Path::ancestors) {
                if !directory.starts_with(root) {
                    break;
                }
                let mut found = false;
                for name in ["tsconfig.json", "jsconfig.json"] {
                    let path = directory.join(name);
                    let config = cache
                        .entry(path.clone())
                        .or_insert_with(|| load(&path, &mut HashSet::new(), &mut Vec::new(), 0))
                        .clone();
                    let Some(config) = config else {
                        continue;
                    };
                    found = true;
                    let mut candidates = Vec::new();
                    if config.owns(&absolute) {
                        candidates.push(config.clone());
                    }
                    for path in &config.references {
                        if let Some(reference) = cache
                            .entry(path.clone())
                            .or_insert_with(|| load(path, &mut HashSet::new(), &mut Vec::new(), 0))
                            .clone()
                            .filter(|c| c.owns(&absolute))
                        {
                            candidates.push(reference);
                        }
                    }
                    // Two project configs including one file do not prove which
                    // compiler options apply. Keep that import unresolved.
                    if candidates.len() == 1 {
                        result.by_file.insert(file.clone(), candidates.remove(0));
                    }
                    break;
                }
                if found {
                    break;
                }
            }
        }
        result
    }

    /// Paths in TypeScript's priority order. `matched` prevents a configured
    /// alias that misses from falling through to an unrelated package/name.
    pub(super) fn candidates(&self, root: &Path, file: &str, spec: &str) -> (Vec<String>, bool) {
        let Some(config) = self.by_file.get(file) else {
            return (Vec::new(), false);
        };
        let mut matches = Vec::new();
        for (pattern, targets) in &config.paths {
            let capture = if pattern == spec {
                Some("")
            } else if let Some((prefix, suffix)) = pattern.split_once('*') {
                spec.strip_prefix(prefix)
                    .and_then(|rest| rest.strip_suffix(suffix))
            } else {
                None
            };
            if let Some(capture) = capture {
                matches.push((pattern, targets, capture));
            }
        }
        matches.sort_by_key(|(pattern, _, _)| {
            std::cmp::Reverse((
                !pattern.contains('*'),
                pattern.find('*').unwrap_or(pattern.len()),
            ))
        });
        let base = config.base_url.as_ref().unwrap_or(&config.paths_base);
        let (paths, matched) = if let Some((_, targets, capture)) = matches.first() {
            (
                targets
                    .iter()
                    .map(|target| base.join(target.replace('*', capture)))
                    .collect::<Vec<_>>(),
                true,
            )
        } else {
            (
                config.base_url.iter().map(|base| base.join(spec)).collect(),
                false,
            )
        };
        (
            paths
                .into_iter()
                .filter_map(|p| {
                    normalized(&p)
                        .strip_prefix(root)
                        .ok()
                        .map(|p| p.to_string_lossy().replace('\\', "/"))
                })
                .collect(),
            matched,
        )
    }
}
