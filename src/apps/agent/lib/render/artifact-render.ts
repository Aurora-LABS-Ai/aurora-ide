import type { AgentArtifactKind } from "@/apps/agent/services/artifacts/agent-artifacts";

const HTML_DOCUMENT_PATTERN = /^\s*(?:<!doctype\s+html[^>]*>|<html[\s>])/i;

export function buildArtifactDocument(
  kind: Extract<AgentArtifactKind, "html" | "svg">,
  content: string,
): string {
  if (kind === "html" && HTML_DOCUMENT_PATTERN.test(content)) return content;

  if (kind === "svg") {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:100%;background:transparent}body{display:grid;place-items:center;padding:24px;box-sizing:border-box}svg{display:block;max-width:100%;max-height:100vh}</style></head><body>${content}</body></html>`;
  }

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:100%}body{box-sizing:border-box}</style></head><body>${content}</body></html>`;
}
