use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::db::ExplorerState as PersistedExplorerState;

use super::types::{ExplorerNode, ExplorerNodeType, ExplorerSnapshot};

const EAGER_ROOT_DEPTH: usize = 1;
const SKIPPED_DIRECTORIES: &[&str] = &[".git", "node_modules", "target", "dist", ".pnpm"];

#[derive(Debug, Default)]
pub struct ExplorerManager {
    session: Option<ExplorerSession>,
}

#[derive(Debug)]
struct ExplorerSession {
    expanded_folders: BTreeSet<String>,
    files: Vec<ExplorerNode>,
    root_path: String,
    selected_file: Option<String>,
    show_hidden: bool,
}

impl ExplorerManager {
    pub fn apply_fs_changes(
        &mut self,
        paths: &[String],
        kind: Option<&str>,
    ) -> Result<ExplorerSnapshot, String> {
        let session = self.session_mut()?;
        session.apply_fs_changes(paths, kind);
        Ok(session.snapshot())
    }

    pub fn clear_workspace(&mut self) {
        self.session = None;
    }

    pub fn collapse_all(&mut self) -> Result<ExplorerSnapshot, String> {
        let session = self.session_mut()?;
        session.collapse_all();
        Ok(session.snapshot())
    }

    pub fn expand_folder(&mut self, folder_id: &str) -> Result<ExplorerSnapshot, String> {
        let session = self.session_mut()?;
        session.expand_folder(folder_id)?;
        Ok(session.snapshot())
    }

    pub fn get_snapshot(&self) -> Option<ExplorerSnapshot> {
        self.session.as_ref().map(ExplorerSession::snapshot)
    }

    pub fn open_workspace(
        &mut self,
        root_path: String,
        persisted_state: Option<PersistedExplorerState>,
        show_hidden: bool,
    ) -> Result<ExplorerSnapshot, String> {
        let session = ExplorerSession::open(root_path, persisted_state, show_hidden)?;
        let snapshot = session.snapshot();
        self.session = Some(session);
        Ok(snapshot)
    }

    pub fn persisted_state(&self) -> Option<PersistedExplorerState> {
        self.session.as_ref().map(ExplorerSession::persisted_state)
    }

    pub fn refresh(&mut self) -> Result<ExplorerSnapshot, String> {
        let session = self.session_mut()?;
        session.reload_root()?;
        Ok(session.snapshot())
    }

    pub fn reveal_file(&mut self, file_path: &str) -> Result<ExplorerSnapshot, String> {
        let session = self.session_mut()?;
        session.reveal_file(file_path)?;
        Ok(session.snapshot())
    }

    pub fn select_file(&mut self, file_id: Option<String>) -> Result<ExplorerSnapshot, String> {
        let session = self.session_mut()?;
        session.selected_file = file_id;
        Ok(session.snapshot())
    }

    pub fn toggle_folder(&mut self, folder_id: &str) -> Result<ExplorerSnapshot, String> {
        let session = self.session_mut()?;
        session.toggle_folder(folder_id)?;
        Ok(session.snapshot())
    }

    fn session_mut(&mut self) -> Result<&mut ExplorerSession, String> {
        self.session
            .as_mut()
            .ok_or_else(|| "explorer workspace is not open".to_string())
    }
}

impl ExplorerSession {
    fn apply_fs_changes(&mut self, paths: &[String], kind: Option<&str>) {
        let refresh_targets = self.collect_refresh_targets(paths);
        for folder_path in refresh_targets {
            if let Err(error) = self.refresh_visible_folder(&folder_path) {
                eprintln!(
                    "[explorer] failed to refresh folder after {:?} event at {}: {}",
                    kind, folder_path, error
                );
            }
        }

        if matches!(kind, Some("remove")) {
            self.clear_missing_selection(paths);
        }
    }

    fn build_directory_nodes(
        &self,
        directory_path: &Path,
        eager_depth: usize,
    ) -> Result<Vec<ExplorerNode>, String> {
        let read_dir = fs::read_dir(directory_path).map_err(|error| {
            format!(
                "failed to read directory {}: {}",
                directory_path.display(),
                error
            )
        })?;

        let mut nodes: Vec<ExplorerNode> = Vec::new();

        for entry in read_dir.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if self.should_skip_name(&file_name) {
                continue;
            }

            let file_path = entry.path();
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };

