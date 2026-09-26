use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct IndexSettings {
    pub auto_build: bool,
    pub search_results: usize,
    pub search_bytes: usize,
}

impl Default for IndexSettings {
    fn default() -> Self { Self { auto_build: true, search_results: 8, search_bytes: 24_000 } }
}

impl IndexSettings {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!((1..=20).contains(&self.search_results), "Search results must be between 1 and 20.");
        anyhow::ensure!((2_000..=64_000).contains(&self.search_bytes), "Search output must be between 2,000 and 64,000 bytes.");
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum BuildPhase {
    Queued,
    Indexing,
    #[serde(alias = "enriching")]
    Saving,
    Complete,
    Failed,
    Cancelled,
    Interrupted,
}

impl BuildPhase {
    pub fn running(self) -> bool {
        matches!(self, Self::Queued | Self::Indexing | Self::Saving)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildStatus {
    pub id: String,
    pub workspace: String,
    pub phase: BuildPhase,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    #[serde(default, alias = "completedChunks")]
    pub completed_files: usize,
    #[serde(default, alias = "totalChunks")]
    pub total_files: usize,
    #[serde(default)]
    pub current_source: Option<String>,
    pub error: Option<String>,
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
