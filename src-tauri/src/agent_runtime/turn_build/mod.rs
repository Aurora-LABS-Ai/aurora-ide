//! Building a turn in the engine, not in a client.
//!
//! Today the agent window assembles every turn (system prompt, tool list,
//! per-message context, provider settings) and sends it whole to
//! `agent_chat_v2`. Phase 3 of `DOCS/rust-core-extraction.md` moves that
//! assembly here, so the app, a browser tab and the CLI all send only "this
//! message, in this chat" and get the same turn.
//!
//! Each part is ported against golden files the window writes today
//! (`golden/`, from `*.golden.test.ts`): a part is done when it reproduces
//! them byte for byte. Fixed prompt text lives in `prompts/`, shared with the
//! TypeScript copies by `agent-prompt.texts.test.ts` until the window stops
//! building turns.

pub mod context;
pub mod inputs;
pub mod project_rules;
pub mod prompt;
pub mod provider;
pub mod skills;
pub mod tools;

use crate::agent_runtime::ipc::{AgentChatRequest, EnginePromptRequest};
use crate::db::AppSettings;

/// What a request says about its own prompt, for [`inputs::system_prompt_input`].
#[must_use]
pub fn request_facts(request: &AgentChatRequest, engine: &EnginePromptRequest) -> inputs::TurnFacts {
    inputs::TurnFacts {
        mode: request.execution_mode,
        workspace_path: request.workspace_path.clone(),
        transcript_chapters: request.transcript_chapters.unwrap_or(false),
        reply_layout: engine.reply_layout,
        deep_research: engine.deep_research,
        // `None` means on, as the browser bucket reads it.
        browser_tools: request.browser_tools.unwrap_or(true),
        attached_rules: engine.attached_rule_files.clone(),
        explicit_skill_keys: engine.explicit_skill_keys.clone(),
        global_skills_root: skills::global_skills_root(),
    }
}

/// Where a shadow-composed prompt first differs from the client's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShadowDiff {
    /// Byte offset of the first difference.
    pub at: usize,
    /// The difference is in the cached half (before the dynamic boundary),
    /// so switching over now would re-bill the prompt cache.
    pub in_cached_half: bool,
    pub client_excerpt: String,
    pub engine_excerpt: String,
}

/// Compare the two prompts byte for byte. `None` when identical.
#[must_use]
pub fn shadow_diff(client: &str, engine: &str) -> Option<ShadowDiff> {
    if client == engine {
        return None;
    }
    let at = client
        .bytes()
        .zip(engine.bytes())
        .position(|(a, b)| a != b)
        .unwrap_or_else(|| client.len().min(engine.len()));
    let boundary = client
        .find(crate::api::provider_kernel_adapter::SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
        .unwrap_or(client.len());
    let excerpt = |text: &str| {
        let start = floor_char(text, at.saturating_sub(60));
        let end = floor_char(text, (at + 60).min(text.len()));
        text[start..end].to_string()
    };
    Some(ShadowDiff {
        at,
        in_cached_half: at < boundary,
        client_excerpt: excerpt(client),
        engine_excerpt: excerpt(engine),
    })
}

fn floor_char(text: &str, mut index: usize) -> usize {
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

/// Log the shadow comparison for one turn (`aurora.log`, `turn_build`).
pub fn report_shadow(thread_id: &str, client: &str, engine: &str) {
    match shadow_diff(client, engine) {
        None => crate::logging::log_info(
            "turn_build",
            &format!("shadow prompt for {thread_id}: identical ({} bytes)", client.len()),
        ),
        Some(diff) => crate::logging::log_warn(
            "turn_build",
            &format!(
                "shadow prompt for {thread_id}: DIFFERS at byte {} of {} (client) / {} (engine), {} half\n  client: {:?}\n  engine: {:?}",
                diff.at,
                client.len(),
                engine.len(),
                if diff.in_cached_half { "CACHED" } else { "dynamic" },
                diff.client_excerpt,
                diff.engine_excerpt,
            ),
        ),
    }
}

/// The system prompt the engine composes for a turn. Reads the rule files,
/// the plan folder and the skill folders, so call it off the async threads.
#[must_use]
pub fn compose_for_turn(settings: &AppSettings, facts: inputs::TurnFacts) -> String {
    prompt::compose_system_prompt(&inputs::system_prompt_input(settings, facts))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::provider_kernel_adapter::SYSTEM_PROMPT_DYNAMIC_BOUNDARY as B;

    #[test]
    fn identical_prompts_have_no_diff() {
        assert_eq!(shadow_diff("same", "same"), None);
    }

    #[test]
    fn a_difference_says_which_half_it_is_in() {
        let client = format!("static A\n\n{B}\n\nmode X");
        let cached = shadow_diff(&client, &format!("static B\n\n{B}\n\nmode X")).unwrap();
        assert_eq!(cached.at, 7);
        assert!(cached.in_cached_half);
        let dynamic = shadow_diff(&client, &format!("static A\n\n{B}\n\nmode Y")).unwrap();
        assert!(!dynamic.in_cached_half);
        // One side a prefix of the other: the difference is where it ends.
        assert_eq!(shadow_diff("abc", "abcd").unwrap().at, 3);
    }

    #[test]
    fn excerpts_never_split_a_character() {
        let client = format!("{}é{}", "x".repeat(59), "a");
        let engine = format!("{}é{}", "x".repeat(59), "b");
        let diff = shadow_diff(&client, &engine).unwrap();
        assert!(diff.client_excerpt.ends_with('a'));
        assert!(diff.engine_excerpt.ends_with('b'));
    }
}
