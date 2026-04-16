//! Tauri Commands for Context Engine
//!
//! All operations are atomic - no race conditions.

use crate::context::builder::{format_turn_for_summarization, get_summarization_prompt};
use crate::context::manager::*;
use crate::context::types::*;

// ============================================================
// USER MESSAGE COMMANDS
// ============================================================

/// Add a user message and create a new turn (ATOMIC)
#[tauri::command]
pub async fn context_add_user_message(
    thread_id: String,
    content: String,
    ide_context: Option<String>,
    context_window: u32,
    max_output: u32,
) -> Result<Turn, String> {
    Ok(atomic_add_user_message(
        &thread_id,
        content,
        ide_context,
        context_window,
        max_output,
    ))
}

// ============================================================
// ASSISTANT RESPONSE COMMANDS
// ============================================================

/// Add an assistant response (ATOMIC)
#[tauri::command]
pub async fn context_add_assistant_response(
    thread_id: String,
    content: String,
    thinking: Option<String>,
) -> Result<Option<ToolCallRound>, String> {
    Ok(atomic_add_assistant_response(&thread_id, content, thinking))
}

/// Add a tool call (ATOMIC)
#[tauri::command]
pub async fn context_add_tool_call(
    thread_id: String,
    tool_call_id: String,
    name: String,
    arguments: String,
) -> Result<Option<ToolCall>, String> {
    Ok(atomic_add_tool_call(
        &thread_id,
        tool_call_id,
        name,
        arguments,
    ))
}

/// Add a tool result (ATOMIC)
#[tauri::command]
pub async fn context_add_tool_result(
    thread_id: String,
    tool_call_id: String,
    content: String,
    is_error: bool,
) -> Result<Option<ToolResult>, String> {
    Ok(atomic_add_tool_result(
        &thread_id,
        tool_call_id,
        content,
        is_error,
    ))
}

/// Finalize the current turn (ATOMIC)
#[tauri::command]
pub async fn context_finalize_turn(thread_id: String) -> Result<Option<Turn>, String> {
    Ok(atomic_finalize_turn(&thread_id))
}

/// Discard the current pending turn (ATOMIC)
#[tauri::command]
pub async fn context_discard_current_turn(thread_id: String) -> Result<Option<Turn>, String> {
    Ok(atomic_discard_current_turn(&thread_id))
}

// ============================================================
// MESSAGE BUILDING
// ============================================================

/// Build API messages from context (ATOMIC read)
#[tauri::command]
pub async fn context_build_messages(
    thread_id: String,
    system_prompt: String,
    token_budget: u32,
) -> Result<Vec<ApiMessage>, String> {
    Ok(atomic_build_messages(
        &thread_id,
        system_prompt,
        token_budget,
    ))
}

/// Build API messages for a new request (with new user message)
#[tauri::command]
pub async fn context_build_request_messages(
    thread_id: String,
    system_prompt: String,
    new_message: String,
    ide_context: Option<String>,
    token_budget: u32,
    context_window: u32,
    max_output: u32,
) -> Result<Vec<ApiMessage>, String> {
    // First add the user message atomically
    atomic_add_user_message(
        &thread_id,
        new_message,
        ide_context,
        context_window,
        max_output,
    );
    // Then build messages
    Ok(atomic_build_messages(
        &thread_id,
        system_prompt,
        token_budget,
    ))
}

// ============================================================
// CONTEXT STATE
// ============================================================

/// Get the current context state (ATOMIC)
#[tauri::command]
pub async fn context_get_state(
    thread_id: String,
    context_window: u32,
    max_output: u32,
) -> Result<ContextState, String> {
    get_context_state(&thread_id, context_window, max_output)
        .ok_or_else(|| format!("Context not found for thread: {}", thread_id))
}

/// Check if summarization is needed (ATOMIC)
#[tauri::command]
pub async fn context_needs_summarization(thread_id: String) -> Result<bool, String> {
    Ok(atomic_needs_summarization(&thread_id))
}

// ============================================================
// SUMMARIZATION
// ============================================================

/// Get the next turn that needs summarization
#[tauri::command]
pub async fn context_get_turn_to_summarize(
    thread_id: String,
) -> Result<Option<SummarizationRequest>, String> {
    if let Some(turn) = atomic_get_turn_to_summarize(&thread_id) {
        let turn_content = format_turn_for_summarization(&turn);
        Ok(Some(SummarizationRequest {
            turn_id: turn.id,
            turn_content,
            provider_config: None,
        }))
    } else {
        Ok(None)
    }
}

