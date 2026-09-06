//! Validate discovered arguments before entering the existing guarded executor.
//! Validators are lazy and cached per turn. HTTP/file resolution is disabled
//! in Cargo features, so external schema references cannot fetch resources.
use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use async_trait::async_trait;
use serde_json::Value;
use std::sync::{Arc, OnceLock};

pub(super) struct ValidatedExecutor {
    inner: Arc<dyn ToolExecutor>,
    schema: ToolSchema,
    validator: OnceLock<Result<jsonschema::Validator, String>>,
}
impl ValidatedExecutor {
    pub fn new(inner: Arc<dyn ToolExecutor>) -> Self {
        Self {
            schema: inner.schema(),
            inner,
            validator: OnceLock::new(),
        }
    }
    pub fn definition(&self) -> &ToolSchema {
        &self.schema
    }
    pub fn validate(&self, input: &Value) -> Result<(), ToolError> {
        let validator = self.validator.get_or_init(|| jsonschema::validator_for(&self.schema.input_schema)
            .map_err(|error| error.to_string())).as_ref().map_err(|error|
                ToolError::Execution(format!("Cannot validate {}: its registered JSON schema is invalid or has an unavailable external reference: {error}. The tool was not executed.", self.name())))?;
        let errors = validator
            .iter_errors(input)
            .take(3)
            .map(|error| format!("{}: {error}", error.instance_path))
            .collect::<Vec<_>>();
        if !errors.is_empty() {
            return Err(ToolError::InvalidInput(format!("{} arguments do not match its schema: {}. The tool was not executed; use tool_search for its parameters.", self.name(), errors.join("; "))));
        }
        Ok(())
    }
}
#[async_trait]
impl ToolExecutor for ValidatedExecutor {
    fn name(&self) -> &str {
        &self.schema.name
    }
    fn schema(&self) -> ToolSchema {
        self.schema.clone()
    }
    fn concurrency_safe(&self) -> bool {
        self.inner.concurrency_safe()
    }
    fn uses_frontend_lifecycle(&self) -> bool {
        self.inner.uses_frontend_lifecycle()
    }
    fn timeout_policy(&self) -> Option<crate::tools::timeout::TimeoutPolicy> {
        self.inner.timeout_policy()
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        self.validate(&input)?;
        self.inner.execute(input, ctx).await
    }
}
