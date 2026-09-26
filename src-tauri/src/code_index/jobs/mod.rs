//! App-owned indexing jobs. UI windows only start jobs and read snapshots.
//! Project identity, output directory, settings are captured once.

mod storage;
#[cfg(test)]
mod tests;
mod types;

pub use storage::{save_settings, settings};
pub use types::{BuildPhase, BuildStatus, IndexSettings};

use super::service;
use anyhow::{Context, Result};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

struct Job {
    directory: PathBuf,
    status: Mutex<BuildStatus>,
    cancel: CancellationToken,
}

impl Job {
    fn snapshot(&self) -> BuildStatus {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn progress(&self, phase: BuildPhase, completed: usize, total: usize) {
        let mut status = self.status.lock().unwrap_or_else(|e| e.into_inner());
        status.phase = phase;
        status.completed_files = completed;
        status.total_files = total;
    }


}

pub struct BuildManager {
    // The resolved project data directory is collision-safe and shared by all windows.
    jobs: Mutex<HashMap<PathBuf, Arc<Job>>>,
    slots: Arc<Semaphore>,
}

impl Default for BuildManager {
    fn default() -> Self {
        Self {
            jobs: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(2)),
        }
    }
}

static MANAGER: LazyLock<BuildManager> = LazyLock::new(BuildManager::default);
pub fn manager() -> &'static BuildManager {
    &MANAGER
}

impl BuildManager {
    fn reserve(
        &self,
        root: &Path,
        directory: PathBuf,
    ) -> Result<Arc<Job>> {
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        anyhow::ensure!(
            !jobs
                .get(&directory)
                .is_some_and(|job| job.snapshot().phase.running()),
            "This project is already being indexed."
        );
        let job = Arc::new(Job {
            directory: directory.clone(),
            cancel: CancellationToken::new(),
            status: Mutex::new(BuildStatus {
                id: uuid::Uuid::new_v4().to_string(),
                workspace: root.to_string_lossy().into_owned(),
                phase: BuildPhase::Queued,
                started_at: types::now(),
                finished_at: None,
                completed_files: 0,
                total_files: 0,
                current_source: None,
                error: None,
            }),
        });
        storage::save_job(&directory, &job.snapshot())?;
        jobs.insert(directory, job.clone());
        Ok(job)
    }

    /// Called on a blocking thread. No selected-project state is consulted later.
    pub fn start(
        &self,
        root: PathBuf,
        directory: PathBuf,
    ) -> Result<BuildStatus> {
        let job = self.reserve(&root, directory)?;
        let initial = job.snapshot();
        let slots = self.slots.clone();
        // The runtime, not the IPC future or mounted settings page, owns this task.
        tauri::async_runtime::spawn(async move {
            let work = job.clone();
            let outcome = tokio::spawn(async move { run(root, work, slots).await }).await;
            let result =
                outcome.unwrap_or_else(|e| Err(anyhow::anyhow!("Indexing task stopped: {e}")));
            finish(job, result).await;
        });
        Ok(initial)
    }

    pub fn status(&self, directory: &Path) -> Result<Option<BuildStatus>> {
        let jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(job) = jobs.get(directory) {
            return Ok(Some(job.snapshot()));
        }
        storage::previous_job(directory)
    }

    pub fn delete_idle(&self, directory: &Path, delete: impl FnOnce() -> Result<()>) -> Result<()> {
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        anyhow::ensure!(!jobs.get(directory).is_some_and(|job| job.snapshot().phase.running()),
            "Stop this project's build before deleting its index.");
        delete()?;
        jobs.remove(directory);
        Ok(())
    }

    pub fn cancel(&self, directory: &Path) -> Result<()> {
        let jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        let job = jobs
            .get(directory)
            .context("No build is running for this project.")?;
        anyhow::ensure!(
            job.snapshot().phase.running(),
            "No build is running for this project."
        );
        job.cancel.cancel();
        Ok(())
    }
}

async fn run(
    root: PathBuf,
    job: Arc<Job>,
    slots: Arc<Semaphore>,
) -> Result<()> {
    let _permit = tokio::select! {
        _ = job.cancel.cancelled() => anyhow::bail!("Build cancelled."),
        permit = slots.acquire_owned() => permit?,
    };
    job.progress(BuildPhase::Indexing, 0, 0);
    let workspace = root.clone();
    let cancel = job.cancel.clone();
    let progress_job = job.clone();
    tokio::task::spawn_blocking(move || service().rebuild_with_progress(&workspace, &cancel, &|done, total, path| {
        let mut status = progress_job.status.lock().unwrap_or_else(|e| e.into_inner());
        status.completed_files = status.completed_files.max(done);
        status.total_files = total;
        status.current_source = Some(path.to_string());
    })).await??;
    Ok(())
}

async fn finish(job: Arc<Job>, result: Result<()>) {
    let mut status = job.snapshot();
    // Success wins a cancellation arriving after publication.
    status.phase = match &result {
        Ok(_) => BuildPhase::Complete,
        Err(_) if job.cancel.is_cancelled() => BuildPhase::Cancelled,
        Err(_) => BuildPhase::Failed,
    };
    status.error = result.err().map(|e| format!("{e:#}"));
    status.finished_at = Some(types::now());
    let dir = job.directory.clone();
    let record = status.clone();
    if let Err(error) = tokio::task::spawn_blocking(move || storage::save_job(&dir, &record))
        .await
        .context("Saving build status")
        .and_then(|r| r)
    {
        status.phase = BuildPhase::Failed;
        status.error = Some(format!("Could not save build status: {error:#}"));
    }
    *job.status.lock().unwrap_or_else(|e| e.into_inner()) = status;
}
