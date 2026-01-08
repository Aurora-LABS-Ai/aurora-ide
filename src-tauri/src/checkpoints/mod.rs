mod service;
mod types;

pub use service::CheckpointService;
pub use types::Checkpoint;

// Re-export for potential external use (suppress unused warnings)
#[allow(unused_imports)]
pub use types::{CheckpointError, CheckpointResult};
