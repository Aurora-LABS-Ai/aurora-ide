use super::*;

fn reserve(manager: &BuildManager, root: &Path, dir: &Path) -> Arc<Job> {
    manager
        .reserve(root, dir.to_path_buf())
        .unwrap()
}

#[test]
fn different_projects_build_independently_and_same_project_cannot_duplicate() {
    let temp = tempfile::tempdir().unwrap();
    let manager = BuildManager::default();
    let a_dir = temp.path().join("a/code-index");
    let b_dir = temp.path().join("b/code-index");
    let a = reserve(&manager, Path::new("/a"), &a_dir);
    let b = reserve(&manager, Path::new("/b"), &b_dir);
    a.progress(BuildPhase::Indexing, 3, 10);
    assert_eq!(manager.status(&a_dir).unwrap().unwrap().workspace, "/a");
    assert_eq!(manager.status(&b_dir).unwrap().unwrap().completed_files, 0);
    assert!(manager
        .reserve(Path::new("/a"), a_dir.clone())
        .is_err());
    manager.cancel(&a_dir).unwrap();
    assert!(a.cancel.is_cancelled());
    assert!(!b.cancel.is_cancelled());
    assert!(a_dir.join("build.json").exists());
    assert!(b_dir.join("build.json").exists());
}

#[test]
fn old_ai_settings_are_ignored_and_local_limits_are_validated() {
    let old: IndexSettings = serde_json::from_str(r#"{"aiEnabled":true,"modelSelection":"p:m","processing":{"outputTokens":10}}"#).unwrap();
    assert_eq!(old, IndexSettings::default());
    let temp = tempfile::tempdir().unwrap();
    save_settings(temp.path(), &old).unwrap();
    let mut bad = old.clone(); bad.search_bytes = 0;
    assert!(save_settings(temp.path(), &bad).is_err());
    assert_eq!(settings(temp.path()).unwrap(), old);
    assert!(!std::fs::read_to_string(temp.path().join("settings.json")).unwrap().contains("model"));
}

#[test]
fn active_jobs_block_deletion() {
    let temp = tempfile::tempdir().unwrap();
    let manager = BuildManager::default();
    reserve(&manager, Path::new("/a"), temp.path());
    let mut called = false;
    assert!(manager.delete_idle(temp.path(), || { called = true; Ok(()) }).is_err());
    assert!(!called);
}

#[test]
fn restart_marks_unfinished_work_interrupted_without_restarting_it() {
    let temp = tempfile::tempdir().unwrap();
    let old_manager = BuildManager::default();
    reserve(&old_manager, Path::new("/a"), temp.path());
    let restarted = BuildManager::default();
    let status = restarted.status(temp.path()).unwrap().unwrap();
    assert_eq!(status.phase, BuildPhase::Interrupted);
    assert!(status.error.unwrap().contains("app closed"));
}

#[tokio::test]
async fn failure_persists_and_releases_project_for_retry() {
    let temp = tempfile::tempdir().unwrap();
    let manager = BuildManager::default();
    let job = reserve(&manager, Path::new("/a"), temp.path());
    std::fs::write(temp.path().join("structural.json"), "last good index").unwrap();
    finish(job, Err(anyhow::anyhow!("Provider unavailable"))).await;
    let failed = manager.status(temp.path()).unwrap().unwrap();
    assert_eq!(failed.phase, BuildPhase::Failed);
    assert_eq!(failed.error.as_deref(), Some("Provider unavailable"));
    assert_eq!(
        std::fs::read_to_string(temp.path().join("structural.json")).unwrap(),
        "last good index"
    );
    assert_eq!(
        BuildManager::default()
            .status(temp.path())
            .unwrap()
            .unwrap()
            .phase,
        BuildPhase::Failed
    );
    reserve(&manager, Path::new("/a"), temp.path());
}