            let path_string = path_to_string(&file_path);
            if metadata.is_dir() {
                let children = if eager_depth > 0 || self.expanded_folders.contains(&path_string) {
                    self.build_directory_nodes(&file_path, eager_depth.saturating_sub(1))?
                } else {
                    Vec::new()
                };

                nodes.push(ExplorerNode {
                    children,
                    id: path_string.clone(),
                    language: None,
                    name: file_name,
                    path: path_string,
                    node_type: ExplorerNodeType::Folder,
                });
            } else if metadata.is_file() {
                nodes.push(ExplorerNode {
                    children: Vec::new(),
                    id: path_string.clone(),
                    language: Some(language_from_filename(&file_name)),
                    name: file_name,
                    path: path_string,
                    node_type: ExplorerNodeType::File,
                });
            }
        }

        sort_nodes(&mut nodes);
        Ok(nodes)
    }

    fn clear_missing_selection(&mut self, removed_paths: &[String]) {
        let Some(selected_file) = self.selected_file.as_ref() else {
            return;
        };

        if removed_paths.iter().any(|path| path == selected_file) {
            self.selected_file = None;
        }
    }

    fn collapse_all(&mut self) {
        self.expanded_folders.clear();
        self.expanded_folders.insert(self.root_path.clone());
        self.files.iter_mut().for_each(clear_node_children);
    }

    fn collect_refresh_targets(&self, paths: &[String]) -> Vec<String> {
        let root_path = Path::new(&self.root_path);
        let mut targets = BTreeSet::new();

        for path in paths {
            let changed_path = Path::new(path);
            if path == &self.root_path {
                targets.insert(self.root_path.clone());
                continue;
            }

            if !changed_path.starts_with(root_path) {
                continue;
            }

            let Some(parent_path) = changed_path.parent() else {
                targets.insert(self.root_path.clone());
                continue;
            };

            let parent_path = path_to_string(parent_path);
            if self.should_refresh_folder(&parent_path) {
                targets.insert(parent_path);
            }
        }

        coalesce_targets(targets.into_iter().collect())
    }

    fn expand_folder(&mut self, folder_id: &str) -> Result<(), String> {
        self.expanded_folders.insert(folder_id.to_string());
        self.refresh_visible_folder(folder_id)
    }

    fn open(
        root_path: String,
        persisted_state: Option<PersistedExplorerState>,
        show_hidden: bool,
    ) -> Result<Self, String> {
        let mut session = Self {
            expanded_folders: persisted_state
                .as_ref()
                .map(|state| state.expanded_folders.iter().cloned().collect())
                .unwrap_or_default(),
            files: Vec::new(),
            root_path,
            selected_file: persisted_state.and_then(|state| state.selected_file),
            show_hidden,
        };
        session.expanded_folders.insert(session.root_path.clone());
        session.reload_root()?;
        Ok(session)
    }

    fn persisted_state(&self) -> PersistedExplorerState {
        PersistedExplorerState {
            workspace_path: self.root_path.clone(),
            expanded_folders: self.expanded_folders.iter().cloned().collect(),
            selected_file: self.selected_file.clone(),
        }
    }

    fn refresh_visible_folder(&mut self, folder_path: &str) -> Result<(), String> {
        if folder_path == self.root_path {
            return self.reload_root();
        }

        if !self.should_refresh_folder(folder_path) {
            return Ok(());
        }

        let refreshed_children = self.build_directory_nodes(Path::new(folder_path), 0)?;
        self.files = replace_folder_children(&self.files, folder_path, &refreshed_children);
        Ok(())
    }

    fn reload_root(&mut self) -> Result<(), String> {
        self.files = self.build_directory_nodes(Path::new(&self.root_path), EAGER_ROOT_DEPTH)?;
        Ok(())
    }

    fn reveal_file(&mut self, file_path: &str) -> Result<(), String> {
        let file_path = Path::new(file_path);
        let root_path = Path::new(&self.root_path);
        if !file_path.starts_with(root_path) {
            return Ok(());
        }

        if let Some(parent_path) = file_path.parent() {
            let mut current_path = PathBuf::from(&self.root_path);
            for component in parent_path
                .strip_prefix(root_path)
                .unwrap_or(parent_path)
                .components()
            {
                current_path.push(component.as_os_str());
                self.expanded_folders.insert(path_to_string(&current_path));
            }
        }

        self.selected_file = Some(path_to_string(file_path));
        self.reload_root()
    }

    fn should_refresh_folder(&self, folder_path: &str) -> bool {
        folder_path == self.root_path || self.expanded_folders.contains(folder_path)
    }

    fn should_skip_name(&self, file_name: &str) -> bool {
        if !self.show_hidden && file_name.starts_with('.') && file_name != ".aurora" {
            return true;
        }

        SKIPPED_DIRECTORIES.contains(&file_name)
    }

    fn snapshot(&self) -> ExplorerSnapshot {
        ExplorerSnapshot {
            expanded_folders: self.expanded_folders.iter().cloned().collect(),
            files: self.files.clone(),
            root_path: self.root_path.clone(),
            selected_file: self.selected_file.clone(),
        }
    }

    fn toggle_folder(&mut self, folder_id: &str) -> Result<(), String> {
        if self.expanded_folders.contains(folder_id) {
            self.expanded_folders.remove(folder_id);
            self.files = collapse_folder_children(&self.files, folder_id);
            return Ok(());
        }

        self.expand_folder(folder_id)
    }
}

