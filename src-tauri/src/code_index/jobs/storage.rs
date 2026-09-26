use super::{BuildPhase, BuildStatus, IndexSettings};
use anyhow::{Context, Result};
use serde::{de::DeserializeOwned, Serialize};
use std::path::Path;

fn read<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .with_context(|| format!("Reading {}", path.display()))
            .map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("Reading {}", path.display())),
    }
}

fn write(path: &Path, value: &impl Serialize) -> Result<()> {
    crate::code_index::persist::atomic_write(path, &serde_json::to_vec_pretty(value)?)
}

pub fn settings(dir: &Path) -> Result<IndexSettings> {
    Ok(read(&dir.join("settings.json"))?.unwrap_or_default())
}

pub fn save_settings(dir: &Path, settings: &IndexSettings) -> Result<()> {
    settings.validate()?;
    write(&dir.join("settings.json"), settings)
}

pub fn save_job(dir: &Path, status: &BuildStatus) -> Result<()> {
    write(&dir.join("build.json"), status)
}

/// A running marker without an app-owned task means the app stopped mid-build.
/// Reading this marker never restarts a paid request.
pub fn previous_job(dir: &Path) -> Result<Option<BuildStatus>> {
    let mut status: Option<BuildStatus> = read(&dir.join("build.json"))?;
    if let Some(job) = status.as_mut() {
        if job.phase.running() {
            job.phase = BuildPhase::Interrupted;
            job.error = Some(
                "The app closed before this build finished. Rebuild to continue using cached work."
                    .into(),
            );
        }
    }
    Ok(status)
}
