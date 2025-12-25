import React from 'react';
import { TabBar } from './TabBar';
import { CodeEditor } from './CodeEditor';

export const EditorPanel: React.FC = () => {
  return (
    <div className="h-full flex flex-col">
      <TabBar />
      <CodeEditor />
    </div>
  );
};