fn clear_node_children(node: &mut ExplorerNode) {
    if node.node_type == ExplorerNodeType::Folder {
        node.children.clear();
    }
}

fn coalesce_targets(mut targets: Vec<String>) -> Vec<String> {
    targets.sort();
    let mut result: Vec<String> = Vec::new();

    for target in targets {
        if result.iter().any(|ancestor| {
            target != *ancestor && Path::new(&target).starts_with(Path::new(ancestor))
        }) {
            continue;
        }

        result.push(target);
    }

    result
}

fn collapse_folder_children(nodes: &[ExplorerNode], folder_id: &str) -> Vec<ExplorerNode> {
    nodes
        .iter()
        .map(|node| {
            if node.id == folder_id && node.node_type == ExplorerNodeType::Folder {
                let mut collapsed = node.clone();
                collapsed.children.clear();
                return collapsed;
            }

            let mut next = node.clone();
            if !node.children.is_empty() {
                next.children = collapse_folder_children(&node.children, folder_id);
            }
            next
        })
        .collect()
}

fn language_from_filename(filename: &str) -> String {
    let normalized = filename.trim().to_lowercase();
    if normalized.ends_with(".d.ts")
        || normalized.ends_with(".d.mts")
        || normalized.ends_with(".d.cts")
    {
        return "typescript".to_string();
    }

    match normalized.as_str() {
        "dockerfile" => return "dockerfile".to_string(),
        "makefile" => return "makefile".to_string(),
        "cmakelists.txt" => return "cmake".to_string(),
        "jenkinsfile" => return "groovy".to_string(),
        ".bashrc" | ".zshrc" | ".profile" => return "shell".to_string(),
        ".gitignore" => return "plaintext".to_string(),
        _ => {}
    }

    let extension = normalized.rsplit('.').next().unwrap_or_default();
    match extension {
        "ts" | "tsx" | "mts" | "cts" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "json" => "json",
        "css" => "css",
        "scss" | "sass" => "scss",
        "html" | "htm" | "xhtml" => "html",
        "md" | "mdx" => "markdown",
        "vue" => "vue",
        "svelte" => "svelte",
        "rs" => "rust",
        "toml" | "lock" => "toml",
        "go" => "go",
        "c" => "c",
        "cpp" | "cc" | "cxx" | "h" | "hpp" => "cpp",
        "py" | "pyw" => "python",
        "java" => "java",
        "kt" => "kotlin",
        "rb" => "ruby",
        "php" => "php",
        "swift" => "swift",
        "lua" => "lua",
        "sh" | "bash" | "zsh" | "fish" => "shell",
        "ps1" | "psm1" | "psd1" => "powershell",
        "bat" | "cmd" => "bat",
        "yaml" | "yml" => "yaml",
        "sql" => "sql",
        "graphql" | "gql" => "graphql",
        "xml" => "xml",
        "ini" | "conf" | "env" => "ini",
        _ => "plaintext",
    }
    .to_string()
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn replace_folder_children(
    nodes: &[ExplorerNode],
    folder_id: &str,
    refreshed_children: &[ExplorerNode],
) -> Vec<ExplorerNode> {
    nodes
        .iter()
        .map(|node| {
            if node.id == folder_id && node.node_type == ExplorerNodeType::Folder {
                let mut refreshed = node.clone();
                refreshed.children = refreshed_children.to_vec();
                return refreshed;
            }

            let mut next = node.clone();
            if !node.children.is_empty() {
                next.children =
                    replace_folder_children(&node.children, folder_id, refreshed_children);
            }
            next
        })
        .collect()
}

fn sort_nodes(nodes: &mut [ExplorerNode]) {
    nodes.sort_by(|left, right| match (left.node_type, right.node_type) {
        (ExplorerNodeType::Folder, ExplorerNodeType::File) => std::cmp::Ordering::Less,
        (ExplorerNodeType::File, ExplorerNodeType::Folder) => std::cmp::Ordering::Greater,
        _ => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
    });
}
