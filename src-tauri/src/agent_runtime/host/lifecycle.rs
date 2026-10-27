//! Conversation deletion, including the runtime work owned by a parent.

use super::*;
use crate::agent_runtime::subagents::{
    record::StopBy,
    store::{child_store_for, AgentSidecar},
};
use std::collections::BTreeSet;
use std::time::Duration;

pub async fn delete_conversation(
    registry: Arc<AgentRegistry>,
    thread_id: String,
) -> Result<(), RuntimeError> {
    crate::agent_runtime::project_dir::validate_thread_id(&thread_id)?;
    let _admission = registry.subagent_tasks().lock_agent(&thread_id).await;
    let lookup_registry = registry.clone();
    let lookup_id = thread_id.clone();
    let (store, mut ids) = tokio::task::spawn_blocking(move || {
        let store = lookup_registry.store_for_thread(&lookup_id)?;
        let ids = store
            .as_ref()
            .map(|store| {
                AgentSidecar::list_in(&child_store_for(store, &lookup_id))
                    .into_iter()
                    .filter(|row| row.parent_thread_id == lookup_id)
                    .map(|row| row.agent_id)
                    .collect::<BTreeSet<_>>()
            })
            .unwrap_or_default();
        Ok::<_, RuntimeError>((store, ids))
    })
    .await
    .map_err(|e| RuntimeError::InvalidState(format!("conversation lookup failed: {e}")))??;
    let records = registry.subagent_tasks().for_parent(&thread_id);
    ids.insert(thread_id.clone());
    ids.extend(records.iter().map(|record| record.agent_id.clone()));
    for id in &ids {
        registry.mark_thread_deleted(id);
        registry.cancel_thread(id);
    }
    for record in &records {
        record.kill(StopBy::ParentDeleted);
    }

    let stopping = async {
        for record in &records {
            if !record.wait_finished(Duration::from_secs(30)).await {
                return Err(RuntimeError::InvalidState(format!(
                    "agent {} did not stop; conversation was not deleted",
                    record.agent_id
                )));
            }
            // Finish commits and emits while holding this lock. Wait for all
            // those writes before removing the folder they belong to.
            drop(registry.subagent_tasks().lock_agent(&record.agent_id).await);
        }
        for id in &ids {
            registry.wait_thread_idle(id).await;
        }
        stop_owned_processes(&ids).await
    };
    let stopped = tokio::time::timeout(Duration::from_secs(30), stopping).await
        .unwrap_or_else(|_| Err(RuntimeError::InvalidState("Work did not stop within 30 seconds; conversation was not deleted. Retry deletion after it stops.".into())));
    let result = match stopped {
        Err(error) => Err(error),
        Ok(()) => match store {
            None => Ok(()),
            Some(store) => {
                let deleting_registry = registry.clone();
                let deleting_id = thread_id.clone();
                tokio::task::spawn_blocking(move || {
                    if store.dir() == deleting_registry.chat_store().dir() {
                        if let Some(memory) = crate::chat_memory::service() {
                            let _ = memory.forget_chat(&deleting_id);
                        }
                    }
                    store.delete(&deleting_id)
                })
                .await
                .unwrap_or_else(|e| {
                    Err(RuntimeError::InvalidState(format!(
                        "conversation deletion failed: {e}"
                    )))
                })
            }
        },
    };
    match result {
        Ok(()) => {
            for id in &ids {
                registry.forget_thread_runtime(id);
                if id != &thread_id {
                    registry.subagent_tasks().evict(id);
                }
            }
            Ok(())
        }
        Err(error) => {
            for id in &ids {
                registry.rollback_thread_deletion(id);
            }
            Err(error)
        }
    }
}

async fn stop_owned_processes(ids: &BTreeSet<String>) -> Result<(), RuntimeError> {
    let owned = ids.clone();
    tokio::task::spawn_blocking(move || {
        for process in crate::process::streams::list_command_streams() {
            if !process
                .thread_id
                .as_ref()
                .is_some_and(|id| owned.contains(id))
            {
                continue;
            }
            if let Err(error) = crate::process::streams::cancel_tracked_command_stream(
                &process.request_id,
                crate::process::streams::StopReason::User,
            ) {
                if crate::process::streams::list_command_streams()
                    .iter()
                    .any(|current| current.request_id == process.request_id)
                {
                    return Err(RuntimeError::InvalidState(format!(
                        "could not stop conversation process {}: {error}",
                        process.process_id
                    )));
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| RuntimeError::InvalidState(format!("process cleanup failed: {e}")))??;
    while crate::process::streams::list_command_streams()
        .iter()
        .any(|process| {
            process
                .thread_id
                .as_ref()
                .is_some_and(|id| ids.contains(id))
        })
    {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Ok(())
}
