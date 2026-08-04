//! `.aurora.md` parsing and serialisation — YAML frontmatter + markdown body.
//!
//! The invariant this module exists to hold: **the body round-trips exactly.**
//! Flipping a step to `in_progress` rewrites frontmatter only, so a plan the
//! user hand-wrote keeps its formatting, blank lines, and line endings no
//! matter how many times the agent marks progress against it.

use super::model::{PlanFrontmatter, PLAN_SCHEMA_VERSION};

/// Frontmatter fence, matched on a line of its own.
const FENCE: &str = "---";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanParseError {
    MissingFrontmatter,
    UnterminatedFrontmatter,
    Yaml(String),
    /// A file written by a newer Aurora. Refused rather than misread.
    UnsupportedVersion { found: u32, supported: u32 },
}

impl std::fmt::Display for PlanParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingFrontmatter => write!(
                f,
                "not an Aurora plan: the file must open with a `---` frontmatter block"
            ),
            Self::UnterminatedFrontmatter => write!(
                f,
                "the `---` frontmatter block was opened but never closed"
            ),
            Self::Yaml(msg) => write!(f, "plan frontmatter is not valid YAML: {msg}"),
            Self::UnsupportedVersion { found, supported } => write!(
                f,
                "plan uses schema version {found} but this Aurora supports {supported}; \
                 update Aurora to open it"
            ),
        }
    }
}

impl std::error::Error for PlanParseError {}

/// A parsed plan file: structured frontmatter plus the untouched markdown body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanDocument {
    pub frontmatter: PlanFrontmatter,
    /// Verbatim body, exactly as it appeared after the closing fence.
    pub body: String,
}

/// One `##` section of the body, bound to a step.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodySection {
    /// Step id this section renders, from a `{#id}` anchor or positional fallback.
    pub step_id: Option<String>,
    /// Heading text with the anchor stripped.
    pub heading: String,
    pub level: usize,
    /// Markdown beneath the heading, excluding the heading line itself.
    pub content: String,
}

/// Split `raw` at the frontmatter fence into (yaml, body).
///
/// Line-ending agnostic: Windows files arrive with CRLF and must parse without
/// a normalisation pass that would then be written back and churn the diff.
fn split_frontmatter(raw: &str) -> Result<(&str, &str), PlanParseError> {
    let text = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let after_open = {
        let trimmed = text.trim_start_matches(['\n', '\r', ' ', '\t']);
        let rest = trimmed
            .strip_prefix(FENCE)
            .ok_or(PlanParseError::MissingFrontmatter)?;
        // The opening fence must be alone on its line.
        match rest.strip_prefix("\r\n").or_else(|| rest.strip_prefix('\n')) {
            Some(rest) => rest,
            None if rest.is_empty() => return Err(PlanParseError::UnterminatedFrontmatter),
            None => return Err(PlanParseError::MissingFrontmatter),
        }
    };

    let mut offset = 0usize;
    for line in after_open.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']).trim_end() == FENCE {
            let yaml = &after_open[..offset];
            let body = &after_open[offset + line.len()..];
            return Ok((yaml, body));
        }
        offset += line.len();
    }
    Err(PlanParseError::UnterminatedFrontmatter)
}

/// Parse a `.aurora.md` file.
pub fn parse(raw: &str) -> Result<PlanDocument, PlanParseError> {
    let (yaml, body) = split_frontmatter(raw)?;
    let frontmatter: PlanFrontmatter =
        serde_yaml::from_str(yaml).map_err(|e| PlanParseError::Yaml(e.to_string()))?;
    if frontmatter.aurora_plan > PLAN_SCHEMA_VERSION {
        return Err(PlanParseError::UnsupportedVersion {
            found: frontmatter.aurora_plan,
            supported: PLAN_SCHEMA_VERSION,
        });
    }
    Ok(PlanDocument {
        frontmatter,
        body: body.to_string(),
    })
}

