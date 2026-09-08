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
    /// Arguments the schema never declared, each with the declared name it is
    /// closest to.
    ///
    /// JSON Schema allows unknown properties unless a schema says otherwise,
    /// and Aurora's tool schemas do not say otherwise — so a typo was accepted
    /// and the tool ran with defaults. Measured by the harness rig on
    /// 2026-09-06:
    ///
    /// ```text
    /// call_tool browser_page_outline {"limitt": 2, "querry": "button"}
    ///   -> success, 3 buttons returned
    /// ```
    ///
    /// The model asked for two items filtered by "button" and got neither, with
    /// nothing anywhere saying so. That is the same class as the `edits` /
    /// `edites` failure in `file_workspace_search::edits_argument`, and this is
    /// the cheapest place it will ever be caught: every optional tool now
    /// arrives through one validator.
    ///
    /// **Top level only.** A nested schema can put its properties behind
    /// `anyOf` / `oneOf` branches, where "not declared here" does not mean
    /// undeclared, and a false refusal is worse than a silent default. The
    /// reported case, and every case of this shape so far, is top level.
    fn undeclared_arguments(&self, input: &Value) -> Vec<(String, Option<String>)> {
        let (Some(sent), Some(declared)) = (
            input.as_object(),
            self.schema
                .input_schema
                .get("properties")
                .and_then(Value::as_object),
        ) else {
            return Vec::new();
        };
        // A schema that opts into extra properties means it; say nothing.
        if self.schema.input_schema.get("additionalProperties") == Some(&Value::Bool(true)) {
            return Vec::new();
        }
        sent.keys()
            .filter(|key| !declared.contains_key(*key))
            .map(|key| {
                // Two edits covers a transposition plus a slip (`limitt`,
                // `querry`) and stops short of a different word.
                let nearest = declared
                    .keys()
                    .map(|name| (edit_distance(key, name), name))
                    .filter(|(distance, _)| *distance <= 2)
                    .min_by_key(|(distance, _)| *distance)
                    .map(|(_, name)| name.clone());
                (key.clone(), nearest)
            })
            .collect()
    }

    pub fn validate(&self, input: &Value) -> Result<(), ToolError> {
        let undeclared = self.undeclared_arguments(input);
        if !undeclared.is_empty() {
            let named = undeclared
                .iter()
                .map(|(key, nearest)| match nearest {
                    Some(name) => format!("`{key}` (did you mean `{name}`?)"),
                    None => format!("`{key}`"),
                })
                .collect::<Vec<_>>()
                .join(", ");
            return Err(ToolError::InvalidInput(format!(
                "{} does not take {named}. The tool was NOT executed — an unknown argument is \
                 silently ignored, so it would have run with defaults and answered a different \
                 question than you asked. Use tool_search for its parameters.",
                self.name()
            )));
        }
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

/// Levenshtein distance — the same one `edits_argument` and `tool_suggest` use.
/// Kept local for the same reason they do: a four-line function is not worth a
/// cross-module dependency.
fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur[j + 1] = (prev[j + 1] + 1).min(cur[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}
