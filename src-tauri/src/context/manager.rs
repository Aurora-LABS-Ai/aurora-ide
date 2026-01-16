//! Context Manager
//! 
//! Manages conversation context with turn-based storage and token tracking.
//! Handles adding messages, tracking usage, and determining when summarization is needed.
//!
//! Note: Some methods are kept for API completeness and future integration,
//! even if not currently used in the codebase.

// Allow dead code for API methods kept for completeness and future use
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use crate::context::types::*;

/// Context Manager for a single thread
/// 
/// Manages the conversation state, tracks token usage, and determines
/// when summarization is needed.
#[derive(Debug, Clone)]
pub struct ContextManager {
    /// Thread ID
    thread_id: String,
    
    /// All turns in this conversation
    turns: Vec<Turn>,
    
    /// Context window size (from provider)
    context_window: u32,
    
    /// Maximum output tokens (from provider)
    max_output: u32,
    
    /// Summarization threshold (0.0 - 1.0)
    summarization_threshold: f32,
    
    /// Current turn being built (before finalization)
    current_turn: Option<Turn>,
    
    /// Current round being built
    current_round: Option<ToolCallRound>,
}

impl ContextManager {
    /// Create a new context manager for a thread
    pub fn new(thread_id: String, context_window: u32, max_output: u32) -> Self {
        Self {
            thread_id,
            turns: Vec::new(),
            context_window,
            max_output,
            summarization_threshold: SUMMARIZATION_THRESHOLD / 100.0,
            current_turn: None,
            current_round: None,
        }
    }
    
    /// Create from existing turns (when loading a thread)
    pub fn from_turns(thread_id: String, turns: Vec<Turn>, context_window: u32, max_output: u32) -> Self {
        Self {
            thread_id,
            turns,
            context_window,
            max_output,
            summarization_threshold: SUMMARIZATION_THRESHOLD / 100.0,
            current_turn: None,
            current_round: None,
        }
    }
    