/// Serialise back to file text.
pub fn serialize(doc: &PlanDocument) -> Result<String, PlanParseError> {
    let yaml = serde_yaml::to_string(&doc.frontmatter)
        .map_err(|e| PlanParseError::Yaml(e.to_string()))?;
    let mut out = String::with_capacity(yaml.len() + doc.body.len() + 16);
    out.push_str(FENCE);
    out.push('\n');
    out.push_str(&yaml);
    if !yaml.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(FENCE);
    out.push('\n');
    out.push_str(&doc.body);
    Ok(out)
}

/// Strip a trailing `{#id}` anchor from a heading, returning (text, id).
fn split_anchor(heading: &str) -> (String, Option<String>) {
    let trimmed = heading.trim_end();
    let Some(open) = trimmed.rfind("{#") else {
        return (trimmed.to_string(), None);
    };
    if !trimmed.ends_with('}') {
        return (trimmed.to_string(), None);
    }
    let id = &trimmed[open + 2..trimmed.len() - 1];
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return (trimmed.to_string(), None);
    }
    (trimmed[..open].trim_end().to_string(), Some(id.to_string()))
}

/// Body text before the first heading — the plan's overview.
///
/// Deliberately not a section: an `## Overview` heading would be handed a step
/// id by the positional fallback and render as a step that does not exist.
#[must_use]
pub fn preamble(body: &str) -> String {
    let mut out = String::new();
    for line in body.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\r', '\n']);
        let hashes = bare.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&hashes) && bare.chars().nth(hashes).is_some_and(char::is_whitespace) {
            break;
        }
        out.push_str(line);
    }
    out.trim().to_string()
}

/// Trim the blank line(s) between a heading and its content without touching
/// the first line's own indentation — leading spaces can be a fenced code
/// block or a nested list, and stripping them would change how it renders.
fn finish_content(raw: &str) -> String {
    raw.trim_start_matches(['\n', '\r']).trim_end().to_string()
}

