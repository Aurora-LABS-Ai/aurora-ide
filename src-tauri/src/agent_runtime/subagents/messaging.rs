//! Message intent is explicit. A note is not another work assignment.

use serde::{Deserialize, Serialize};

pub const MESSAGE_MAX_ITERATIONS: u32 = 4;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParentMessageKind {
    #[default]
    Message,
    Reply,
    Task,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChildMessageKind {
    #[default]
    Message,
    Question,
    Reply,
}

impl ChildMessageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::Question => "question",
            Self::Reply => "reply",
        }
    }
}

impl ParentMessageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::Reply => "reply",
            Self::Task => "task",
        }
    }

    /// Model-facing framing; delivery receipts and visible echoes keep the original text.
    pub fn frame(self, text: &str) -> String {
        let instruction = match self {
            Self::Message => "Information or conversation only. This does not assign new work or require a new work report.",
            Self::Reply => "An answer to your question. Continue the existing task with this answer; this does not assign a separate task.",
            Self::Task => "New or changed work instructions. Complete this work and submit a fresh report covering it.",
        };
        format!("[Parent {}: {instruction}]\n{text}", self.as_str())
    }
}
