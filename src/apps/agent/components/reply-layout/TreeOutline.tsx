/**
 * Agent Window — a hierarchy that folds [view].
 *
 * Every item with children is a disclosure: press it to fold or open its
 * branch, and a folded branch says how many items it holds. A small tree
 * starts fully open; past FOLD_FROM items only the first level is open, so a
 * 30-row module tree arrives as its top-level shape and the reader opens the
 * branch they came for. Nested lists keep the parent/child meaning for
 * screen readers. Fold state is view state only.
 */

import React, { useState } from "react";

import type { TreeNode } from "@/apps/agent/lib/reply-layout/structures";
import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { Field } from "./Field";

const FOLD_FROM = 12;

function countNodes(nodes: TreeNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

const TreeItem: React.FC<{ node: TreeNode; depth: number; openDepth: number }> = ({ node, depth, openDepth }) => {
  const [open, setOpen] = useState(depth < openDepth);
  const inside = node.children.length > 0 ? countNodes(node.children) : 0;

  return (
    <li>
      <div className="agw-rl-tree-node">
        {inside > 0 ? (
          <button type="button" className="agw-rl-tree-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            <AgentIcon name="chevron-right" size={14} className="agw-rl-tree-chev" />
            <span className="agw-rl-node-title"><Field text={node.title} /></span>
            {!open && <span className="agw-rl-tree-inside">{inside} inside</span>}
          </button>
        ) : (
          <div className="agw-rl-node-title agw-rl-tree-leaf"><Field text={node.title} /></div>
        )}
        {node.caption && <div className="agw-rl-node-caption agw-rl-tree-caption"><Field text={node.caption} /></div>}
      </div>
      {inside > 0 && (
        <ul className="agw-rl-tree-list" role="list" hidden={!open}>
          {node.children.map((child, i) => (
            <TreeItem key={i} node={child} depth={depth + 1} openDepth={openDepth} />
          ))}
        </ul>
      )}
    </li>
  );
};

export const TreeOutline: React.FC<{ nodes: TreeNode[] }> = ({ nodes }) => {
  const openDepth = countNodes(nodes) > FOLD_FROM ? 1 : Number.POSITIVE_INFINITY;
  return (
    <ul className="agw-rl-tree-list" role="list">
      {nodes.map((node, i) => (
        <TreeItem key={i} node={node} depth={0} openDepth={openDepth} />
      ))}
    </ul>
  );
};