    /// Get the thread ID
    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }
    
    /// Get all finalized turns
    pub fn turns(&self) -> &[Turn] {
        &self.turns
    }
    
    /// Get the current pending turn (if any)
    pub fn current_turn(&self) -> Option<&Turn> {
        self.current_turn.as_ref()
    }
    
    /// Get the current pending round (if any)
    pub fn current_round(&self) -> Option<&ToolCallRound> {
        self.current_round.as_ref()
    }
    
    /// Get a specific turn by ID
    pub fn get_turn(&self, turn_id: &str) -> Option<&Turn> {
        self.turns.iter().find(|t| t.id == turn_id)
    }
    
    /// Get mutable reference to a turn
    pub fn get_turn_mut(&mut self, turn_id: &str) -> Option<&mut Turn> {
        self.turns.iter_mut().find(|t| t.id == turn_id)
    }
    
    // ========================================
    // MESSAGE ADDITION
    // ========================================
    
    /// Add a new user message, creating a new turn
    /// 
    /// Returns the created Turn
    pub fn add_user_message(&mut self, content: String, ide_context: Option<String>) -> Turn {
        // Finalize any pending turn first
        self.finalize_current_turn();
        
        let turn_index = self.turns.len() as u32;
        let turn = Turn::new(
            self.thread_id.clone(),
            content,
            ide_context,
            turn_index,
        );
        
        self.current_turn = Some(turn.clone());
        turn
    }
    
    /// Add an assistant response to the current turn
    /// 
    /// Creates a new round in the current turn
    pub fn add_assistant_response(&mut self, content: String, thinking: Option<String>) -> Option<ToolCallRound> {
        let current_turn = self.current_turn.as_mut()?;
        
        // Finalize any pending round first
        if let Some(round) = self.current_round.take() {
            current_turn.add_round(round);
        }
        
        let round_index = current_turn.rounds.len() as u32;
        let mut round = ToolCallRound::new(
            current_turn.id.clone(),
            content,
            round_index,
        );
        round.thinking = thinking;
        
        self.current_round = Some(round.clone());
        Some(round)
    }
    
    /// Add a tool call to the current round
    pub fn add_tool_call(&mut self, id: String, name: String, arguments: String) -> Option<ToolCall> {
        let round = self.current_round.as_mut()?;
        let tool_call = ToolCall::new(id, name, arguments);
        round.add_tool_call(tool_call.clone());
        Some(tool_call)
    }
    
    /// Add a tool result to the current round
    pub fn add_tool_result(&mut self, tool_call_id: String, content: String, is_error: bool) -> Option<ToolResult> {
        let round = self.current_round.as_mut()?;

        // Truncate long results (UTF-8 safe)
        let result = if content.len() > MAX_TOOL_RESULT_LENGTH && !is_error {
            // Find a valid UTF-8 boundary for truncation
            let truncate_at = content
                .char_indices()
                .take_while(|(i, _)| *i < MAX_TOOL_RESULT_LENGTH)
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(0);

            let truncated_content = format!(
                "{}... [truncated, {} bytes total]",
                &content[..truncate_at],
                content.len()
            );
            ToolResult::truncated(tool_call_id.clone(), truncated_content, content.len())
        } else if is_error {
            ToolResult::error(tool_call_id.clone(), content)
        } else {
            ToolResult::success(tool_call_id.clone(), content)
        };

        round.add_tool_result(tool_call_id, result.clone());
        Some(result)
    }
    
    /// Finalize the current turn (move from pending to completed)
    pub fn finalize_current_turn(&mut self) -> Option<Turn> {
        // First finalize any pending round
        if let Some(current_turn) = self.current_turn.as_mut() {
            if let Some(round) = self.current_round.take() {
                current_turn.add_round(round);
            }
        }
        
        // Then move the turn to completed
        if let Some(turn) = self.current_turn.take() {
            self.turns.push(turn.clone());
            return Some(turn);
        }
        
        None
    }
    
    // ========================================
    // CONTEXT STATE
    // ========================================
    
    /// Get the current context state
    pub fn get_state(&self) -> ContextState {
        let mut state = ContextState::new(
            self.thread_id.clone(),
            self.context_window,
            self.max_output,
        );
        
        state.total_turns = self.turns.len();
        // Include current turn if exists
        if self.current_turn.is_some() {
            state.total_turns += 1;
        }
        state.summarized_turns = self.turns.iter().filter(|t| t.is_summarized()).count();
        
        // Use accurate tiktoken counting
        let mut total_tokens: u32 = 0;
        
        for turn in &self.turns {
            total_tokens += self.count_turn_tokens(turn);
        }
        
        // Include current pending turn
        if let Some(turn) = &self.current_turn {
            total_tokens += self.count_turn_tokens(turn);
        }
        
        // Include current pending round
        if let Some(round) = &self.current_round {
            total_tokens += self.count_round_tokens(round);
        }
        
        state.used_tokens = total_tokens;
        state.update_usage(state.used_tokens);
        
        state
    }
    
    /// Count tokens for a turn using tiktoken
    fn count_turn_tokens(&self, turn: &Turn) -> u32 {
        use crate::services::token_service::{TokenService, EncodingType};
        
        let mut tokens: u32 = 0;
        
        if turn.is_summarized() {
            // Summarized turn - just count the summary
            if let Some(summary) = &turn.summary {
                tokens += TokenService::count_tokens(summary, EncodingType::Cl100k)
                    .map(|c| c.tokens as u32)
                    .unwrap_or(0);
            }
            // Still include user message (summaries don't replace that)
            tokens += TokenService::count_tokens(&turn.user_message, EncodingType::Cl100k)
                .map(|c| c.tokens as u32)
                .unwrap_or(0);
        } else {
            // Full turn content
            tokens += TokenService::count_tokens(&turn.user_message, EncodingType::Cl100k)
                .map(|c| c.tokens as u32)
                .unwrap_or(0);
            
            if let Some(context) = &turn.user_context {
                tokens += TokenService::count_tokens(context, EncodingType::Cl100k)
                    .map(|c| c.tokens as u32)
                    .unwrap_or(0);
            }
            
            for round in &turn.rounds {
                tokens += self.count_round_tokens(round);
            }
        }
        
        // Add message overhead (~4 tokens per message)
        tokens += 4;
        
        tokens
    }
    
    /// Count tokens for a round using tiktoken
    fn count_round_tokens(&self, round: &ToolCallRound) -> u32 {
        use crate::services::token_service::{TokenService, EncodingType};
        
        let mut tokens: u32 = 0;
        
        // Assistant response
        tokens += TokenService::count_tokens(&round.response, EncodingType::Cl100k)
            .map(|c| c.tokens as u32)
            .unwrap_or(0);
        
        // Thinking content (if present)
        if let Some(thinking) = &round.thinking {
            tokens += TokenService::count_tokens(thinking, EncodingType::Cl100k)
                .map(|c| c.tokens as u32)
                .unwrap_or(0);
        }
        
        // Tool calls
        for tc in &round.tool_calls {
            tokens += TokenService::count_tokens(&tc.name, EncodingType::Cl100k)
                .map(|c| c.tokens as u32)
                .unwrap_or(0);
            tokens += TokenService::count_tokens(&tc.arguments, EncodingType::Cl100k)
                .map(|c| c.tokens as u32)
                .unwrap_or(0);
            tokens += 3; // Tool call overhead
        }
        
        // Tool results
        for result in round.tool_results.values() {
            tokens += TokenService::count_tokens(&result.content, EncodingType::Cl100k)
                .map(|c| c.tokens as u32)
                .unwrap_or(0);
            tokens += 4; // Tool result message overhead
        }
        
        // Message overhead
        tokens += 4;
        
        tokens
    }
    
    /// Check if summarization is needed
    pub fn needs_summarization(&self) -> bool {
        let state = self.get_state();
        state.needs_summarization && self.get_turns_to_summarize().is_some()
    }
    
    /// Get the oldest unsummarized turn that should be summarized
    /// (Excludes recent turns that should keep full content)
    pub fn get_turns_to_summarize(&self) -> Option<&Turn> {
        // Keep the last N turns with full content
        let cutoff = self.turns.len().saturating_sub(RECENT_TURNS_FULL_CONTENT);
        
        // Find the oldest unsummarized turn before the cutoff
        self.turns[..cutoff].iter().find(|t| !t.is_summarized())
    }
    
    /// Set a summary for a turn
    pub fn set_turn_summary(&mut self, turn_id: &str, summary: String) -> bool {
        if let Some(turn) = self.get_turn_mut(turn_id) {
            turn.summary = Some(summary);
            turn.updated_at = chrono::Utc::now().to_rfc3339();
            true
        } else {
            false
        }
    }
    
    // ========================================
    // CONFIGURATION
    // ========================================
    
    /// Update context window size
    pub fn set_context_window(&mut self, context_window: u32) {
        self.context_window = context_window;
    }
    
    /// Update max output tokens
    pub fn set_max_output(&mut self, max_output: u32) {
        self.max_output = max_output;
    }
    
    /// Clear all turns
    pub fn clear(&mut self) {
        self.turns.clear();
        self.current_turn = None;
        self.current_round = None;
    }
}

