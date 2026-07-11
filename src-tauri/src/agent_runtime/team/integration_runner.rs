//! `run_integration` — the **integration & peer-review gate** (ground truth
//! §9 step 5, §14, §16 Phase 4).
//!
//! After the parallel build (Phase 3) the team is in [`TeamPhase::Integrating`].
//! This module closes the loop the way a real team does before merging:
//!
//! 1. **Peer review.** Each scoped IC reviews a teammate's work (round-robin:
//!    IC *i* reviews IC *i+1*). The reviewer is shown the target's role +
//!    owned-scope file listing and returns a verdict; the verdict is recorded
//!    to the channel ([`ChannelEventKind::ReviewVerdict`]) and the
//!    `integration/reviews/` thread via [`TeamSession::record_review`].
//! 2. **Build / lint / test gate.** The Lead runs the configured gate commands
//!    in the real repo; each command's exit status maps to a [`GateStatus`]
//!    written to `integration/status.json` ([`TeamSession::set_gate_status`]).
//!    Commands are opt-in — a `None` command leaves that gate `Unknown`.
//! 3. **Finish.** [`TeamSession::finish_integration`] moves the team to
//!    [`TeamPhase::Done`] when no gate failed, else keeps it integrating.
//!
//! Like the other runners it reuses Aurora's provider stack
//! ([`StreamingApiClient`]) and the [`TeamSession`] control surface; every
//! mutation flows through the [`TeamBus`] so it persists **and** streams live.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::api_client::StreamingApiClient;
use crate::agent_runtime::error::RuntimeError;
use crate::api::{build_api_client, ProviderConfigSnapshot};

use super::bus::{TeamBus, TeamStreamer};
use super::orchestrator::{TeamSession, LEAD_AGENT_ID};
use super::runner::{complete_text, extract_json_object, resolved_max_tokens};
use super::scope_guard;
use super::types::{
    AgentRecord, AgentStatus, GateStatus, ReviewVerdict, ScopeMap, TeamProjectState,
};
use super::workspace::{now_rfc3339, DEFAULT_CHANNEL_TAIL};

/// Cap on files listed per reviewed scope (keeps the review prompt bounded).
const SCOPE_LISTING_CAP: usize = 40;
/// Hidden gate commands must not strand a background team run forever.
const GATE_COMMAND_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// The gate commands the Lead runs, one per check. Each is optional — a
/// `None` leaves that gate `Unknown` (skipped). IPC-friendly (`camelCase`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateCommands {
    #[serde(default)]
    pub build: Option<String>,
    #[serde(default)]
    pub lint: Option<String>,
    #[serde(default)]
    pub test: Option<String>,
}

// ─── public entry point ───────────────────────────────────────────────────

/// Run the integration & peer-review gate for a repo and return the settled
/// brain snapshot. Reviews run on `team_provider`; gate commands run in the
/// real repo at `repo_path`.
pub async fn run_integration(
    bus: &TeamBus,
    repo_path: &str,
    team_provider: &ProviderConfigSnapshot,
    gate: &GateCommands,
) -> Result<TeamProjectState, RuntimeError> {
    let session = TeamSession::open(repo_path)?;
    let client = build_api_client(team_provider);
    let model = team_provider.model.clone();
    // Review budget from the user's model settings, never a hardcode (reasoning
    // models need room to think before emitting the verdict JSON).
    let max_tokens = resolved_max_tokens(team_provider);
    run_integration_inner(
        bus,
        &session,
        Path::new(repo_path),
        &client,
        &model,
        max_tokens,
        gate,
    )
    .await?;
    session.workspace().load_state(Some(DEFAULT_CHANNEL_TAIL))
}

