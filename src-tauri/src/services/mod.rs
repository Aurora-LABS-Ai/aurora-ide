//! Aurora Services Module
//!
//! This module contains business logic services that provide:
//! - Thread management with per-message persistence
//! - Token counting using real tokenizers (tiktoken)
//! - API message format conversion
//!
//! These services are the single source of truth - TypeScript frontend
//! should subscribe to events and maintain read-only caches.

pub mod api_converter;
pub mod thread_service;
pub mod token_service;

// Re-export commonly used types
pub use api_converter::ApiConverter;
pub use thread_service::ThreadService;
pub use token_service::TokenService;

