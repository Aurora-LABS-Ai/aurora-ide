//! Lexical traversal checks with a working directory per command.
//!
//! This is a command guard, not a shell sandbox. Literal directory changes
//! can be resolved; expansions and ambiguous control flow stay conservative.
use std::path::Path;

/// Return the first traversal that can leave the workspace.
pub(super) fn escaping_path(
    command: &str,
    workspace: &Path,
    cwd: &Path,
    posix: bool,
) -> Option<String> {
    let root = normalize(&workspace.to_string_lossy(), "");
    let mut directories = vec![normalize(&cwd.to_string_lossy(), &root)];
    let mut chain_start = directories.clone();
    let mut skipped_directories = Vec::new();
    let mut scopes = Vec::new();
    for (words, separator) in segments(command, posix) {
        let before = directories.clone();
        for word in &words {
            let path = word.trim_start_matches(['>', '<']).replace('\\', "/");
            if path.split('/').any(|part| part == "..")
                && directories
                    .iter()
                    .any(|dir| dir.is_empty() || !within(&normalize(&path, dir), &root))
            {
                return Some(word.clone());
            }
        }

        let changes_directory = words.first().is_some_and(|word| {
            if posix {
                word == "cd"
            } else {
                matches!(
                    word.to_ascii_lowercase().as_str(),
                    "cd" | "chdir" | "set-location" | "sl"
                )
            }
        });
        if changes_directory {
            let target = words.iter().skip(1).find(|word| {
                !matches!(
                    word.to_ascii_lowercase().as_str(),
                    "--" | "/d" | "-literalpath" | "-path" | "-l" | "-p"
                )
            });
            directories = match target {
                Some(target)
                    if !target.contains(['$', '%', '*', '?', '`'])
                        && target != "-"
                        && !target.starts_with('~') =>
                {
                    before.iter().map(|dir| normalize(target, dir)).collect()
                }
                _ => vec![String::new()],
            };
        }

        match separator.as_str() {
            "&&" => {
                if !changes_directory || !directories.iter().all(|dir| Path::new(dir).is_dir()) {
                    skipped_directories.extend(before);
                }
            }
            "||" => {
                // The failed cd and a later failed command take different paths.
                directories = if changes_directory {
                    before
                } else {
                    directories
                };
                directories.extend(chain_start.clone());
                directories.extend(skipped_directories.clone());
            }
            "(" | "{" => {
                scopes.push((
                    before.clone(),
                    chain_start.clone(),
                    skipped_directories.clone(),
                ));
                skipped_directories.clear();
                chain_start = directories.clone();
            }
            ")" | "}" => {
                if let Some((outer, chain, skipped)) = scopes.pop() {
                    directories = outer;
                    chain_start = chain;
                    skipped_directories = skipped;
                }
            }
            "|" | "&" => directories = before,
            _ => {
                // After `;`, a failed cd does not stop execution. Only rely on
                // its success if the literal directory exists at validation time.
                if changes_directory && !directories.iter().all(|dir| Path::new(dir).is_dir()) {
                    directories.extend(before);
                }
                directories.append(&mut skipped_directories);
                chain_start = directories.clone();
            }
        }
        directories.sort();
        directories.dedup();
        skipped_directories.sort();
        skipped_directories.dedup();
    }
    None
}

fn within(path: &str, root: &str) -> bool {
    (root == "/" && path.starts_with('/'))
        || path == root
        || path
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn normalize(path: &str, cwd: &str) -> String {
    let mut path = path.replace('\\', "/");
    // Git Bash spells Windows drive roots as /e/ rather than E:/.
    if cwd.as_bytes().get(1) == Some(&b':')
        && path.starts_with('/')
        && path.as_bytes().get(2) == Some(&b'/')
        && path.as_bytes()[1].is_ascii_alphabetic()
    {
        path = format!("{}:{}", &path[1..2], &path[2..]);
    }
    let absolute = path.starts_with('/') || path.as_bytes().get(1) == Some(&b':');
    let joined = if absolute {
        path
    } else {
        format!("{cwd}/{path}")
    };
    let windows = joined.as_bytes().get(1) == Some(&b':');
    let mut parts = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|p: &&str| !p.ends_with(':')) {
                    parts.pop();
                }
            }
            _ => parts.push(part),
        }
    }
    let result = format!(
        "{}{}",
        if joined.starts_with('/') { "/" } else { "" },
        parts.join("/")
    );
    if windows {
        result.to_ascii_lowercase()
    } else {
        result
    }
}