// ============================================================
// GLOBAL CONTEXT STORE - Thread-safe with atomic operations
// ============================================================

lazy_static::lazy_static! {
    /// Global store for context managers (one per thread).
    /// Uses write lock for ALL operations to prevent race conditions.
    static ref CONTEXT_STORE: Arc<RwLock<HashMap<String, ContextManager>>> = 
        Arc::new(RwLock::new(HashMap::new()));
}

/// Get or create a context manager for a thread (for read-only operations)
pub fn get_or_create_context(thread_id: &str, context_window: u32, max_output: u32) -> ContextManager {
    let mut store = CONTEXT_STORE.write().unwrap();
    
    if let Some(manager) = store.get_mut(thread_id) {
        manager.set_context_window(context_window);
        manager.set_max_output(max_output);
        return manager.clone();
    }
    
    let manager = ContextManager::new(thread_id.to_string(), context_window, max_output);
    store.insert(thread_id.to_string(), manager.clone());
    manager
}

/// Remove a context manager from the store
pub fn remove_context(thread_id: &str) {
    let mut store = CONTEXT_STORE.write().unwrap();
    store.remove(thread_id);
}

/// Get context state (read-only snapshot)
pub fn get_context_state(thread_id: &str, context_window: u32, max_output: u32) -> Option<ContextState> {
    let mut store = CONTEXT_STORE.write().unwrap();
    store.get_mut(thread_id).map(|m| {
        m.set_context_window(context_window);
        m.set_max_output(max_output);
        m.get_state()
    })
}