/// Testable core: drive integration over an already-opened session with an
/// injected review client. `run_integration` is the thin production wrapper.
async fn run_integration_inner(
    bus: &TeamBus,
    session: &TeamSession,
    repo_root: &Path,
    review_client: &Arc<dyn StreamingApiClient>,
    review_model: &str,
    review_max: u32,
    gate: &GateCommands,
) -> Result<(), RuntimeError> {
    let team = session
        .workspace()
        .read_team()?
        .ok_or_else(|| RuntimeError::InvalidState("team.json missing; convene first".into()))?;
    let scope = session
        .workspace()
        .read_scope_map()?
        .unwrap_or_else(|| ScopeMap::empty(now_rfc3339()));

    let scoped_ics: Vec<AgentRecord> = team
        .agents
        .iter()
        .filter(|a| a.id != LEAD_AGENT_ID)
        .filter(|a| owned_paths_of(&scope, &a.id).is_some_and(|p| !p.is_empty()))
        .cloned()
        .collect();

    // 1. Peer review (round-robin), **all reviews concurrently** — like the
    //    build phase, the model calls dominate and the joined futures share
    //    one task, so the synchronous brain mutations never interleave.
    //    Needs at least two scoped ICs to have a peer; a solo build skips
    //    straight to the gate.
    if scoped_ics.len() >= 2 {
        let cancel = CancellationToken::new();
        let project_id = session.workspace().project_id().to_string();
        let review_futures = scoped_ics.iter().enumerate().map(|(i, reviewer)| {
            let target = &scoped_ics[(i + 1) % scoped_ics.len()];
            let owned = owned_paths_of(&scope, &target.id).unwrap_or_default();
            let listing = list_scope_files(repo_root, &owned);
            let excerpts = read_scope_excerpts(repo_root, &owned);

            let system = review_prompt(&reviewer.role);
            let user = format!(
                "Review the work of \"{}\" (agent id: {}), who owns: {}.\n\nFiles in their scope:\n{}\n\nTheir actual code:\n{}",
                target.role,
                target.id,
                if owned.is_empty() { "(none)".into() } else { owned.join(", ") },
                listing,
                excerpts
            );
            let cancel = cancel.clone();
            let project_id = project_id.clone();
            async move {
                // Flip to Reviewing BEFORE the model call so the team window
                // shows who's reviewing while the review is in flight.
                session.set_agent_status(&reviewer.id, AgentStatus::Reviewing)?;
                // Stream the reviewer's work live to the Team view. The reply
                // is verdict JSON — machine output, not chat — so route its
                // text as "reasoning"; the authoritative `review_verdict`
                // event (with human comments) lands right after.
                let streamer =
                    TeamStreamer::new(bus, project_id, reviewer.id.clone(), "integrating", None)
                        .text_as_thinking();
                let raw = complete_text(
                    review_client,
                    review_model,
                    &system,
                    &user,
                    review_max,
                    &cancel,
                    Some(&streamer),
                )
                .await
                .unwrap_or_else(|e| format!("(review skipped: {e})"));
                let (verdict, comments) = parse_review(&raw);

                session.record_review(bus, &reviewer.id, &target.id, verdict, &comments)?;
                session.set_agent_status(&reviewer.id, AgentStatus::Done)?;
                Ok::<ReviewVerdict, RuntimeError>(verdict)
            }
        });
        let mut changes_requested = 0usize;
        for outcome in futures::future::join_all(review_futures).await {
            if matches!(outcome?, ReviewVerdict::ChangesRequested) {
                changes_requested += 1;
            }
        }
        if changes_requested > 0 {
            return Err(RuntimeError::InvalidState(format!(
                "peer review requested changes in {changes_requested} review(s); integration is blocked until the team fixes them"
            )));
        }
    }

    // 2. Build / lint / test gate (opt-in commands run in the real repo).
    //    Each command is ANNOUNCED to the channel before it runs and its
    //    result posted after — these run invisibly as OS processes (no
    //    terminal in the IDE shows them), so without these lines the user
    //    sees "pnpm build" in logs and nowhere else, which reads as the
    //    agent doing things behind their back.
    let build = run_gate_cmd_visible(bus, session, repo_root, "build", gate.build.as_deref()).await;
    let lint = run_gate_cmd_visible(bus, session, repo_root, "lint", gate.lint.as_deref()).await;
    let test = run_gate_cmd_visible(bus, session, repo_root, "test", gate.test.as_deref()).await;
    session.set_gate_status(bus, build, lint, test)?;

    // 3. Finish: Done when nothing failed, else stay integrating.
    session.finish_integration(bus)?;
    Ok(())
}

