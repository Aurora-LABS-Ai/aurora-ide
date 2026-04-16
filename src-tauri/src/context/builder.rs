//! Message Builder
//!
//! Builds API messages from conversation context with smart prioritization.
//! Recent turns get full content, older turns use summaries when available.
//!
//! Note: Builder methods kept for future integration with context window management.

// Allow dead code for builder methods kept for future use
#![allow(dead_code)]

use crate::context::manager::ContextManager;
use crate::context::types::*;

/// Message Builder
///
/// Converts Turn-based context into API messages with token budget management.
pub struct MessageBuilder {
    /// System prompt to include
    system_prompt: String,

    /// Token budget (excluding max_output reservation)
    token_budget: u32,

    /// Number of recent turns to include with full content
    recent_turns: usize,
}

impl MessageBuilder {
    /// Create a new message builder
    pub fn new(system_prompt: String, token_budget: u32) -> Self {
        Self {
            system_prompt,
            token_budget,
            recent_turns: RECENT_TURNS_FULL_CONTENT,
        }
    }

    /// Set the number of recent turns to include with full content
    pub fn with_recent_turns(mut self, count: usize) -> Self {
        self.recent_turns = count;
        self
    }

    /// Build API messages from context manager
    /// Includes both finalized turns and the current pending turn
    pub fn build(&self, context: &ContextManager) -> Vec<ApiMessage> {
        let mut messages = Vec::new();
        let turns = context.turns();

        // 1. Add system prompt
        messages.push(ApiMessage::System {
            content: self.system_prompt.clone(),
        });

        // 2. Determine which turns get full content vs summary
        let total_turns = turns.len();
        let cutoff = total_turns.saturating_sub(self.recent_turns);

        // 3. Process older turns (use summaries if available)
        for turn in turns.iter().take(cutoff) {
            if let Some(summary) = &turn.summary {
                // Use summary for this turn
                messages.push(ApiMessage::User {
                    content: turn.user_message.clone(),
                });
                messages.push(ApiMessage::Assistant {
                    content: format!("[Summary] {}", summary),
                    reasoning_content: None,
                    tool_calls: None,
                });
            } else {
                // No summary yet - include full content
                self.add_full_turn_messages(&mut messages, turn);
            }
        }

        // 4. Process recent turns (always full content)
        for turn in turns.iter().skip(cutoff) {
            self.add_full_turn_messages(&mut messages, turn);
        }

        // 5. Include current pending turn if exists (the new user message)
        if let Some(current_turn) = context.current_turn() {
            self.add_full_turn_messages(&mut messages, current_turn);

            // Also include current pending round if it has content
            if let Some(current_round) = context.current_round() {
                self.add_round_messages(&mut messages, current_round);
            }
        }

        messages
    }

    /// Build messages for a new request (includes pending turn content)
    pub fn build_for_request(
        &self,
        context: &ContextManager,
        new_user_message: &str,
        ide_context: Option<&str>,
    ) -> Vec<ApiMessage> {
        let mut messages = self.build(context);

        // Add the new user message with optional IDE context
        let content = if let Some(ctx) = ide_context {
            format!(
                "{}\n\n<user_query>\n{}\n</user_query>",
                ctx, new_user_message
            )
        } else {
            format!("<user_query>\n{}\n</user_query>", new_user_message)
        };

        messages.push(ApiMessage::User { content });

        messages
    }

    /// Add full turn messages (user + all rounds)
    fn add_full_turn_messages(&self, messages: &mut Vec<ApiMessage>, turn: &Turn) {
        // User message (with context for first turn)
        let user_content = if let Some(context) = &turn.user_context {
            format!(
                "{}\n\n<user_query>\n{}\n</user_query>",
                context, turn.user_message
            )
        } else {
            turn.user_message.clone()
        };

        messages.push(ApiMessage::User {
            content: user_content,
        });

        // Process each round
        for round in &turn.rounds {
            self.add_round_messages(messages, round);
        }
    }

    /// Add messages for a single round (assistant + tools)
    fn add_round_messages(&self, messages: &mut Vec<ApiMessage>, round: &ToolCallRound) {
        // If there are tool calls, include them
        if !round.tool_calls.is_empty() {
            // Assistant message with tool calls
            let tool_calls: Vec<ApiToolCall> =
                round.tool_calls.iter().map(|tc| tc.into()).collect();

            messages.push(ApiMessage::Assistant {
                content: round.response.clone(),
                reasoning_content: round.thinking.clone(),
                tool_calls: Some(tool_calls),
            });

            // Tool results
            for tool_call in &round.tool_calls {
                if let Some(result) = round.tool_results.get(&tool_call.id) {
                    messages.push(ApiMessage::Tool {
                        tool_call_id: tool_call.id.clone(),
                        content: result.content.clone(),
                    });
                }
            }
        } else {
            // Just assistant response (no tools)
            messages.push(ApiMessage::Assistant {
                content: round.response.clone(),
                reasoning_content: round.thinking.clone(),
                tool_calls: None,
            });
        }
    }

    /// Estimate token count for messages
    pub fn estimate_tokens(&self, messages: &[ApiMessage]) -> u32 {
        let mut total_chars = 0;

        for msg in messages {
            match msg {
                ApiMessage::System { content } => total_chars += content.len(),
                ApiMessage::User { content } => total_chars += content.len(),
                ApiMessage::Assistant {
                    content,
                    reasoning_content,
                    tool_calls,
                } => {
                    total_chars += content.len();
                    if let Some(rc) = reasoning_content {
                        total_chars += rc.len();
                    }
                    if let Some(calls) = tool_calls {
                        for call in calls {
                            total_chars += call.function.name.len();
                            total_chars += call.function.arguments.len();
                        }
                    }
                }
                ApiMessage::Tool { content, .. } => total_chars += content.len(),
            }
        }

        // Rough estimate: ~4 chars per token
        (total_chars / 4) as u32
    }
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/// Format a turn for summarization
pub fn format_turn_for_summarization(turn: &Turn) -> String {
    let mut content = String::new();

    content.push_str(&format!("User: {}\n\n", turn.user_message));

    for (i, round) in turn.rounds.iter().enumerate() {
        content.push_str(&format!("Round {}:\n", i + 1));

        if !round.response.is_empty() {
            content.push_str(&format!("Assistant: {}\n", round.response));
        }

        if !round.tool_calls.is_empty() {
            content.push_str("Tool calls:\n");
            for tc in &round.tool_calls {
                content.push_str(&format!("  - {}: {}\n", tc.name, tc.arguments));
                if let Some(result) = round.tool_results.get(&tc.id) {
                    let result_preview = if result.content.len() > 200 {
                        format!("{}... [truncated]", &result.content[..200])
                    } else {
                        result.content.clone()
                    };
                    content.push_str(&format!("    Result: {}\n", result_preview));
                }
            }
        }

        content.push('\n');
    }

    content
}

/// Create the summarization system prompt
pub fn get_summarization_prompt() -> String {
    r#"You are a conversation summarizer. Your task is to create a concise summary of a conversation turn that preserves all critical information needed to continue the work.

Include:
- The user's request/goal
- Key technical decisions made
- Files modified and why
- Current state/progress
- Any pending work or issues

Keep the summary to 2-4 sentences. Be specific about file names, function names, and technical details.

Respond with ONLY the summary text, no additional formatting or explanation."#.to_string()
}
