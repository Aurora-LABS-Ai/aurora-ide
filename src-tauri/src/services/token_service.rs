//! Token Counting Service
//!
//! Provides accurate token counting using tiktoken-rs instead of
//! character-based estimation. Supports multiple encoding schemes
//! for different model families.

use lazy_static::lazy_static;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tiktoken_rs::{cl100k_base, o200k_base, CoreBPE};

/// Encoding type for different model families
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EncodingType {
    /// cl100k_base: GPT-4, GPT-3.5-turbo, text-embedding-ada-002
    Cl100k,
    /// o200k_base: GPT-4o, GPT-4o-mini
    O200k,
    /// Default fallback (uses cl100k)
    Default,
}

impl Default for EncodingType {
    fn default() -> Self {
        Self::Cl100k
    }
}

/// Cached tokenizer instances (expensive to create)
/// Using Option<Arc<CoreBPE>> for each encoding type
struct TokenizerCache {
    cl100k: Option<Arc<CoreBPE>>,
    o200k: Option<Arc<CoreBPE>>,
}

lazy_static! {
    static ref TOKENIZER_CACHE: RwLock<TokenizerCache> = RwLock::new(TokenizerCache {
        cl100k: None,
        o200k: None,
    });
}

/// Token counting result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCount {
    /// Number of tokens
    pub tokens: usize,
    /// Encoding type used
    pub encoding: String,
    /// Whether this was an exact count or estimate
    pub exact: bool,
}

/// Token Service for accurate token counting
pub struct TokenService;

impl TokenService {
    /// Get or create a tokenizer for the given encoding type
    fn get_tokenizer(encoding: EncodingType) -> Result<Arc<CoreBPE>, String> {
        let effective_encoding = match encoding {
            EncodingType::Default => EncodingType::Cl100k,
            other => other,
        };

        // Check cache first
        {
            let cache = TOKENIZER_CACHE.read();
            let cached = match effective_encoding {
                EncodingType::Cl100k | EncodingType::Default => cache.cl100k.clone(),
                EncodingType::O200k => cache.o200k.clone(),
            };
            if let Some(tokenizer) = cached {
                return Ok(tokenizer);
            }
        }

        // Create new tokenizer
        let tokenizer = match effective_encoding {
            EncodingType::Cl100k | EncodingType::Default => {
                cl100k_base().map_err(|e| format!("Failed to create cl100k tokenizer: {}", e))?
            }
            EncodingType::O200k => {
                o200k_base().map_err(|e| format!("Failed to create o200k tokenizer: {}", e))?
            }
        };

        let arc_tokenizer = Arc::new(tokenizer);

        // Cache it
        {
            let mut cache = TOKENIZER_CACHE.write();
            match effective_encoding {
                EncodingType::Cl100k | EncodingType::Default => {
                    cache.cl100k = Some(arc_tokenizer.clone());
                }
                EncodingType::O200k => {
                    cache.o200k = Some(arc_tokenizer.clone());
                }
            }
        }

        Ok(arc_tokenizer)
    }

    /// Detect the best encoding for a model name
    pub fn detect_encoding(model: &str) -> EncodingType {
        let model_lower = model.to_lowercase();

        // GPT-4o models use o200k
        if model_lower.contains("gpt-4o") || model_lower.contains("o1") {
            return EncodingType::O200k;
        }

        // GPT-4, GPT-3.5, Claude, most others use cl100k
        if model_lower.contains("gpt-4")
            || model_lower.contains("gpt-3.5")
            || model_lower.contains("claude")
            || model_lower.contains("text-embedding")
        {
            return EncodingType::Cl100k;
        }

        // Default to cl100k for unknown models
        EncodingType::Default
    }

    /// Count tokens in a string using the specified encoding
    pub fn count_tokens(text: &str, encoding: EncodingType) -> Result<TokenCount, String> {
        let tokenizer = Self::get_tokenizer(encoding)?;
        let tokens = tokenizer.encode_ordinary(text);

        Ok(TokenCount {
            tokens: tokens.len(),
            encoding: format!("{:?}", encoding).to_lowercase(),
            exact: true,
        })
    }