// ─── gate execution ───────────────────────────────────────────────────────

/// [`run_gate_cmd`] wrapped with channel visibility: announces the command
/// before it runs and posts its verdict after, so the user can SEE the gate
/// executing (e.g. `pnpm build`) in the Team window instead of it happening
/// as an invisible background process. Best-effort posts — a bus failure
/// never aborts the gate.
async fn run_gate_cmd_visible(
    bus: &TeamBus,
    session: &TeamSession,
    repo_root: &Path,
    name: &str,
    command: Option<&str>,
) -> GateStatus {
    let Some(cmd) = command.map(str::trim).filter(|c| !c.is_empty()) else {
        return GateStatus::Unknown;
    };
    let _ = post_gate_note(
        bus,
        session,
        format!("Gate {name}: running `{cmd}` in the repo…"),
        name,
        "running",
    );
    let status = run_gate_cmd(repo_root, Some(cmd)).await;
    let (verdict, tag) = match status {
        GateStatus::Passed => (format!("Gate {name} passed (`{cmd}`)"), "passed"),
        GateStatus::Failed => (format!("Gate {name} failed (`{cmd}`)"), "failed"),
        GateStatus::Unknown | GateStatus::Pending => (format!("Gate {name} skipped"), "skipped"),
    };
    let _ = post_gate_note(bus, session, verdict, name, tag);
    status
}

/// Post one Lead gate line to the channel (persist + broadcast). The structured
/// `meta` (gate name + status) lets the Team view render/colour the note without
/// parsing emoji out of the body.
fn post_gate_note(
    bus: &TeamBus,
    session: &TeamSession,
    body: String,
    gate_name: &str,
    status: &str,
) -> Result<(), RuntimeError> {
    bus.post(
        session.workspace(),
        super::types::ChannelEvent {
            id: uuid::Uuid::new_v4().to_string(),
            ts: now_rfc3339(),
            author: LEAD_AGENT_ID.to_string(),
            kind: super::types::ChannelEventKind::System,
            body,
            meta: Some(serde_json::json!({
                "gate": true,
                "gateName": gate_name,
                "gateStatus": status,
            })),
        },
    )
    .map(|_| ())
}

/// Run one gate command in `repo_root` and map its exit status to a
/// [`GateStatus`]: `None` → `Unknown` (skipped), exit 0 → `Passed`, anything
/// else (non-zero or spawn failure) → `Failed`.
async fn run_gate_cmd(repo_root: &Path, command: Option<&str>) -> GateStatus {
    run_gate_cmd_with_timeout(repo_root, command, GATE_COMMAND_TIMEOUT).await
}

async fn run_gate_cmd_with_timeout(
    repo_root: &Path,
    command: Option<&str>,
    timeout: Duration,
) -> GateStatus {
    let Some(cmd) = command.map(str::trim).filter(|c| !c.is_empty()) else {
        return GateStatus::Unknown;
    };
    let mut process = if cfg!(windows) {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(cmd);
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c").arg(cmd);
        c
    };
    process.current_dir(repo_root);
    process.kill_on_drop(true);
    let Ok(mut child) = process.spawn() else {
        return GateStatus::Failed;
    };
    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) if status.success() => GateStatus::Passed,
        Ok(Ok(_)) => GateStatus::Failed,
        Ok(Err(_)) => GateStatus::Failed,
        Err(_) => {
            let _ = child.kill().await;
            GateStatus::Failed
        }
    }
}

