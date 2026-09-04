//! Aurora's conversation → Cursor's `root_prompt_messages_json`.
//!
//! Cursor's backend composes the model prompt itself and accepts only
//! *conversation history* from the client. There is no client system role:
//! `AgentRunRequest.custom_system_prompt` exists but is documented upstream as
//! "Allowlisted for specific teams only", so an ordinary account cannot use it.
//!
//! Aurora therefore delivers its system prompt as the opening exchange. The
//! wording matters more than it looks. A gateway that labels it as
//! *"configuration set by the operator of this API gateway"* invites the model
//! to treat it as third-party instructions competing with its own — in testing,
//! Grok answered that it had been given "extra configuration that tried to
//! override that identity" and declined part of it. Aurora is not a gateway
//! standing between two strangers; it is the application the user is running,
//! and its prompt is the developer instruction for the session. Saying so
//! plainly is both more accurate and better behaved.
//!
//! Every entry becomes a KV blob keyed by the sha256 of its bytes; only the
//! ids travel in the request, and the server pulls the contents back mid-turn
//! (see [`super::session`]).

use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::types::{ContentBlock, ConversationMessage, MessageRole};

/// Opens the pair carrying Aurora's system prompt.
const SYSTEM_LEAD_IN: &str =
    "The following are your operating instructions for this session, from Aurora, \
     the application you are running inside. Follow them for the rest of this conversation.";

/// The acknowledgement attributed to the assistant, closing the pair.
const SYSTEM_ACK: &str = "Understood. I'll follow those instructions for the rest of this session.";

/// Sent when the caller is mid-tool-loop and has no new user text.
///
/// Cursor expects `resume_action` there, but a resume with nothing new can
/// leave the model idling; a short nudge costs a handful of tokens and makes
/// the continuation unambiguous.
pub const CONTINUATION_PROMPT: &str = "Continue.";

/// One turn's worth of input, in the shape the run request wants.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnInput {
    /// History entries, oldest first, each destined for its own blob.
    pub root_messages: Vec<Value>,
    /// The active user message. Empty means "resume" — see
    /// [`TurnInput::is_resume`].
    pub user_text: String,
}

impl TurnInput {
    /// Whether this turn continues an agent loop rather than starting from a
    /// new user message.
    ///
    /// Cursor distinguishes the two at the action level, and sending an empty
    /// user message where a resume belongs makes the model answer the void.
    #[must_use]
    pub fn is_resume(&self) -> bool {
        self.user_text.trim().is_empty()
    }
}

/// Flatten Aurora's blocks into the text Cursor's history format carries.
fn text_of(blocks: &[ContentBlock]) -> String {
    let mut parts = Vec::new();
    for block in blocks {
        if let ContentBlock::Text { text } = block {
            if !text.is_empty() {
                parts.push(text.as_str());
            }
        }
    }
    parts.join("\n")
}

/// Build the history and active message for one turn.
///
/// The trailing user message becomes the action; everything before it is
/// history. When the conversation ends on a tool result — Aurora mid-loop —
/// there is no trailing user message and the turn resumes instead.
#[must_use]
pub fn build_turn_input(
    system_prompt: Option<&str>,
    messages: &[ConversationMessage],
) -> TurnInput {
    let mut root_messages = Vec::new();

    if let Some(prompt) = system_prompt.map(str::trim).filter(|p| !p.is_empty()) {
        root_messages.push(json!({
            "role": "user",
            "content": [{ "type": "text", "text": format!("{SYSTEM_LEAD_IN}\n\n{prompt}") }],
        }));
        root_messages.push(json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": SYSTEM_ACK }],
        }));
    }

    // The active message is the last user turn, but only if nothing the model
    // must respond to came after it.
    let active_index = messages.iter().rposition(|m| m.role == MessageRole::User);
    let active_index = match active_index {
        Some(index)
            if messages[index + 1..]
                .iter()
                .all(|m| m.role == MessageRole::System) =>
        {
            Some(index)
        }
        // A user message followed by assistant/tool traffic is history, not
        // the thing being asked now.
        _ => None,
    };

    for (index, message) in messages.iter().enumerate() {
        if Some(index) == active_index {
            continue;
        }
        match message.role {
            // Aurora's System role carries compaction markers and runtime
            // notices, neither of which is ever sent to a provider.
            MessageRole::System => {}
            MessageRole::User => {
                let text = text_of(&message.blocks);
                if !text.is_empty() {
                    root_messages.push(json!({
                        "role": "user",
                        "content": [{ "type": "text", "text": text }],
                    }));
                }
            }
            MessageRole::Assistant => {
                let mut content = Vec::new();
                let text = text_of(&message.blocks);
                if !text.is_empty() {
                    content.push(json!({ "type": "text", "text": text }));
                }
                for block in &message.blocks {
                    if let ContentBlock::ToolUse { id, name, input } = block {
                        content.push(json!({
                            "type": "tool-call",
                            "toolCallId": id,
                            // The name the model knows this tool by. Writing
                            // Aurora's short name here replays the transcript
                            // with calls to a tool this provider says does not
                            // exist — which is what taught the model, out loud
                            // and every turn, that "short names fail".
                            "toolName": wire_tool_name(name),
                            "args": input,
                        }));
                    }
                }
                if !content.is_empty() {
                    root_messages.push(json!({ "role": "assistant", "content": content }));
                }
            }
            MessageRole::Tool => {
                for block in &message.blocks {
                    if let ContentBlock::ToolResult {
                        tool_use_id,
                        content,
                        ..
                    } = block
                    {
                        // Emitted even when empty: the matching assistant
                        // `tool-call` is already in history, and dropping the
                        // pair would replay a call that never returned.
                        root_messages.push(json!({
                            "role": "tool",
                            "id": tool_use_id,
                            "content": [{
                                "type": "tool-result",
                                "toolName": "",
                                "toolCallId": tool_use_id,
                                "result": content,
                            }],
                        }));
                    }
                }
            }
        }
    }

    let ends_on_tool_result = messages.last().is_some_and(|m| m.role == MessageRole::Tool);

    let user_text = match active_index {
        Some(index) => text_of(&messages[index].blocks),
        None if ends_on_tool_result => CONTINUATION_PROMPT.to_string(),
        None => String::new(),
    };

    TurnInput {
        root_messages,
        user_text,
    }
}