/// Keep quotes and command separators distinct so `cd "a b" && ...` works
/// and directory changes inside a pipeline or subshell do not leak out.
fn segments(command: &str, posix: bool) -> Vec<(Vec<String>, String)> {
    let mut result = Vec::new();
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut chars = command.chars().peekable();
    while let Some(c) = chars.next() {
        if (posix && c == '\\' && quote != Some('\'')) || (!posix && c == '`') {
            if let Some(next) = chars.next() {
                word.push(next);
            }
        } else if quote == Some(c) {
            quote = None;
        } else if quote.is_none() && matches!(c, '\'' | '"') {
            quote = Some(c);
        } else if quote.is_none()
            && matches!(c, ';' | '|' | '&' | '(' | ')' | '{' | '}' | '\n' | '\r')
        {
            if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
            let mut separator = c.to_string();
            if matches!(c, '&' | '|') && chars.peek() == Some(&c) {
                chars.next();
                separator.push(c);
            }
            result.push((std::mem::take(&mut words), separator));
        } else if quote.is_none() && (c.is_whitespace() || matches!(c, '<' | '>')) {
            if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
        } else {
            word.push(c);
        }
    }
    if !word.is_empty() {
        words.push(word);
    }
    result.push((words, String::new()));
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_cd_and_explicit_cwd_against_project() {
        let root = Path::new("E:/project");
        for command in [
            "cd apps/client/src && git -C .. status --short",
            "cd /e/project/apps/client && grep needle ../../packages",
            "cd 'E:/project/apps/client' && cat ../../config.json",
            "cd 'apps/client folder' && cat ../../config.json",
            "cd apps/client && cd ../server && cat ../../config.json",
        ] {
            assert_eq!(escaping_path(command, root, root, true), None, "{command}");
        }
        assert_eq!(
            escaping_path(
                "cat ../../config.json",
                root,
                Path::new("E:/project/apps/client"),
                true
            ),
            None
        );
        assert_eq!(
            escaping_path(
                r"Set-Location 'E:\project\apps' && Copy-Item ..\config.json .",
                root,
                root,
                false
            ),
            None
        );
    }

    #[test]
    fn refuses_real_escapes_and_does_not_assume_cd_succeeded() {
        let root = Path::new("E:/project");
        for command in [
            "cd apps/client && cat ../../../secret",
            "cd apps/client || cat ../secret",
            "cd missing; cat ../secret",
            "cd missing && echo ok; cat ../secret",
            "(cd apps/client); cat ../secret",
            "cd apps/client | cat ../secret",
            "cd apps/client && false || cat ../secret",
            "cd $UNKNOWN && cat ../secret",
            "cat 'E:/project/../secret'",
            "cat x 2>../../log.txt",
        ] {
            assert!(
                escaping_path(command, root, root, true).is_some(),
                "{command}"
            );
        }
    }

    #[test]
    fn semicolon_cd_uses_an_existing_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("child")).unwrap();
        assert_eq!(
            escaping_path("cd child; cat ../file", dir.path(), dir.path(), true),
            None
        );
        assert_eq!(
            escaping_path(
                r"Set-Location child; Copy-Item ..\file .",
                dir.path(),
                dir.path(),
                false
            ),
            None
        );
        assert!(escaping_path(
            "false && cd child; cat ../secret",
            dir.path(),
            dir.path(),
            true
        )
        .is_some());
    }
}
