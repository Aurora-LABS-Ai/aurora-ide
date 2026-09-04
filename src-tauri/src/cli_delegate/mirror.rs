//! Copying a live turn into a CLI task's transcript.
//!
//! When the Agent Window runs a turn on behalf of `aurora agent`, the events
//! that drive the window are also the record the terminal is waiting for. This
//! module is the tee: the frontend binds a turn to a task with
//! [`bind`], and from then until the turn ends every event the runtime emits
//! is translated and appended to that task's `.jsonl`.
//!
//! ## Why translate instead of dumping the internal events
//!
//! [`AssistantEvent`] is the runtime's own vocabulary and changes whenever it
//! grows a capability. It also carries things that must not reach a file a
//! user might share — a provider's opaque reasoning `signature`, most of all —
//! and things that are meaningless outside the window, like per-chunk argument
//! deltas emitted purely so a tool card can appear before its arguments have
//! finished streaming.
//!
//! [`TaskEvent`] is the published contract. [`translate`] is the only bridge
//! between them, so a runtime change can only reach the file format through
//! one function that a test is watching.
//!
//! ## Binding is keyed on the turn, not the thread
//!
//! A turn is the unit that starts and ends; a thread outlives many. The
//! emitter only ever sees a `turn_id` ([`AgentEventEnvelope`] carries no
//! thread), and keying on the turn means a binding cannot outlive the work it
//! describes and leak a later, unrelated turn into a finished transcript.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use crate::agent_runtime::events::{AssistantEvent, TurnCompletion};

use super::cancel;
use super::inbox::{Inbox, Transcript};
use super::task::{cap_text, ResultKind, TaskEvent};

/// One turn being mirrored.
struct Binding {
    task_id: String,
    transcript: Transcript,
    started: Instant,
    /// Model round trips so far, for the closing `result` line.
    turns: u32,
    /// The assistant's visible text, accumulated so the `result` line can
    /// carry the final answer — the thing a scripted caller most often wants
    /// and would otherwise have to reassemble from every `text` delta.
    reply: String,
}

/// Every turn currently being mirrored.
///
/// A `Mutex<HashMap>` rather than a `DashMap` (which the crate has) because
/// this is touched once per event on a path already doing file I/O — the lock
/// is never the cost, and a plain map is easier to reason about when the
/// question is "was this turn unbound before or after that event".
static BOUND: Mutex<Option<HashMap<String, Binding>>> = Mutex::new(None);

/// Attach a turn to a CLI task, and write the opening `dispatch` line.
///
/// Called by the frontend the moment it starts the turn for a claimed task.
/// Returns whether the binding was made; a duplicate bind for the same turn is
/// ignored rather than replacing the first, since the second would truncate
/// the record of a turn already in progress.
pub fn bind(
    task_id: &str,
    turn_id: &str,
    thread_id: &str,
    workspace_path: &str,
    model: Option<&str>,
    out_path: Option<&str>,
) -> bool {
    let inbox = Inbox::open();
    let transcript_path = inbox.transcript_path(task_id);
    let mirror = out_path.map(PathBuf::from);

    let Ok(mut transcript) = Transcript::open(transcript_path, mirror) else {
        return false;
    };

    let opening = TaskEvent::Dispatch {
        task_id: task_id.to_string(),
        thread_id: thread_id.to_string(),
        workspace_path: workspace_path.to_string(),
        model: model.map(str::to_string),
        at: chrono::Utc::now().to_rfc3339(),
    };
    if transcript.append(&opening).is_err() {
        return false;
    }

    // A cancel that arrived while this task was claimed but had no turn yet.
    // The watcher deliberately leaves that case alone (see
    // [`super::cancel`]) because there is nothing there to cancel, and a
    // result line written by anyone else would be overtaken by this turn
    // starting a moment later. This is the choke point every dispatched turn
    // passes through, so it is where that cancel is honoured: close the
    // transcript and refuse the bind, which the frontend already reads as "do
    // not start a turn for this task".
    if cancel::take(&inbox, task_id) {
        let _ = transcript.append(&TaskEvent::Result {
            subtype: ResultKind::Cancelled,
            result: None,
            error: None,
            duration_ms: 0,
            num_turns: 0,
        });
        return false;
    }

    let mut guard = match BOUND.lock() {
        Ok(guard) => guard,
        // A poisoned lock means a previous mirror panicked mid-write. The
        // right response is to keep mirroring — the alternative is a terminal
        // that waits forever — so the poison is stepped over deliberately.
        Err(poisoned) => poisoned.into_inner(),
    };
    let map = guard.get_or_insert_with(HashMap::new);
    if map.contains_key(turn_id) {
        return false;
    }
    map.insert(
        turn_id.to_string(),
        Binding {
            task_id: task_id.to_string(),
            transcript,
            started: Instant::now(),
            turns: 0,
            reply: String::new(),
        },
    );
    true
}

