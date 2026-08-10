import type { ToolDefinition } from "@/apps/agent/tools/types";

export const presentArtifactTool: ToolDefinition = {
  type: "function",
  function: {
    name: "present_artifact",
    description: `Create or update a rich visual artifact in the conversation's Canvas side panel.

Use this when a rendered, inspectable result materially communicates better than ordinary chat text—for example a working UI prototype, diagram, visual plan, formatted report, or interactive explainer. Do not use it for routine prose, a short code sample, raw logs, or status updates.

Behavior:
- The Canvas opens automatically beside the conversation.
- A new artifactId creates v1 from content.
- For a small revision, reuse the SAME artifactId and send baseVersionTag plus exact-text patches. Aurora applies them atomically to the latest version and saves the complete result as an immutable v2, v3, and so on.
- If the version source is no longer in context, call read_artifact first—optionally with a focused query—so each patch find value exactly matches the saved source.
- Every patch find is matched against the same unchanged base version. Patch regions cannot overlap and patches cannot target text created by an earlier patch; combine dependent or overlapping changes into one replacement.
- Use full content again only for a broad rewrite. Never resend a large unchanged document for a small edit.
- A source-identical update is rejected instead of creating a meaningless duplicate version.
- The user can switch artifacts, inspect any saved version, and toggle Preview/Source after reopening the conversation.
- Use mermaid for architecture, flowchart, sequence, state, class, ER, journey, timeline, quadrant, or mind-map diagrams. Send raw Mermaid syntax without Markdown fences. Canvas provides pan, zoom, fit, Source view, and themed rendering.
- Use react for a LIVE canvas: one component file Aurora compiles and runs, so it can have working controls, sortable tables, filters, and tabs. Prefer it whenever the deliverable is a dataset or a set of findings the user will study — anything you were about to render as a large markdown table. Call canvas_guidelines before your first react artifact; the source is compiled and a contract violation rejects the write.
- Use html for custom interactive compositions, svg for bespoke graphics Mermaid cannot express, and markdown for document-style artifacts. Prefer mermaid over hand-writing diagram SVG, and react over hand-writing an interactive HTML page.
- Produce self-contained content. HTML, SVG, and react canvases render in a sandbox with no network access; embed the data instead of fetching it, and do not depend on the parent app or local files.

Returns artifactId, title, kind, and the saved immutable versionTag. Mermaid source is FULLY RENDERED and react source is COMPILED before saving — layout errors (duplicate ids, a subgraph id colliding with a node id, cyclic nesting) and compile errors (invalid syntax, a missing default export, a disallowed import) reject the write with the engine's exact message. Type errors are not caught yet, so a react canvas that compiles can still throw at run time; the panel reports the crash, but write defensively against missing or empty data rather than relying on the compiler. Patch failures do not create a version: overlap errors name both conflicting patch indices, stale errors report the latest version, ambiguous matches report their count, and Mermaid errors include renderer context. Correct the identified input and retry; use read_artifact when the exact latest source is needed.`,
    parameters: {
      type: "object",
      properties: {
        artifactId: {
          type: "string",
          description:
            "Stable artifact id (letters/numbers plus dots, dashes, or underscores; max 64). Reuse it only to version the same deliverable.",
        },
        title: {
          type: "string",
          description: "Short customer-facing title shown in Canvas (max 120 characters).",
        },
        kind: {
          type: "string",
          enum: ["html", "svg", "markdown", "mermaid", "react"],
          description:
            "Rendering format. Use mermaid for diagrams and provide raw Mermaid syntax without ``` fences. Use react for a live, interactive canvas — one component file with a default export, importing only from \"react\" and \"aurora/canvas\". The kind cannot change for an existing artifactId.",
        },
        content: {
          type: "string",
          description:
            "Complete self-contained source. Required for v1 and available for broad rewrites. Omit for a patch revision.",
        },
        baseVersionTag: {
          type: "string",
          description:
            "Latest version tag to patch, such as v1. Required with patches and rejected if stale.",
        },
        patches: {
          type: "array",
          description:
            "Exact-text replacements matched atomically against baseVersionTag. Regions cannot overlap and finds cannot depend on earlier replacements. Prefer this for focused, independent changes so unchanged source is not resent.",
          items: {
            type: "object",
            properties: {
              find: {
                type: "string",
                description:
                  "Exact text from the base version. Include enough surrounding text to make it unique unless all is true.",
              },
              replace: {
                type: "string",
                description: "Replacement text. Use an empty string to delete the matched text.",
              },
              all: {
                type: "boolean",
                description: "Replace every exact match. Defaults to false and otherwise requires one unique match.",
              },
            },
            required: ["find", "replace"],
          },
        },
      },
      required: ["artifactId", "title", "kind"],
    },
  },
};

export const readArtifactTool: ToolDefinition = {
  type: "function",
  function: {
    name: "read_artifact",
    description: `Read the immutable source of a saved Canvas artifact before revising it.

Call it with NO artifactId to list every artifact this conversation has saved, with titles, kinds, and latest version tags. Do that when reopening older work or when you no longer have an id in context — artifacts persist for the life of the conversation, long after the turn that created them.

Otherwise pass the artifactId and versionTag from an earlier present_artifact result. Omit query to retrieve the complete source. For a focused edit, provide a case-sensitive query and this returns exact matching excerpts with line numbers, reducing context usage while preserving text suitable for a patch find value.`,
    parameters: {
      type: "object",
      properties: {
        artifactId: {
          type: "string",
          description:
            "Stable artifact id to read. Omit it to list every artifact saved in this conversation.",
        },
        versionTag: {
          type: "string",
          description: "Saved version such as v1. Defaults to the latest version.",
        },
        query: {
          type: "string",
          description:
            "Optional case-sensitive source text to find. When present, returns matching excerpts instead of the full document.",
        },
        contextLines: {
          type: "integer",
          minimum: 0,
          maximum: 20,
          description: "Lines of surrounding context for query matches. Defaults to 2.",
        },
      },
      // Nothing is required: a bare call lists this conversation's artifacts,
      // which is how a model that has lost the id in a compaction finds its
      // way back to source it wrote.
      required: [],
    },
  },
};

export const artifactTools: ToolDefinition[] = [presentArtifactTool, readArtifactTool];