// ─── scope listing + review parsing ─────────────────────────────────────────

fn owned_paths_of(scope: &ScopeMap, agent_id: &str) -> Option<Vec<String>> {
    scope
        .assignments
        .iter()
        .find(|a| a.agent_id == agent_id)
        .map(|a| a.owned_paths.clone())
}

/// Render a bounded file listing (path + size) for a reviewed agent's owned
/// paths, so the reviewer has something concrete to assess.
fn list_scope_files(repo_root: &Path, owned: &[String]) -> String {
    if owned.is_empty() {
        return "(no owned paths)".to_string();
    }
    let mut out = Vec::new();
    let mut count = 0usize;
    for p in owned {
        let Some(norm) = scope_guard::normalize_repo_rel(p) else {
            continue;
        };
        let base = repo_root.join(&norm);
        if !base.exists() {
            out.push(format!("{norm}/ (not created yet)"));
            continue;
        }
        if base.is_file() {
            out.push(format!("- {norm}"));
            count += 1;
        } else {
            collect_files(&base, repo_root, &mut out, &mut count);
        }
    }
    if out.is_empty() {
        "(no files)".to_string()
    } else {
        out.join("\n")
    }
}

/// Total/per-file byte caps for the review code excerpts (keeps the review
/// prompt bounded even for a large scope).
const REVIEW_EXCERPT_TOTAL_CAP: usize = 12_000;
const REVIEW_EXCERPT_PER_FILE_CAP: usize = 2_500;

/// Read the **actual file contents** under a reviewed agent's owned paths
/// (bounded) so the reviewer assesses real code, not just a directory listing.
fn read_scope_excerpts(repo_root: &Path, owned: &[String]) -> String {
    let mut files: Vec<PathBuf> = Vec::new();
    for p in owned {
        let Some(norm) = scope_guard::normalize_repo_rel(p) else {
            continue;
        };
        let base = repo_root.join(&norm);
        if base.is_file() {
            files.push(base);
        } else if base.is_dir() {
            collect_file_paths(&base, &mut files);
        }
    }
    if files.is_empty() {
        return "(no files written yet)".to_string();
    }

    let mut out = String::new();
    let mut total = 0usize;
    for f in files {
        if total >= REVIEW_EXCERPT_TOTAL_CAP {
            out.push_str("\n…(more files omitted)…\n");
            break;
        }
        let rel = f
            .strip_prefix(repo_root)
            .unwrap_or(&f)
            .to_string_lossy()
            .replace('\\', "/");
        let Ok(content) = std::fs::read_to_string(&f) else {
            continue;
        };
        let slice: String = content.chars().take(REVIEW_EXCERPT_PER_FILE_CAP).collect();
        let truncated = slice.len() < content.len();
        out.push_str(&format!(
            "\n----- {rel} -----\n{slice}{}\n",
            if truncated { "\n…(truncated)…" } else { "" }
        ));
        total += slice.len();
    }
    out
}

/// Collect file paths under a directory (bounded by [`SCOPE_LISTING_CAP`]).
fn collect_file_paths(dir: &Path, out: &mut Vec<PathBuf>) {
    if out.len() >= SCOPE_LISTING_CAP {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= SCOPE_LISTING_CAP {
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_file_paths(&path, out);
        } else {
            out.push(path);
        }
    }
}