    /// Count tokens for a model (auto-detects encoding)
    pub fn count_tokens_for_model(text: &str, model: &str) -> Result<TokenCount, String> {
        let encoding = Self::detect_encoding(model);
        Self::count_tokens(text, encoding)
    }

    /// Estimate tokens for a chat message (includes overhead for message format)
    /// This matches OpenAI's token counting for chat completions
    pub fn count_chat_tokens(role: &str, content: &str, model: &str) -> Result<TokenCount, String> {
        let encoding = Self::detect_encoding(model);
        let tokenizer = Self::get_tokenizer(encoding)?;

        // OpenAI chat format overhead:
        // - Every message has ~4 tokens overhead (<|start|>, role, <|end|>, etc.)
        // - Plus the actual content
        let message_overhead = 4;
        let content_tokens = tokenizer.encode_ordinary(content).len();
        let role_tokens = tokenizer.encode_ordinary(role).len();

        Ok(TokenCount {
            tokens: content_tokens + role_tokens + message_overhead,
            encoding: format!("{:?}", encoding).to_lowercase(),
            exact: true,
        })
    }

    /// Count tokens for a list of messages (conversation history)
    pub fn count_messages_tokens(
        messages: &[ChatMessage],
        model: &str,
    ) -> Result<TokenCount, String> {
        let encoding = Self::detect_encoding(model);
        let tokenizer = Self::get_tokenizer(encoding)?;

        let mut total_tokens = 0;

        // OpenAI format: 3 tokens for conversation priming
        total_tokens += 3;

        for msg in messages {
            // 4 tokens overhead per message
            total_tokens += 4;
            total_tokens += tokenizer.encode_ordinary(&msg.role).len();
            total_tokens += tokenizer.encode_ordinary(&msg.content).len();

            // Tool calls add extra tokens
            if let Some(tool_calls) = &msg.tool_calls {
                for tc in tool_calls {
                    total_tokens += 3; // Tool call overhead
                    total_tokens += tokenizer.encode_ordinary(&tc.name).len();
                    total_tokens += tokenizer.encode_ordinary(&tc.arguments).len();
                }
            }
        }

        Ok(TokenCount {
            tokens: total_tokens,
            encoding: format!("{:?}", encoding).to_lowercase(),
            exact: true,
        })
    }

    /// Quick estimate without loading tokenizer (fallback for performance)
    /// Uses ~4 chars per token average
    pub fn estimate_tokens_quick(text: &str) -> usize {
        // Average ~4 characters per token for English text
        // This is a rough estimate but very fast
        (text.len() + 3) / 4
    }

    /// Truncate text to fit within a token limit
    pub fn truncate_to_tokens(
        text: &str,
        max_tokens: usize,
        encoding: EncodingType,
    ) -> Result<String, String> {
        let tokenizer = Self::get_tokenizer(encoding)?;
        let tokens = tokenizer.encode_ordinary(text);

        if tokens.len() <= max_tokens {
            return Ok(text.to_string());
        }

        // Truncate tokens and decode back to string
        let truncated_tokens: Vec<u32> = tokens.into_iter().take(max_tokens).collect();
        let truncated = tokenizer
            .decode(truncated_tokens)
            .map_err(|e| format!("Failed to decode truncated tokens: {}", e))?;

        Ok(truncated)
    }
}

/// Simple chat message for token counting
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallForCount>>,
}

/// Tool call info for token counting
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallForCount {
    pub name: String,
    pub arguments: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_count_tokens() {
        let result = TokenService::count_tokens("Hello, world!", EncodingType::Cl100k);
        assert!(result.is_ok());
        let count = result.unwrap();
        assert!(count.tokens > 0);
        assert!(count.exact);
    }

    #[test]
    fn test_detect_encoding() {
        assert_eq!(TokenService::detect_encoding("gpt-4o"), EncodingType::O200k);
        assert_eq!(
            TokenService::detect_encoding("gpt-4-turbo"),
            EncodingType::Cl100k
        );
        assert_eq!(
            TokenService::detect_encoding("claude-3"),
            EncodingType::Cl100k
        );
    }

    #[test]
    fn test_quick_estimate() {
        let text = "Hello, world!";
        let estimate = TokenService::estimate_tokens_quick(text);
        assert!(estimate > 0);
        // Should be roughly text.len() / 4
        assert!(estimate <= text.len());
    }
}
