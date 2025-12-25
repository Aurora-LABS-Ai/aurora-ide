import React from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { TreeNode } from './TreeNode';

export const FileTree: React.FC = () => {
  const { files } = useWorkspaceStore();

  return (
    <div className="flex flex-col py-2">
      {files.map(node => (
        <TreeNode key={node.id} node={node} level={0} />
      ))}
    </div>
  );
};