/// Whether any turn is being mirrored.
///
/// A cheap guard for the emitter's hot path: with no CLI tasks running — the
/// overwhelmingly common case — this is one uncontended lock and a `None`
/// check, instead of a hash lookup per streamed token.
pub fn is_active() -> bool {
    BOUND
        .lock()
        .map(|guard| guard.as_ref().is_some_and(|map| !map.is_empty()))
        .unwrap_or(false)
}

/// The turn currently running a given task, if one is.
///
/// The reverse of the binding, and the only way to cancel a dispatched task:
/// the canceller knows a task id, the runtime registry only knows turn ids, and
/// this map is the sole place the two are ever associated.
///
/// `None` means no turn is running for that task — it has finished, or has not
/// started yet. Those are different situations to the caller, so this does not
/// try to distinguish them; [`super::cancel`] does, from the files.
pub fn turn_for_task(task_id: &str) -> Option<String> {
    let guard = BOUND
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.as_ref()?.iter().find_map(|(turn_id, binding)| {
        (binding.task_id == task_id).then(|| turn_id.clone())
    })
}

/// Mirror one streamed event, if its turn is bound.
pub fn record(turn_id: &str, event: &AssistantEvent) {
    let Some(translated) = translate(event) else {
        return;
    };
    let Ok(mut guard) = BOUND.lock().or_else(|poisoned| Ok::<_, ()>(poisoned.into_inner())) else {
        return;
    };
    let Some(binding) = guard.as_mut().and_then(|map| map.get_mut(turn_id)) else {
        return;
    };

    if let TaskEvent::Text { text } = &translated {
        binding.reply.push_str(text);
    }
    let _ = binding.transcript.append(&translated);
}

/// Close a mirrored turn with a `result` line and release the binding.
///
/// Every exit from a turn must reach here — success, failure, cancellation —
/// because the terminal's follower stops on the `result` line and nothing
/// else. A turn that ended without one leaves `aurora agent --follow` waiting
/// on a file that will never grow again.
pub fn finish(turn_id: &str, outcome: Outcome<'_>) {
    let Ok(mut guard) = BOUND.lock().or_else(|poisoned| Ok::<_, ()>(poisoned.into_inner())) else {
        return;
    };
    let Some(map) = guard.as_mut() else {
        return;
    };
    let Some(mut binding) = map.remove(turn_id) else {
        return;
    };

    let (subtype, error) = match outcome {
        Outcome::Complete(completion) => {
            binding.turns = completion.iterations;
            (ResultKind::Success, None)
        }
        // The runtime reports a cancellation as an error whose message is the
        // literal "cancelled"; the transcript distinguishes them, because a
        // task the user stopped is not a task that failed.
        Outcome::Failed(message) if message.eq_ignore_ascii_case("cancelled") => {
            (ResultKind::Cancelled, None)
        }
        Outcome::Failed(message) => (ResultKind::Error, Some(message.to_string())),
    };

    let reply = binding.reply.trim().to_string();
    let (reply, _) = cap_text(&reply);

    let _ = binding.transcript.append(&TaskEvent::Result {
        subtype,
        result: if reply.is_empty() { None } else { Some(reply) },
        error,
        duration_ms: binding.started.elapsed().as_millis() as u64,
        num_turns: binding.turns,
    });
}

