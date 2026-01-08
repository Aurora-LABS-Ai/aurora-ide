//! Per-file Undo/Redo System
//!
//! This module provides undo/redo functionality for individual files.
//! Each file has its own independent undo/redo stack.
//!
//! The system tracks:
//! - Text content changes (for editor undo/redo)
//! - File operations made by AI tools
//!
//! This is complementary to Monaco Editor's built-in undo/redo.
//! Monaco handles keystroke-level undo, while this handles
//! programmatic changes (AI edits, tool operations).

mod service;
pub mod types;

pub use service::UndoRedoService;
pub use types::FileChange;