/// Set a summary for a turn (ATOMIC)
#[tauri::command]
pub async fn context_set_turn_summary(
    thread_id: String,
    turn_id: String,
    summary: String,
) -> Result<bool, String> {
    Ok(atomic_set_turn_summary(&thread_id, &turn_id, summary))
}

/// Get the summarization system prompt
#[tauri::command]
pub async fn context_get_summarization_prompt() -> Result<String, String> {
    Ok(get_summarization_prompt())
}

// ============================================================
// LIFECYCLE
// ============================================================

/// Clear context for a thread
#[tauri::command]
pub async fn context_clear_thread(thread_id: String) -> Result<(), String> {
    remove_context(&thread_id);
    Ok(())
}

/// Initialize context from existing turns (for loading saved threads)
#[tauri::command]
pub async fn context_init_from_thread(
    thread_id: String,
    turns: Vec<Turn>,
    context_window: u32,
    max_output: u32,
) -> Result<ContextState, String> {
    Ok(init_context_from_turns(
        &thread_id,
        turns,
        context_window,
        max_output,
    ))
}

/// Get all turns for a thread (ATOMIC)
#[tauri::command]
pub async fn context_get_turns(thread_id: String) -> Result<Vec<Turn>, String> {
    Ok(atomic_get_turns(&thread_id))
}

/// Update context window settings
#[tauri::command]
pub async fn context_update_settings(
    thread_id: String,
    context_window: u32,
    max_output: u32,
) -> Result<(), String> {
    // Just get state which updates settings
    let _ = get_context_state(&thread_id, context_window, max_output);
    Ok(())
}

/// Estimate total tokens for the next request (includes system prompt + all messages)
/// This is what would actually be sent to the API
#[tauri::command]
pub async fn context_estimate_request_tokens(
    thread_id: String,
    system_prompt: String,
    context_window: u32,
    max_output: u32,
) -> Result<ContextState, String> {
    use crate::services::token_service::{EncodingType, TokenService};

    // Build the full message array (same as what's sent to API)
    let token_budget = context_window.saturating_sub(max_output);
    let messages = atomic_build_messages(&thread_id, system_prompt, token_budget);

    // Count all tokens using tiktoken
    let mut total_tokens: u32 = 3; // Conversation priming overhead

    for msg in &messages {
        total_tokens += 4; // Message overhead

        match msg {
            ApiMessage::System { content } | ApiMessage::User { content } => {
                let tokens = TokenService::count_tokens(content, EncodingType::Cl100k)
                    .map(|c| c.tokens as u32)
                    .unwrap_or(0);
                total_tokens += tokens;
            }
            ApiMessage::Assistant {
                content,
                reasoning_content,
                tool_calls,
            } => {
                let tokens = TokenService::count_tokens(content, EncodingType::Cl100k)
                    .map(|c| c.tokens as u32)
                    .unwrap_or(0);
                total_tokens += tokens;

                if let Some(rc) = reasoning_content {
                    total_tokens += TokenService::count_tokens(rc, EncodingType::Cl100k)
                        .map(|c| c.tokens as u32)
                        .unwrap_or(0);
                }

                // Count tool calls if present
                if let Some(calls) = tool_calls {
                    for tc in calls {
                        total_tokens +=
                            TokenService::count_tokens(&tc.function.name, EncodingType::Cl100k)
                                .map(|c| c.tokens as u32)
                                .unwrap_or(0);
                        total_tokens += TokenService::count_tokens(
                            &tc.function.arguments,
                            EncodingType::Cl100k,
                        )
                        .map(|c| c.tokens as u32)
                        .unwrap_or(0);
                        total_tokens += 3; // Tool call overhead
                    }
                }
            }
            ApiMessage::Tool { content, .. } => {
                let tokens = TokenService::count_tokens(content, EncodingType::Cl100k)
                    .map(|c| c.tokens as u32)
                    .unwrap_or(0);
                total_tokens += tokens;
            }
        }
    }

    // Build state with accurate token count
    let mut state = get_context_state(&thread_id, context_window, max_output)
        .unwrap_or_else(|| ContextState::new(thread_id, context_window, max_output));

    state.used_tokens = total_tokens;
    state.update_usage(total_tokens);

    Ok(state)
}