/// Split the body into step-bound sections.
///
/// Binding is by explicit `{#id}` anchor. Sections without one fall back to
/// document order against `step_ids` — an unanchored plan still renders, it
/// just cannot survive reordering, which is exactly why `plan_write` emits
/// anchors.
#[must_use]
pub fn sections(body: &str, step_ids: &[String]) -> Vec<BodySection> {
    let mut out: Vec<BodySection> = Vec::new();
    let mut current: Option<(String, usize, Option<String>, String)> = None;

    for line in body.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\r', '\n']);
        let hashes = bare.chars().take_while(|c| *c == '#').count();
        let is_heading = (1..=6).contains(&hashes)
            && bare.chars().nth(hashes).is_some_and(char::is_whitespace);

        if is_heading {
            if let Some((heading, level, anchor, content)) = current.take() {
                out.push(BodySection {
                    step_id: anchor,
                    heading,
                    level,
                    content: finish_content(&content),
                });
            }
            let (heading, anchor) = split_anchor(&bare[hashes + 1..]);
            current = Some((heading, hashes, anchor, String::new()));
        } else if let Some((_, _, _, content)) = current.as_mut() {
            content.push_str(line);
        }
    }
    if let Some((heading, level, anchor, content)) = current {
        out.push(BodySection {
            step_id: anchor,
            heading,
            level,
            content: finish_content(&content),
        });
    }

    // Positional fallback for sections that carried no anchor.
    let mut unclaimed = step_ids
        .iter()
        .filter(|id| !out.iter().any(|s| s.step_id.as_ref() == Some(*id)))
        .cloned()
        .collect::<Vec<_>>()
        .into_iter();
    for section in &mut out {
        if section.step_id.is_none() {
            section.step_id = unclaimed.next();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plans::model::{PlanStatus, PlanStep, StepStatus};

    const SAMPLE: &str = "---\nauroraPlan: 1\nid: plan_a\ntitle: API Building\nstatus: active\ncreatedAt: '2026-07-28T18:30:00Z'\nupdatedAt: '2026-07-28T18:30:00Z'\nsteps:\n- id: s1\n  title: Scaffold routes\n  status: done\n- id: s2\n  title: Wire auth\n  status: in_progress\n  runId: run_9911\n---\n## 1. Scaffold routes {#s1}\n\nBody one.\n\n## 2. Wire auth {#s2}\n\nBody two.\n";

    #[test]
    fn parses_frontmatter_and_body() {
        let doc = parse(SAMPLE).expect("parses");
        assert_eq!(doc.frontmatter.id, "plan_a");
        assert_eq!(doc.frontmatter.title, "API Building");
        assert_eq!(doc.frontmatter.status, PlanStatus::Active);
        assert_eq!(doc.frontmatter.steps.len(), 2);
        assert_eq!(doc.frontmatter.steps[1].status, StepStatus::InProgress);
        assert_eq!(doc.frontmatter.steps[1].run_id.as_deref(), Some("run_9911"));
        assert!(doc.body.starts_with("## 1. Scaffold routes"));
    }

    #[test]
    fn a_status_flip_leaves_the_body_byte_for_byte_identical() {
        // The whole reason the plan is not an append-only artifact.
        let mut doc = parse(SAMPLE).expect("parses");
        let body_before = doc.body.clone();

        doc.frontmatter.step_mut("s2").unwrap().status = StepStatus::Done;
        let written = serialize(&doc).expect("serialises");
        let reparsed = parse(&written).expect("reparses");

        assert_eq!(reparsed.body, body_before, "prose must never be rewritten");
        assert_eq!(reparsed.frontmatter.step("s2").unwrap().status, StepStatus::Done);
    }

    #[test]
    fn round_trips_crlf_bodies_without_normalising_them() {
        // Windows is the primary platform here; silently converting CRLF to LF
        // would churn the user's diff on every status flip.
        let crlf = SAMPLE.replace('\n', "\r\n");
        let doc = parse(&crlf).expect("parses CRLF");
        assert!(doc.body.contains("\r\n"), "body kept its CRLF endings");
        assert!(doc.body.starts_with("## 1. Scaffold routes"));

        let reparsed = parse(&serialize(&doc).expect("serialises")).expect("reparses");
        assert_eq!(reparsed.body, doc.body);
    }

    #[test]
    fn tolerates_a_utf8_bom() {
        let doc = parse(&format!("\u{feff}{SAMPLE}")).expect("parses with BOM");
        assert_eq!(doc.frontmatter.id, "plan_a");
    }

    #[test]
    fn rejects_a_file_with_no_frontmatter() {
        let err = parse("# Just markdown\n").expect_err("must reject");
        assert_eq!(err, PlanParseError::MissingFrontmatter);
        assert!(err.to_string().contains("frontmatter"));
    }

    #[test]
    fn rejects_an_unterminated_frontmatter_block() {
        let err = parse("---\nid: x\n").expect_err("must reject");
        assert_eq!(err, PlanParseError::UnterminatedFrontmatter);
    }

    #[test]
    fn rejects_invalid_yaml_with_a_readable_message() {
        let err = parse("---\n\tnot: [valid\n---\nbody\n").expect_err("must reject");
        assert!(matches!(err, PlanParseError::Yaml(_)));
        assert!(err.to_string().contains("not valid YAML"));
    }

    #[test]
    fn refuses_a_newer_schema_instead_of_misreading_it() {
        let future = SAMPLE.replace("auroraPlan: 1", "auroraPlan: 99");
        let err = parse(&future).expect_err("must refuse");
        assert_eq!(
            err,
            PlanParseError::UnsupportedVersion { found: 99, supported: 1 }
        );
    }

    #[test]
    fn sections_bind_to_steps_by_anchor() {
        let doc = parse(SAMPLE).expect("parses");
        let ids: Vec<String> = doc.frontmatter.steps.iter().map(|s| s.id.clone()).collect();
        let sections = sections(&doc.body, &ids);

        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].step_id.as_deref(), Some("s1"));
        assert_eq!(sections[0].heading, "1. Scaffold routes", "anchor stripped");
        assert_eq!(sections[0].level, 2);
        assert_eq!(sections[0].content, "Body one.");
        assert_eq!(sections[1].step_id.as_deref(), Some("s2"));
        assert_eq!(sections[1].content, "Body two.");
    }

    #[test]
    fn sections_fall_back_to_document_order_when_unanchored() {
        let body = "## First\n\nA\n\n## Second\n\nB\n";
        let ids = vec!["s1".to_string(), "s2".to_string()];
        let out = sections(body, &ids);
        assert_eq!(out[0].step_id.as_deref(), Some("s1"));
        assert_eq!(out[1].step_id.as_deref(), Some("s2"));
        assert_eq!(out[0].heading, "First");
    }

    #[test]
    fn positional_fallback_skips_ids_already_claimed_by_an_anchor() {
        // Mixed anchoring must not hand s2 to two different sections.
        let body = "## Alpha\n\nA\n\n## Beta {#s1}\n\nB\n";
        let ids = vec!["s1".to_string(), "s2".to_string()];
        let out = sections(body, &ids);
        assert_eq!(out[0].step_id.as_deref(), Some("s2"), "s1 is taken");
        assert_eq!(out[1].step_id.as_deref(), Some("s1"));
    }

    #[test]
    fn preamble_is_the_text_before_the_first_heading() {
        assert_eq!(preamble("Intro line.\n\n## 1. Step {#s1}\n\nBody.\n"), "Intro line.");
        assert_eq!(preamble("## 1. Step {#s1}\n\nBody.\n"), "", "no overview");
        assert_eq!(preamble("Only prose, no steps.\n"), "Only prose, no steps.");
    }

    #[test]
    fn an_overview_is_never_mistaken_for_a_step_section() {
        let body = "Intro line.\n\n## 1. Step {#s1}\n\nBody.\n";
        let out = sections(body, &["s1".to_string()]);
        assert_eq!(out.len(), 1, "the intro must not become a section");
        assert_eq!(out[0].step_id.as_deref(), Some("s1"));
    }

    #[test]
    fn a_malformed_anchor_stays_part_of_the_heading() {
        let (text, id) = split_anchor("Heading {#not valid}");
        assert_eq!(id, None);
        assert_eq!(text, "Heading {#not valid}");

        let (text, id) = split_anchor("Heading {#s1}");
        assert_eq!(id.as_deref(), Some("s1"));
        assert_eq!(text, "Heading");
    }

    #[test]
    fn hash_inside_prose_is_not_treated_as_a_heading() {
        let out = sections("## Real\n\nsee #123 and ###notaheading\n", &[]);
        assert_eq!(out.len(), 1);
        assert!(out[0].content.contains("#123"));
    }

    #[test]
    fn serialize_emits_a_parseable_document_for_a_fresh_plan() {
        let doc = PlanDocument {
            frontmatter: PlanFrontmatter {
                aurora_plan: PLAN_SCHEMA_VERSION,
                id: "plan_new".into(),
                title: "Fresh".into(),
                status: PlanStatus::Draft,
                created_at: "2026-07-28T00:00:00Z".into(),
                updated_at: "2026-07-28T00:00:00Z".into(),
                thread_id: Some("thr_1".into()),
                steps: vec![PlanStep::new("s1", "Only step")],
            },
            body: "## 1. Only step {#s1}\n\nDo the thing.\n".into(),
        };
        let text = serialize(&doc).expect("serialises");
        assert!(text.starts_with("---\n"));
        assert_eq!(parse(&text).expect("reparses"), doc);
    }
}
