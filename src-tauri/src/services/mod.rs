//! Aurora Services Module
//!
//! Cross-cutting support services behind the commands layer:
//! - Message format conversion between UI and API shapes (`api_converter`)
//! - Token counting with real tokenizers — tiktoken (`token_service`)
//! - Native WebView browser runtime, DevTools, and capture (`browser_*`)
//! - WebView permission handling and renderer crash recovery (`webview_*`)
//!
//! ## Usage
//! - `crate::services::api_converter::{ApiConverter, ApiMessage, UiMessage}` - message format conversion
//! - `crate::services::token_service::{TokenService, EncodingType, ChatMessage}` - token counting

pub mod api_converter;
pub mod browser_devtools;
pub mod browser_native_capture;
pub mod browser_runtime;
pub mod token_service;
pub mod webview_permissions;
pub mod webview_recovery;

// ApiConverter and TokenService are imported directly from their modules:
// - crate::services::api_converter::{ApiConverter, ApiMessage, UiMessage}
// - crate::services::token_service::{TokenService, EncodingType, ChatMessage}