/// The MCP provider Aurora's tools are declared under.
///
/// Load-bearing beyond a label: Cursor presents a client-declared tool to the
/// model as `mcp_{provider_identifier}_{tool_name}`, so this string is half of
/// every tool name the model ever sees. [`TOOL_PREFIX`] is derived from it so
/// the two can never drift apart.
pub const TOOL_PROVIDER: &str = "aurora";

/// What Cursor prepends to each of Aurora's tool names before the model sees
/// them.
///
/// The model is told `mcp_aurora_file_read`, and Cursor **rejects the short
/// name with an unknown-tool error** — so `file_read` is not an alias, it is
/// simply not a tool as far as this provider is concerned.
///
/// That mismatch is not cosmetic. Left alone it costs a failed call per turn
/// while the model discovers the rule, and the prefixed name it then sends
/// collides with Aurora's OWN convention for MCP tools
/// (`mcp_{serverId}_{toolName}`) — so `mcp_aurora_file_read` arriving at the
/// tool executor reads as a call to a server named "aurora" that does not
/// exist.
///
/// So the translation happens here, at the edge, in both directions:
/// [`wire_tool_name`] going out, [`short_tool_name`] coming back. Aurora's
/// runtime only ever sees `file_read`; the model only ever sees
/// `mcp_aurora_file_read`, including in its own replayed history.
pub const TOOL_PREFIX: &str = "mcp_aurora_";

/// Aurora's name for a tool → the name the model knows it by.
#[must_use]
pub fn wire_tool_name(short: &str) -> String {
    if short.starts_with(TOOL_PREFIX) {
        return short.to_string();
    }
    format!("{TOOL_PREFIX}{short}")
}

/// The name the model used → Aurora's name for that tool.
///
/// Tolerant of an unprefixed name: whether Cursor echoes the namespaced form
/// or the bare one is its choice, and a tool call is far too expensive to drop
/// over which spelling arrived.
#[must_use]
pub fn short_tool_name(wire: &str) -> &str {
    wire.strip_prefix(TOOL_PREFIX).unwrap_or(wire)
}

