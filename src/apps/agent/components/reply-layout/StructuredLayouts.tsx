import { useId, type ReactNode } from "react";

import type { StructuredLayout } from "@/apps/agent/lib/reply-layout/structures";
import { ChecklistItems } from "./ChecklistItems";
import { CompareAspects } from "./CompareAspects";
import { Field } from "./Field";
import { TimelineEvents } from "./TimelineEvents";
import { TreeOutline } from "./TreeOutline";

const FALLBACK_LABEL = { checklist: "Checklist", timeline: "Timeline", tree: "Hierarchy" } as const;

export function StructuredLayouts({ layout, foot }: { layout: StructuredLayout; foot?: ReactNode }) {
  const titleId = useId();

  if (layout.kind === "compare") {
    return <CompareAspects title={layout.title} heading={layout.heading} options={layout.options} rows={layout.rows} foot={foot} />;
  }

  return (
    <section
      className={`agw-rl agw-rl-structure agw-rl-${layout.kind}`}
      aria-labelledby={layout.title ? titleId : undefined}
      aria-label={layout.title ? undefined : FALLBACK_LABEL[layout.kind]}
    >
      {layout.title && <div id={titleId} className="agw-rl-block-title"><Field text={layout.title} /></div>}
      {layout.kind === "checklist" && <ChecklistItems items={layout.items} />}
      {layout.kind === "timeline" && <TimelineEvents items={layout.items} label={layout.title || "Events"} />}
      {layout.kind === "tree" && <TreeOutline nodes={layout.nodes} />}
      {foot}
    </section>
  );
}
