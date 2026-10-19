import { useId } from "react";

import { CHECKLIST_STATUSES, type StructuredLayout, type TreeNode } from "@/apps/agent/lib/reply-layout/structures";
import { Field } from "./Field";

function TreeItems({ nodes }: { nodes: TreeNode[] }) {
  return (
    <ul className="agw-rl-tree-list" role="list">
      {nodes.map((node, i) => (
        <li key={i}>
          <div className="agw-rl-tree-node">
            <div className="agw-rl-node-title"><Field text={node.title} /></div>
            {node.caption && <div className="agw-rl-node-caption"><Field text={node.caption} /></div>}
          </div>
          {node.children.length > 0 && <TreeItems nodes={node.children} />}
        </li>
      ))}
    </ul>
  );
}

export function StructuredLayouts({ layout }: { layout: StructuredLayout }) {
  const titleId = useId();

  if (layout.kind === "compare") {
    return (
      <div className="agw-rl agw-rl-structure agw-rl-compare">
        <table role="table" aria-label={layout.title ? undefined : "Comparison"}>
          {layout.title && <caption className="agw-rl-block-title"><Field text={layout.title} /></caption>}
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader" scope="col"><Field text={layout.heading} /></th>
              {layout.options.map((option, i) => <th key={i} role="columnheader" scope="col"><Field text={option} /></th>)}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {layout.rows.map((row, i) => (
              <tr key={i} role="row">
                <th role="rowheader" scope="row"><Field text={row.label} /></th>
                {row.values.map((value, j) => (
                  <td key={j} role="cell">
                    <span className="agw-rl-compare-option" aria-hidden="true"><Field text={layout.options[j]} /></span>
                    <span><Field text={value} /></span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <section
      className={`agw-rl agw-rl-structure agw-rl-${layout.kind}`}
      aria-labelledby={layout.title ? titleId : undefined}
      aria-label={layout.title ? undefined : { checklist: "Checklist", timeline: "Timeline", tree: "Hierarchy" }[layout.kind]}
    >
      {layout.title && <div id={titleId} className="agw-rl-block-title"><Field text={layout.title} /></div>}
      {layout.kind === "checklist" && (
        <ul className="agw-rl-status-list" role="list">
          {layout.items.map((item, i) => (
            <li key={i} className="agw-rl-status-row" data-status={item.status}>
              <span className="agw-rl-status">{CHECKLIST_STATUSES[item.status]}</span>
              <div className="agw-rl-item-body">
                <div className="agw-rl-node-title"><Field text={item.title} /></div>
                {item.caption && <div className="agw-rl-node-caption"><Field text={item.caption} /></div>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {layout.kind === "timeline" && (
        <ol className="agw-rl-dated-list" role="list">
          {layout.items.map((item, i) => (
            <li key={i} className="agw-rl-dated-row">
              <span className="agw-rl-date"><Field text={item.when} /></span>
              <div className="agw-rl-item-body">
                <div className="agw-rl-node-title"><Field text={item.title} /></div>
                {item.caption && <div className="agw-rl-node-caption"><Field text={item.caption} /></div>}
              </div>
            </li>
          ))}
        </ol>
      )}
      {layout.kind === "tree" && <TreeItems nodes={layout.nodes} />}
    </section>
  );
}