fn collect_files(dir: &Path, repo_root: &Path, out: &mut Vec<String>, count: &mut usize) {
    if *count >= SCOPE_LISTING_CAP {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if *count >= SCOPE_LISTING_CAP {
            out.push("…(more files omitted)".to_string());
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, repo_root, out, count);
        } else {
            let rel = path.strip_prefix(repo_root).unwrap_or(&path);
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(format!(
                "- {} ({size} bytes)",
                rel.to_string_lossy().replace('\\', "/")
            ));
            *count += 1;
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct ReviewReply {
    #[serde(default)]
    verdict: String,
    #[serde(default)]
    comments: String,
}

/// Parse a reviewer's reply into a verdict + comments. Tries JSON first
/// (whole reply, then the outermost `{…}`), then falls back to a prose scan.
fn parse_review(raw: &str) -> (ReviewVerdict, String) {
    let parsed = serde_json::from_str::<ReviewReply>(raw)
        .ok()
        .or_else(|| extract_json_object(raw).and_then(|s| serde_json::from_str(&s).ok()));

    if let Some(reply) = parsed {
        let verdict = verdict_from_str(&reply.verdict);
        let comments = if reply.comments.trim().is_empty() {
            "(no comments)".to_string()
        } else {
            reply.comments.trim().to_string()
        };
        return (verdict, comments);
    }

    // No JSON — infer from prose.
    let verdict = verdict_from_str(raw);
    let comments = if raw.trim().is_empty() {
        "(no comments)".to_string()
    } else {
        raw.trim().chars().take(400).collect()
    };
    (verdict, comments)
}

/// Map a verdict string (the JSON `verdict` field, or a prose reply as a last
/// resort) to a [`ReviewVerdict`].
///
/// The old bare `contains("change")` scan false-positived on the most common
/// approving phrases — "no changes needed", "nothing to change", "no concerns"
/// — forcing needless rework passes that could ultimately fail a healthy run.
/// So: an explicit machine verdict wins; an explicit approval wins; a negated
/// phrase ("no changes") is an approval; only a genuine ask for work flips to
/// `ChangesRequested`. When nothing clearly signals rework, default to
/// `Approve` (the reviewer would have to actively request changes to block).
fn verdict_from_str(s: &str) -> ReviewVerdict {
    let lower = s.to_lowercase();

    // 1. Explicit machine verdict (what the JSON `verdict` field carries).
    if lower.contains("changes_requested") || lower.contains("changes requested") {
        return ReviewVerdict::ChangesRequested;
    }
    if lower.contains("approve") || lower.contains("lgtm") || lower.contains("looks good") {
        return ReviewVerdict::Approve;
    }

    // 2. Explicit approval expressed as a negation of change.
    const NEGATED_APPROVALS: &[&str] = &[
        "no change",
        "no further change",
        "nothing to change",
        "without changes",
        "no concern",
        "no issue",
        "no blocker",
        "not blocking",
    ];
    if NEGATED_APPROVALS.iter().any(|n| lower.contains(n)) {
        return ReviewVerdict::Approve;
    }

    // 3. A genuine ask for work — only these prose phrases flip to rework.
    const CHANGE_REQUESTS: &[&str] = &[
        "request change",
        "requesting change",
        "needs change",
        "need change",
        "changes needed",
        "should change",
        "must change",
        "please fix",
        "needs fixing",
        "needs work",
        "reject",
        "concern",
        "blocking",
        "block integration",
    ];
    if CHANGE_REQUESTS.iter().any(|p| lower.contains(p)) {
        ReviewVerdict::ChangesRequested
    } else {
        ReviewVerdict::Approve
    }
}

// ─── prompt ─────────────────────────────────────────────────────────────────

fn review_prompt(reviewer_role: &str) -> String {
    format!(
        "You are \"{reviewer_role}\", an IC on an AI engineering team in the Aurora IDE. The build is done and you are in PEER REVIEW: assess a teammate's work before integration.

Judge whether their scope looks complete and coherent for the team's goal. Be constructive and terse.

Respond with ONLY a JSON object — no prose, no markdown fences — in exactly this shape:
{{\"verdict\":\"approve\"|\"changes_requested\",\"comments\":\"<one or two sentences>\"}}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::api_client::{ApiError, ApiRequest, TurnUsage};
    use crate::agent_runtime::events::AssistantEvent;
    use crate::agent_runtime::team::orchestrator::{AgentSpec, ConveneRequest};
    use crate::agent_runtime::team::types::TeamPhase;
    use crate::agent_runtime::team::workspace::ProjectWorkspace;
    use crate::agent_runtime::types::{ContentBlock, ConversationMessage, TokenUsage};
    use async_trait::async_trait;
    use tokio::sync::mpsc;

    /// Always returns an "approve" verdict JSON.
    struct ApprovingReviewer;

    #[async_trait]
    impl StreamingApiClient for ApprovingReviewer {
        async fn stream(
            &self,
            _request: ApiRequest<'_>,
            event_sink: mpsc::Sender<AssistantEvent>,
            _cancel: CancellationToken,
        ) -> Result<TurnUsage, ApiError> {
            let text = r#"{"verdict":"approve","comments":"looks complete"}"#.to_string();
            let _ = event_sink
                .send(AssistantEvent::TextDelta {
                    delta: text.clone(),
                })
                .await;
            Ok(TurnUsage {
                usage: TokenUsage::default(),
                stop_reason: "end_turn".into(),
                assistant_message: ConversationMessage::assistant(
                    vec![ContentBlock::Text { text }],
                    0,
                ),
            })
        }
    }

    /// Always returns a "changes requested" verdict JSON.
    struct RejectingReviewer;

    #[async_trait]
    impl StreamingApiClient for RejectingReviewer {
        async fn stream(
            &self,
            _request: ApiRequest<'_>,
            event_sink: mpsc::Sender<AssistantEvent>,
            _cancel: CancellationToken,
        ) -> Result<TurnUsage, ApiError> {
            let text =
                r#"{"verdict":"changes_requested","comments":"missing deliverables"}"#.to_string();
            let _ = event_sink
                .send(AssistantEvent::TextDelta {
                    delta: text.clone(),
                })
                .await;
            Ok(TurnUsage {
                usage: TokenUsage::default(),
                stop_reason: "end_turn".into(),
                assistant_message: ConversationMessage::assistant(
                    vec![ContentBlock::Text { text }],
                    0,
                ),
            })
        }
    }

    fn fixture() -> (tempfile::TempDir, tempfile::TempDir, TeamSession, TeamBus) {
        let brain = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let ws = ProjectWorkspace::at_root("pid-integ", brain.path().join("pid-integ"));
        ws.ensure_scaffold(repo.path().to_str().unwrap(), None)
            .unwrap();
        (
            brain,
            repo,
            TeamSession::with_workspace(ws),
            TeamBus::headless(),
        )
    }

    fn two_ic_team(session: &TeamSession, bus: &TeamBus) -> Vec<String> {
        let team = session
            .convene(
                bus,
                ConveneRequest {
                    lead_model: None,
                    stack: None,
                    agents: vec![
                        AgentSpec {
                            role: "api".into(),
                            model: None,
                        },
                        AgentSpec {
                            role: "ui".into(),
                            model: None,
                        },
                    ],
                },
                5,
            )
            .unwrap();
        let ids: Vec<String> = team
            .agents
            .iter()
            .filter(|a| a.id != LEAD_AGENT_ID)
            .map(|a| a.id.clone())
            .collect();
        session
            .assign_scope(bus, &ids[0], vec!["api/".into()], vec![])
            .unwrap();
        session
            .assign_scope(bus, &ids[1], vec!["ui/".into()], vec![])
            .unwrap();
        ids
    }

    #[test]
    fn parse_review_reads_json_and_prose() {
        let (v, c) = parse_review(r#"{"verdict":"changes_requested","comments":"add tests"}"#);
        assert!(matches!(v, ReviewVerdict::ChangesRequested));
        assert_eq!(c, "add tests");

        let (v2, _) = parse_review("LGTM, approve and ship");
        assert!(matches!(v2, ReviewVerdict::Approve));

        let (v3, _) = parse_review("I have a concern about error handling");
        assert!(matches!(v3, ReviewVerdict::ChangesRequested));
    }

    #[tokio::test]
    async fn integration_reviews_and_passes_gate() {
        let (_brain, repo, session, bus) = fixture();
        let ids = two_ic_team(&session, &bus);
        // Give each scope a file so the listing is non-empty.
        std::fs::create_dir_all(repo.path().join("api")).unwrap();
        std::fs::write(repo.path().join("api/mod.rs"), "pub fn x() {}").unwrap();
        std::fs::create_dir_all(repo.path().join("ui")).unwrap();
        std::fs::write(repo.path().join("ui/app.tsx"), "export const A = 1;").unwrap();

        let client: Arc<dyn StreamingApiClient> = Arc::new(ApprovingReviewer);
        let gate = GateCommands {
            build: Some("exit 0".into()),
            lint: None,
            test: None,
        };
        run_integration_inner(
            &bus,
            &session,
            repo.path(),
            &client,
            "team-model",
            1024,
            &gate,
        )
        .await
        .unwrap();

        // Two review verdicts (round-robin), gate passed, team done.
        let chan = session.workspace().read_channel(None).unwrap();
        let reviews = chan
            .iter()
            .filter(|e| {
                matches!(
                    e.kind,
                    crate::agent_runtime::team::types::ChannelEventKind::ReviewVerdict
                )
            })
            .count();
        assert_eq!(reviews, 2, "each IC reviews one peer");

        let status = session.workspace().read_status().unwrap().unwrap();
        assert!(matches!(status.build, GateStatus::Passed));

        let team = session.workspace().read_team().unwrap().unwrap();
        assert!(
            matches!(team.phase, TeamPhase::Done),
            "phase: {:?}",
            team.phase
        );
        let _ = ids;
    }

    #[tokio::test]
    async fn integration_failing_gate_keeps_integrating() {
        let (_brain, repo, session, bus) = fixture();
        two_ic_team(&session, &bus);
        let client: Arc<dyn StreamingApiClient> = Arc::new(ApprovingReviewer);
        let gate = GateCommands {
            build: Some("exit 1".into()),
            lint: None,
            test: None,
        };
        run_integration_inner(
            &bus,
            &session,
            repo.path(),
            &client,
            "team-model",
            1024,
            &gate,
        )
        .await
        .unwrap();

        let status = session.workspace().read_status().unwrap().unwrap();
        assert!(matches!(status.build, GateStatus::Failed));
        let team = session.workspace().read_team().unwrap().unwrap();
        assert!(
            !matches!(team.phase, TeamPhase::Done),
            "a failed gate must block done"
        );
    }

    #[tokio::test]
    async fn integration_changes_requested_blocks_done() {
        let (_brain, repo, session, bus) = fixture();
        two_ic_team(&session, &bus);
        let client: Arc<dyn StreamingApiClient> = Arc::new(RejectingReviewer);
        let gate = GateCommands {
            build: Some("exit 0".into()),
            lint: None,
            test: None,
        };

        let err = run_integration_inner(
            &bus,
            &session,
            repo.path(),
            &client,
            "team-model",
            1024,
            &gate,
        )
        .await
        .unwrap_err();

        assert!(
            err.to_string().contains("peer review requested changes"),
            "changes-requested review must block integration, got: {err}"
        );
        let team = session.workspace().read_team().unwrap().unwrap();
        assert!(
            !matches!(team.phase, TeamPhase::Done),
            "changes requested must block done"
        );
    }

    #[tokio::test]
    async fn gate_command_timeout_fails_instead_of_hanging() {
        let (_brain, repo, _session, _bus) = fixture();
        let cmd = if cfg!(windows) {
            "powershell -NoProfile -Command Start-Sleep -Seconds 5"
        } else {
            "sleep 5"
        };
        let status =
            run_gate_cmd_with_timeout(repo.path(), Some(cmd), std::time::Duration::from_millis(50))
                .await;

        assert!(matches!(status, GateStatus::Failed));
    }
}