/// ATOMIC: Add user message to context
pub fn atomic_add_user_message(
    thread_id: &str, 
    content: String, 
    ide_context: Option<String>,
    context_window: u32,
    max_output: u32,
) -> Turn {
    let mut store = CONTEXT_STORE.write().unwrap();
    
    let manager = store.entry(thread_id.to_string()).or_insert_with(|| {
        ContextManager::new(thread_id.to_string(), context_window, max_output)
    });
    
    manager.set_context_window(context_window);
    manager.set_max_output(max_output);
    manager.add_user_message(content, ide_context)
}

/// ATOMIC: Add assistant response
pub fn atomic_add_assistant_response(
    thread_id: &str,
    content: String,
    thinking: Option<String>,
) -> Option<ToolCallRound> {
    let mut store = CONTEXT_STORE.write().unwrap();
    store.get_mut(thread_id).and_then(|m| m.add_assistant_response(content, thinking))
}

/// ATOMIC: Add tool call
pub fn atomic_add_tool_call(
    thread_id: &str,
    id: String,
    name: String,
    arguments: String,
) -> Option<ToolCall> {
    let mut store = CONTEXT_STORE.write().unwrap();
    store.get_mut(thread_id).and_then(|m| m.add_tool_call(id, name, arguments))
}

/// ATOMIC: Add tool result
pub fn atomic_add_tool_result(
    thread_id: &str,
    tool_call_id: String,
    content: String,
    is_error: bool,
) -> Option<ToolResult> {
    let mut store = CONTEXT_STORE.write().unwrap();
    store.get_mut(thread_id).and_then(|m| m.add_tool_result(tool_call_id, content, is_error))
}

/// ATOMIC: Finalize current turn
pub fn atomic_finalize_turn(thread_id: &str) -> Option<Turn> {
    let mut store = CONTEXT_STORE.write().unwrap();
    store.get_mut(thread_id).and_then(|m| m.finalize_current_turn())
}

/// ATOMIC: Set turn summary
pub fn atomic_set_turn_summary(thread_id: &str, turn_id: &str, summary: String) -> bool {
    let mut store = CONTEXT_STORE.write().unwrap();
    store.get_mut(thread_id).map(|m| m.set_turn_summary(turn_id, summary)).unwrap_or(false)
}

/// ATOMIC: Get turns (cloned)
pub fn atomic_get_turns(thread_id: &str) -> Vec<Turn> {
    let store = CONTEXT_STORE.read().unwrap();
    store.get(thread_id).map(|m| m.turns().to_vec()).unwrap_or_default()
}

/// ATOMIC: Build messages
pub fn atomic_build_messages(thread_id: &str, system_prompt: String, token_budget: u32) -> Vec<ApiMessage> {
    let store = CONTEXT_STORE.read().unwrap();
    if let Some(manager) = store.get(thread_id) {
        let builder = crate::context::builder::MessageBuilder::new(system_prompt, token_budget);
        builder.build(manager)
    } else {
        vec![]
    }
}

/// ATOMIC: Check if needs summarization
pub fn atomic_needs_summarization(thread_id: &str) -> bool {
    let store = CONTEXT_STORE.read().unwrap();
    store.get(thread_id).map(|m| m.needs_summarization()).unwrap_or(false)
}

/// ATOMIC: Get turn to summarize
pub fn atomic_get_turn_to_summarize(thread_id: &str) -> Option<Turn> {
    let store = CONTEXT_STORE.read().unwrap();
    store.get(thread_id).and_then(|m| m.get_turns_to_summarize().cloned())
}

/// Initialize context from turns (for loading saved threads)
pub fn init_context_from_turns(
    thread_id: &str,
    turns: Vec<Turn>,
    context_window: u32,
    max_output: u32,
) -> ContextState {
    let mut store = CONTEXT_STORE.write().unwrap();
    let manager = ContextManager::from_turns(thread_id.to_string(), turns, context_window, max_output);
    let state = manager.get_state();
    store.insert(thread_id.to_string(), manager);
    state
}

