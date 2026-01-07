//! Context Engine Module
//! 
//! Provides turn-based conversation context management with:
//! - Structured Turn/Round storage
//! - Smart message building with token budget
//! - Automatic summarization for long conversations
//! - Tool result truncation

pub mod types;
pub mod manager;
pub mod builder;
pub mod commands;

