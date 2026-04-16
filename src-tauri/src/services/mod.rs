//! Aurora Services Module
//!
//! This module contains business logic services that provide:
//! - Thread management with per-message persistence
//! - Token counting using real tokenizers (tiktoken)
//! - API message format conversion
//!
//! These services are the single source of truth - TypeScript frontend
//! should subscribe to events and maintain read-only caches.
//!
//! ## Usage
//! - `crate::services::thread_service::ThreadService` - Thread management
//! - `crate::services::token_service::TokenService` - Token counting with tiktoken
//! - `crate::services::api_converter::ApiConverter` - Message format conversion

pub mod api_converter;
pub mod thread_service;
pub mod token_service;

// Re-export ThreadService as it's commonly used
pub use thread_service::ThreadService;

// ApiConverter and TokenService are imported directly from their modules:
// - crate::services::api_converter::{ApiConverter, ApiMessage, UiMessage}
// - crate::services::token_service::{TokenService, EncodingType, ChatMessage}
