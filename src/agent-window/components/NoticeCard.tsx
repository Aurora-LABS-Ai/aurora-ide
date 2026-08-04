/**
 * Agent Window — inline runtime notice.
 *
 * Something the RUNTIME needs to tell the user mid-transcript: the reply was
 * cut off at the output-token limit, the response stream dropped, a provider
 * hiccup was absorbed. It renders at the exact point it happened, in its own
 * marker.
 *
 * Why a marker and not message text: these sentences do not come from the
 * model. Folding them into the assistant's content — which is what the old
 * error path did — makes the agent appear to announce its own truncation, and
 * the user cannot tell the product's voice from the model's. Structurally
 * separating it also survives the JSONL reload, where message content would
 * have carried the injected prose forever.
 *
 * Mirrors `.agw-injection` (the mid-turn user note) for shape, switched to the
 * warning color role. The icon carries the meaning alongside the tint so the
 * state is not communicated by color alone.
 */

import { AlertTriangle } from "lucide-react";

export function NoticeCard({ text }: { text: string }) {
  return (
    <div className="agw-notice" role="status">
      <AlertTriangle size={13} strokeWidth={2} aria-hidden />
      <span>{text}</span>
    </div>
  );
}
