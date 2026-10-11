//! Validate a role's default or parent-selected native tool grant.

use super::{catalog::AgentDefinition, host::SubagentError};

pub fn resolve(
    definition: &AgentDefinition,
    requested: Option<&[String]>,
    available: &[String],
) -> Result<Vec<String>, SubagentError> {
    let names = requested.unwrap_or(&definition.tools);
    let mut grant = Vec::new();
    let mut rejected = Vec::new();
    for raw in names {
        let name = raw.trim();
        if matches!(name, "message_parent" | "submit_report") {
            continue;
        }
        if !definition.allows(name) {
            rejected.push(format!(
                "{name:?} is outside {}'s allowed tools",
                definition.name
            ));
        } else if !available.iter().any(|tool| tool == name) {
            rejected.push(format!(
                "{name:?} is not an available native child tool in this turn"
            ));
        } else if !grant.iter().any(|tool| tool == name) {
            grant.push(name.to_string());
        }
    }
    if !rejected.is_empty() {
        return Err(SubagentError::Invalid(format!(
            "Could not grant child tools: {}. MCP, skill and user-question tools require child execution routing and cannot be granted here. Allowed tools for {}: {}.",
            rejected.join("; "), definition.name, definition.allowed_tools.join(", ")
        )));
    }
    Ok(grant)
}