/// Aurora's tool schemas in the shape Cursor advertises them.
///
/// They ride in as MCP tools, which is what lets the request pair them with an
/// `x-cursor-agent-allowed-tools: mcp_tool_call` header and leave Cursor's own
/// ~40 native tools invisible to the model.
///
/// The names here stay **unprefixed**: Cursor composes
/// `mcp_{provider_identifier}_{tool_name}` itself, so prefixing them here would
/// advertise `mcp_aurora_mcp_aurora_file_read`.
#[must_use]
pub fn build_tools(tools: &[ToolSchema]) -> Vec<cursor_proto::agent::McpToolDefinition> {
    tools
        .iter()
        .filter(|tool| !tool.name.trim().is_empty())
        .map(|tool| {
            let schema_json = serde_json::to_string(&tool.input_schema)
                .unwrap_or_else(|_| r#"{"type":"object","properties":{}}"#.to_string());
            cursor_proto::agent::McpToolDefinition {
                name: tool.name.clone(),
                tool_name: tool.name.clone(),
                provider_identifier: TOOL_PROVIDER.to_string(),
                description: tool.description.clone(),
                // `input_schema` is a `bytes` field the server decodes as
                // *binary*, not as JSON text. Putting the JSON in it fails the
                // whole turn with `internal: parse binary: premature EOF` —
                // an error that names neither the tool nor the field. The
                // schema goes in `input_schema_json` and this stays empty.
                input_schema: Vec::new(),
                input_schema_json: Some(schema_json),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: MessageRole, blocks: Vec<ContentBlock>) -> ConversationMessage {
        ConversationMessage {
            role,
            blocks,
            usage: None,
            timestamp: 0,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            aurora_context: None,
            model: None,
        }
    }

    fn user(text: &str) -> ConversationMessage {
        message(
            MessageRole::User,
            vec![ContentBlock::Text {
                text: text.to_string(),
            }],
        )
    }

    fn assistant(text: &str) -> ConversationMessage {
        message(
            MessageRole::Assistant,
            vec![ContentBlock::Text {
                text: text.to_string(),
            }],
        )
    }

    #[test]
    fn the_trailing_user_message_becomes_the_action() {
        let input = build_turn_input(None, &[user("first"), assistant("reply"), user("now")]);
        assert_eq!(input.user_text, "now");
        assert!(!input.is_resume());
        // "now" is the action, so only the earlier pair is history.
        assert_eq!(input.root_messages.len(), 2);
    }

    #[test]
    fn the_system_prompt_is_framed_as_aurora_not_a_gateway() {
        let input = build_turn_input(Some("Always use file_read."), &[user("hi")]);

        let opener = input.root_messages[0]["content"][0]["text"]
            .as_str()
            .unwrap();
        assert!(opener.contains("Always use file_read."));
        assert!(
            opener.contains("Aurora"),
            "the prompt must be attributed to the app the user is running"
        );
        assert!(
            !opener.to_lowercase().contains("gateway"),
            "gateway framing invites the model to treat it as a competing party"
        );
        assert_eq!(input.root_messages[1]["role"], "assistant");
    }

    #[test]
    fn an_empty_system_prompt_adds_no_opening_pair() {
        assert!(build_turn_input(None, &[user("hi")])
            .root_messages
            .is_empty());
        assert!(build_turn_input(Some("   "), &[user("hi")])
            .root_messages
            .is_empty());
    }

    /// Aurora's common case: many tool rounds per turn.
    #[test]
    fn a_conversation_ending_on_a_tool_result_resumes() {
        let messages = vec![
            user("read main.rs"),
            message(
                MessageRole::Assistant,
                vec![ContentBlock::ToolUse {
                    id: "call_1".into(),
                    name: "file_read".into(),
                    input: json!({ "path": "src/main.rs" }),
                }],
            ),
            message(
                MessageRole::Tool,
                vec![ContentBlock::ToolResult {
                    tool_use_id: "call_1".into(),
                    content: "fn main() {}".into(),
                    is_error: None,
                }],
            ),
        ];

        let input = build_turn_input(None, &messages);

        assert_eq!(input.user_text, CONTINUATION_PROMPT);
        // The earlier user message is history now, not the action.
        assert_eq!(input.root_messages[0]["role"], "user");
        assert_eq!(input.root_messages[1]["role"], "assistant");
        assert_eq!(input.root_messages[1]["content"][0]["type"], "tool-call");
        assert_eq!(input.root_messages[1]["content"][0]["toolCallId"], "call_1");
        assert_eq!(input.root_messages[2]["role"], "tool");
        assert_eq!(
            input.root_messages[2]["content"][0]["result"],
            "fn main() {}"
        );
    }

    #[test]
    fn an_assistant_message_carries_text_and_tool_calls_together() {
        let messages = vec![
            user("go"),
            message(
                MessageRole::Assistant,
                vec![
                    ContentBlock::Text {
                        text: "Reading it now.".into(),
                    },
                    ContentBlock::ToolUse {
                        id: "c1".into(),
                        name: "file_read".into(),
                        input: json!({ "path": "a.rs" }),
                    },
                ],
            ),
            message(
                MessageRole::Tool,
                vec![ContentBlock::ToolResult {
                    tool_use_id: "c1".into(),
                    content: "ok".into(),
                    is_error: None,
                }],
            ),
        ];
        let input = build_turn_input(None, &messages);
        let content = &input.root_messages[1]["content"];
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "tool-call");
    }

    /// A tool result with no output still has to be replayed.
    #[test]
    fn an_empty_tool_result_is_still_emitted() {
        let messages = vec![
            user("go"),
            message(
                MessageRole::Assistant,
                vec![ContentBlock::ToolUse {
                    id: "c1".into(),
                    name: "t".into(),
                    input: json!({}),
                }],
            ),
            message(
                MessageRole::Tool,
                vec![ContentBlock::ToolResult {
                    tool_use_id: "c1".into(),
                    content: String::new(),
                    is_error: None,
                }],
            ),
        ];
        let input = build_turn_input(None, &messages);
        assert!(
            input
                .root_messages
                .iter()
                .any(|m| m["role"] == "tool" && m["id"] == "c1"),
            "dropping it would leave an orphaned tool-call in history"
        );
    }

    /// Compaction markers and runtime notices never reach a provider.
    #[test]
    fn aurora_system_messages_are_not_sent() {
        let messages = vec![
            user("first"),
            message(
                MessageRole::System,
                vec![ContentBlock::Compaction {
                    summary: "…".into(),
                    before_tokens: 10,
                    after_tokens: 5,
                    created_at: 0,
                }],
            ),
            user("second"),
        ];
        let input = build_turn_input(None, &messages);

        assert_eq!(input.user_text, "second");
        assert_eq!(input.root_messages.len(), 1);
        assert_eq!(input.root_messages[0]["content"][0]["text"], "first");
    }

    /// A system notice appended after the user's message must not stop that
    /// message from being the active one.
    #[test]
    fn a_trailing_system_notice_does_not_hide_the_user_message() {
        let messages = vec![
            user("do the thing"),
            message(
                MessageRole::System,
                vec![ContentBlock::Text {
                    text: "notice".into(),
                }],
            ),
        ];
        assert_eq!(build_turn_input(None, &messages).user_text, "do the thing");
    }

    #[test]
    fn tools_are_advertised_as_mcp_definitions() {
        let schemas = vec![ToolSchema {
            name: "file_read".into(),
            description: "Read a file.".into(),
            input_schema: json!({ "type": "object", "properties": { "path": { "type": "string" } } }),
        }];
        let built = build_tools(&schemas);

        assert_eq!(built.len(), 1);
        assert_eq!(built[0].name, "file_read");
        assert_eq!(built[0].tool_name, "file_read");
        assert_eq!(built[0].provider_identifier, "aurora");
        let schema_json = built[0].input_schema_json.as_deref().unwrap();
        assert!(schema_json.contains("\"path\""));
        assert!(
            built[0].input_schema.is_empty(),
            "the bytes field is decoded as binary upstream; JSON in it kills the turn"
        );
    }

    /// The bug this pair of functions exists for.
    ///
    /// Cursor advertises a client tool as `mcp_{provider}_{tool}` and rejects
    /// the bare name with an unknown-tool error. Aurora's runtime knows the
    /// bare name and nothing else. Left untranslated the model spends a failed
    /// call per turn learning the rule — and says so in its reasoning, which is
    /// how this was found.
    #[test]
    fn tool_names_are_translated_both_ways() {
        assert_eq!(wire_tool_name("file_read"), "mcp_aurora_file_read");
        assert_eq!(short_tool_name("mcp_aurora_file_read"), "file_read");
    }

    #[test]
    fn translating_twice_does_not_double_the_prefix() {
        assert_eq!(
            wire_tool_name("mcp_aurora_file_read"),
            "mcp_aurora_file_read"
        );
        assert_eq!(short_tool_name("file_read"), "file_read");
    }

    /// Whether Cursor echoes the namespaced name or the bare one is its choice.
    /// A tool call is far too expensive to drop over which spelling arrived.
    #[test]
    fn an_unprefixed_call_still_resolves() {
        assert_eq!(short_tool_name("shell_execute"), "shell_execute");
    }

    /// Aurora's own MCP tools are already `mcp_{serverId}_{toolName}`. Only
    /// this provider's namespace may be stripped, or a real MCP call to a
    /// server called `github` would arrive as a native tool named `issue_list`.
    #[test]
    fn another_mcp_servers_tool_is_left_alone() {
        assert_eq!(
            short_tool_name("mcp_github_issue_list"),
            "mcp_github_issue_list"
        );
    }

    /// The history has to replay a call under the name the model can make.
    #[test]
    fn replayed_tool_calls_carry_the_name_the_model_knows() {
        let messages = vec![message(
            MessageRole::Assistant,
            vec![ContentBlock::ToolUse {
                id: "call-1".into(),
                name: "file_read".into(),
                input: json!({ "path": "a.rs" }),
            }],
        )];
        let input = build_turn_input(None, &messages);
        let rendered = serde_json::to_string(&input.root_messages).unwrap();

        assert!(
            rendered.contains("mcp_aurora_file_read"),
            "the transcript must not show the model calling a tool it is told does not exist: {rendered}"
        );
    }

    #[test]
    fn a_nameless_tool_is_dropped() {
        let schemas = vec![ToolSchema {
            name: "  ".into(),
            description: String::new(),
            input_schema: json!({}),
        }];
        assert!(build_tools(&schemas).is_empty());
    }
}
