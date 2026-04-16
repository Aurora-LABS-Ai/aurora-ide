use std::sync::Arc;

use notify::RecommendedWatcher;
use parking_lot::{Mutex, MutexGuard};

use super::service::ExplorerManager;

/// Shared explorer state managed by the Tauri backend.
#[derive(Clone, Default)]
pub struct ExplorerStateHandle {
    inner: Arc<ExplorerStateInner>,
}

#[derive(Default)]
struct ExplorerStateInner {
    manager: Mutex<ExplorerManager>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl ExplorerStateHandle {
    /// Lock the explorer manager for a short mutation.
    pub fn lock_manager(&self) -> MutexGuard<'_, ExplorerManager> {
        self.inner.manager.lock()
    }

    /// Replace the active filesystem watcher for the current workspace.
    pub fn replace_watcher(&self, watcher: RecommendedWatcher) {
        *self.inner.watcher.lock() = Some(watcher);
    }

    /// Drop the active filesystem watcher.
    pub fn clear_watcher(&self) {
        *self.inner.watcher.lock() = None;
    }
}
