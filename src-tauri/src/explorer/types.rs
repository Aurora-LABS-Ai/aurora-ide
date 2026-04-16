use serde::{Deserialize, Serialize};

/// Serialized explorer tree node returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerNode {
    pub children: Vec<ExplorerNode>,
    pub id: String,
    pub language: Option<String>,
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub node_type: ExplorerNodeType,
}

/// Kind of explorer node.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExplorerNodeType {
    File,
    Folder,
}

/// Full explorer snapshot owned by Rust and mirrored into the frontend store.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerSnapshot {
    pub expanded_folders: Vec<String>,
    pub files: Vec<ExplorerNode>,
    pub root_path: String,
    pub selected_file: Option<String>,
}