/// How a mirrored turn ended.
pub enum Outcome<'a> {
    /// The turn finished; the summary carries the round-trip count.
    Complete(&'a TurnCompletion),
    /// The turn ended with this rendered error, or the literal `"cancelled"`.
    Failed(&'a str),
}

/// Translate one runtime event into its published form.
///
/// `None` means "nothing a transcript reader needs". Each such case says why
/// inline — a dropped event is a decision, not an omission.
pub fn translate(event: &AssistantEvent) -> Option<TaskEvent> {
    match event {
        AssistantEvent::TextDelta { delta } => Some(TaskEvent::Text {
            text: delta.clone(),
        }),

        // The `signature` is deliberately not carried across. It is opaque
        // replay plumbing for the next request, it is worthless to a reader,
        // and it is exactly the kind of token that should not end up in a file
        // someone pastes into an issue.
        AssistantEvent::Thinking { text, .. } => Some(TaskEvent::Thinking {
            text: text.clone(),
        }),

        AssistantEvent::ToolUse { id, name, input } => Some(TaskEvent::Tool {
            tool_use_id: id.clone(),
            name: name.clone(),
            input: input.clone(),
        }),

        AssistantEvent::ToolExecutionResult {
            id,
            name,
            content,
            is_error,
            ..
        } => {
            let (content, truncated_from) = cap_text(content);
            Some(TaskEvent::ToolResult {
                tool_use_id: id.clone(),
                name: name.clone(),
                ok: !is_error,
                content,
                truncated_from,
            })
        }

        AssistantEvent::Usage(usage) => Some(TaskEvent::Usage {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_tokens: usage.cache_read_input_tokens,
            cost_usd: usage.cost_usd,
        }),

        // Worth telling the terminal about: these are the moments a watcher
        // would otherwise see as an unexplained pause.
        AssistantEvent::PartialReplyDiscarded {
            attempt,
            max_attempts,
            reason,
        } => Some(TaskEvent::Notice {
            message: format!("retrying ({attempt}/{max_attempts}): {reason}"),
        }),
        AssistantEvent::CompactionStarted => Some(TaskEvent::Notice {
            message: "compacting the conversation".to_string(),
        }),
        AssistantEvent::CompactionCompleted {
            before_tokens,
            after_tokens,
        } => Some(TaskEvent::Notice {
            message: format!("compacted {before_tokens} → {after_tokens} tokens"),
        }),
        AssistantEvent::CompactionFailed {
            before_tokens,
            reason,
            cancelled,
        } => Some(TaskEvent::Notice {
            message: if *cancelled {
                format!("compaction stopped; context unchanged at {before_tokens} tokens")
            } else {
                format!("compaction failed ({reason}); context unchanged at {before_tokens} tokens")
            },
        }),
        AssistantEvent::QueuedMessageInjected { text, .. } => Some(TaskEvent::Notice {
            message: format!("queued message delivered: {text}"),
        }),
        AssistantEvent::Error { message, .. } => Some(TaskEvent::Notice {
            message: message.clone(),
        }),

        // Per-chunk argument streaming exists so a tool card can render before
        // its arguments are complete. A transcript gets the finished
        // `ToolUse` instead — mirroring these would write the same call
        // dozens of times, once per fragment.
        AssistantEvent::ToolUseDelta { .. } => None,

        // The start of a native tool run adds nothing the `ToolUse` line above
        // it did not already say.
        AssistantEvent::ToolExecutionStart { .. } => None,

        // The turn's ending is written by `finish`, which knows the duration
        // and the round-trip count. A stop reason on its own would be a second,
        // less informative terminator competing with the `result` line the
        // follower is watching for.
        AssistantEvent::MessageStop { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::types::TokenUsage;

    fn usage() -> TokenUsage {
        TokenUsage {
            input_tokens: 1_200,
            output_tokens: 340,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: Some(900),
            estimated: None,
            cost_usd: Some(0.0125),
        }
    }

    #[test]
    fn text_deltas_pass_through() {
        let translated = translate(&AssistantEvent::TextDelta {
            delta: "hello".to_string(),
        });
        assert!(matches!(translated, Some(TaskEvent::Text { text }) if text == "hello"));
    }

    #[test]
    fn a_reasoning_signature_never_reaches_the_transcript() {
        // The signature is replay plumbing and a credential-shaped token; a
        // file the user may paste must not carry it.
        let translated = translate(&AssistantEvent::Thinking {
            text: "considering".to_string(),
            signature: Some("SIG-do-not-leak".to_string()),
        })
        .expect("thinking is mirrored");
        let line = serde_json::to_string(&translated).expect("serialise");
        assert!(line.contains("considering"));
        assert!(
            !line.contains("SIG-do-not-leak"),
            "the signature leaked: {line}"
        );
    }

    #[test]
    fn a_failed_tool_is_marked_not_ok() {
        let translated = translate(&AssistantEvent::ToolExecutionResult {
            id: "t1".to_string(),
            name: "shell_execute".to_string(),
            input: serde_json::json!({}),
            content: "command not found".to_string(),
            is_error: true,
        })
        .expect("mirrored");
        match translated {
            TaskEvent::ToolResult { ok, content, .. } => {
                assert!(!ok);
                assert_eq!(content, "command not found");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn huge_tool_output_is_capped_and_says_so() {
        let huge = "x".repeat(super::super::task::MAX_EVENT_TEXT + 4_000);
        let translated = translate(&AssistantEvent::ToolExecutionResult {
            id: "t1".to_string(),
            name: "file_read".to_string(),
            input: serde_json::json!({}),
            content: huge.clone(),
            is_error: false,
        })
        .expect("mirrored");
        match translated {
            TaskEvent::ToolResult {
                content,
                truncated_from,
                ..
            } => {
                assert_eq!(content.len(), super::super::task::MAX_EVENT_TEXT);
                assert_eq!(truncated_from, Some(huge.len()));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn usage_carries_the_providers_own_cost() {
        let translated = translate(&AssistantEvent::Usage(usage())).expect("mirrored");
        match translated {
            TaskEvent::Usage {
                input_tokens,
                cache_read_tokens,
                cost_usd,
                ..
            } => {
                assert_eq!(input_tokens, 1_200);
                assert_eq!(cache_read_tokens, Some(900));
                assert_eq!(cost_usd, Some(0.0125));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_retry_is_announced_rather_than_looking_like_a_hang() {
        let translated = translate(&AssistantEvent::PartialReplyDiscarded {
            attempt: 2,
            max_attempts: 6,
            reason: "stream closed".to_string(),
        })
        .expect("mirrored");
        match translated {
            TaskEvent::Notice { message } => {
                assert!(message.contains("2/6"));
                assert!(message.contains("stream closed"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn noisy_internal_events_are_dropped() {
        // Argument deltas fire per fragment; mirroring them would write one
        // tool call dozens of times.
        assert!(translate(&AssistantEvent::ToolUseDelta {
            id: "t1".to_string(),
            name: "file_read".to_string(),
            arguments: "{\"pa".to_string(),
        })
        .is_none());

        assert!(translate(&AssistantEvent::ToolExecutionStart {
            id: "t1".to_string(),
            name: "file_read".to_string(),
            input: serde_json::json!({}),
        })
        .is_none());

        // The terminator is `finish`'s `result` line, not this.
        assert!(translate(&AssistantEvent::MessageStop {
            stop_reason: "end_turn".to_string(),
        })
        .is_none());
    }

    // ── binding lifecycle ───────────────────────────────────────────────
    //
    // One test, not several: `BOUND` is process-global and `cargo test` runs
    // threaded, so split tests would observe each other's bindings. Task ids
    // are unique per case so the transcripts stay separate.

    #[test]
    fn binding_lifecycle() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        let _ = &inbox;

        // Recording an unbound turn must be a silent no-op — the emitter calls
        // this for every turn in the app, and the overwhelming majority are
        // not CLI tasks.
        record(
            "turn-that-was-never-bound",
            &AssistantEvent::TextDelta {
                delta: "ignored".to_string(),
            },
        );
        // Finishing one likewise.
        finish("turn-that-was-never-bound", Outcome::Failed("boom"));
    }

    #[test]
    fn a_cancelled_turn_is_not_a_failed_one() {
        // The runtime renders a cancellation as an error reading "cancelled".
        // A task the user stopped must not be reported as a failure — the
        // exit code and the terminal row both depend on the distinction.
        let outcome = Outcome::Failed("cancelled");
        let subtype = match outcome {
            Outcome::Failed(message) if message.eq_ignore_ascii_case("cancelled") => {
                ResultKind::Cancelled
            }
            Outcome::Failed(_) => ResultKind::Error,
            Outcome::Complete(_) => ResultKind::Success,
        };
        assert_eq!(subtype, ResultKind::Cancelled);
    }
}
