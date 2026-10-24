//! The project's folder tree to depth 2, for the top of `<repo_map>`.
//!
//! The landmark list (`repo_map::render`) only names folders that hold
//! exported code, so a project's docs, config, scripts and asset folders never
//! appear in it, and without an index there is no map at all. This listing
//! fills both gaps for the cost of reading two levels of directory entries:
//! no file is opened, so it takes milliseconds on a project of any size.
//!
//! It walks with the same rules as the index (`.gitignore`, the always-skipped
//! dependency and build folders), so the two halves of the block agree on what
//! the project is.

use std::collections::BTreeMap;
use std::path::Path;

/// Levels below the root that are listed.
pub const TREE_DEPTH: usize = 2;

/// Entries one folder may list before the rest are counted. Keeps one wide
/// folder (a flat `src/` with 200 files) from spending the whole block.
const MAX_PER_DIR: usize = 25;

/// Ceiling for the whole listing, in characters.
const MAX_CHARS: usize = 4_000;

struct Entry {
    name: String,
    is_dir: bool,
}

/// The `<tree>` element, or `None` when the root lists nothing.
pub fn render(root: &Path) -> Option<String> {
    // Children of each folder, keyed by the folder's path relative to the
    // root ("" is the root itself).
    let mut children: BTreeMap<String, Vec<Entry>> = BTreeMap::new();
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .require_git(false)
        .git_global(false)
        .max_depth(Some(TREE_DEPTH))
        .filter_entry(|entry| {
            !entry.file_type().is_some_and(|t| t.is_dir())
                || entry
                    .file_name()
                    .to_str()
                    .is_none_or(|name| !super::walk::is_skipped_dir(name))
        })
        .build();
    for entry in walker.flatten() {
        if entry.depth() == 0 {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(root) else {
            continue;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        let (parent, name) = match relative.rfind('/') {
            Some(at) => (relative[..at].to_string(), relative[at + 1..].to_string()),
            None => (String::new(), relative.clone()),
        };
        children.entry(parent).or_default().push(Entry {
            name,
            is_dir: entry.file_type().is_some_and(|t| t.is_dir()),
        });
    }
    for entries in children.values_mut() {
        // Folders first, then files, each alphabetical: the shape before the
        // detail, the way a file explorer shows it.
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
    }
    let top = children.get("")?;
    if top.is_empty() {
        return None;
    }

    let mut lines: Vec<String> = Vec::new();
    list(&children, "", 0, &mut lines);

    let mut out = format!("<tree depth=\"{TREE_DEPTH}\">\n");
    let mut cut = 0usize;
    for (at, line) in lines.iter().enumerate() {
        if out.len() + line.len() + 1 > MAX_CHARS {
            cut = lines.len() - at;
            break;
        }
        out.push_str(line);
        out.push('\n');
    }
    if cut > 0 {
        out.push_str(&format!("… {cut} more line(s) cut for space\n"));
    }
    out.push_str("</tree>");
    Some(out)
}

fn list(children: &BTreeMap<String, Vec<Entry>>, folder: &str, depth: usize, out: &mut Vec<String>) {
    let Some(entries) = children.get(folder) else {
        return;
    };
    let indent = "  ".repeat(depth);
    for entry in entries.iter().take(MAX_PER_DIR) {
        if entry.is_dir {
            out.push(format!("{indent}{}/", entry.name));
            let path = if folder.is_empty() {
                entry.name.clone()
            } else {
                format!("{folder}/{}", entry.name)
            };
            list(children, &path, depth + 1, out);
        } else {
            out.push(format!("{indent}{}", entry.name));
        }
    }
    if entries.len() > MAX_PER_DIR {
        out.push(format!("{indent}… {} more", entries.len() - MAX_PER_DIR));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(root: &Path, path: &str) {
        let full = root.join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, "x").unwrap();
    }

    #[test]
    fn two_levels_folders_first_and_nothing_deeper() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "package.json");
        touch(dir.path(), "apps/client/src/main.ts");
        touch(dir.path(), "apps/README.md");
        touch(dir.path(), "docs/dev.md");

        let tree = render(dir.path()).expect("a tree");
        assert_eq!(
            tree,
            "<tree depth=\"2\">\napps/\n  client/\n  README.md\ndocs/\n  dev.md\npackage.json\n</tree>"
        );
        assert!(!tree.contains("main.ts"), "depth 3 is not listed");
    }

    #[test]
    fn ignored_and_dependency_folders_are_left_out() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".gitignore"), "secret/\n").unwrap();
        touch(dir.path(), "secret/key.txt");
        touch(dir.path(), "node_modules/x/index.js");
        touch(dir.path(), "src/lib.rs");

        let tree = render(dir.path()).unwrap();
        assert!(!tree.contains("secret"), "{tree}");
        assert!(!tree.contains("node_modules"), "{tree}");
        assert!(tree.contains("src/"), "{tree}");
    }

    #[test]
    fn a_wide_folder_is_capped_and_counted() {
        let dir = tempfile::tempdir().unwrap();
        for n in 0..(MAX_PER_DIR + 5) {
            touch(dir.path(), &format!("src/file{n:02}.ts"));
        }
        let tree = render(dir.path()).unwrap();
        assert!(tree.contains("  … 5 more"), "{tree}");
    }

    #[test]
    fn an_empty_folder_gives_no_tree() {
        let dir = tempfile::tempdir().unwrap();
        assert!(render(dir.path()).is_none());
    }
}
