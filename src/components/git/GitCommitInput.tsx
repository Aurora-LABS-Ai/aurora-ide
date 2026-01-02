/**
 * GitCommitInput Component
 * Text input for commit messages with commit button
 */

import React, { useCallback, useRef } from 'react';
import { Check } from 'lucide-react';

interface GitCommitInputProps {
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  disabled?: boolean;
}

export const GitCommitInput: React.FC<GitCommitInputProps> = ({
  value,
  onChange,
  onCommit,
  disabled = false,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Ctrl/Cmd + Enter to commit
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !disabled && value.trim()) {
        e.preventDefault();
        onCommit();
      }
    },
    [disabled, value, onCommit]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
    },
    [onChange]
  );

  const canCommit = !disabled && value.trim().length > 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Message (Ctrl+Enter to commit)"
          rows={3}
          className="w-full px-3 py-2 text-[13px] rounded-lg resize-none outline-none transition-colors"
          style={{
            background: 'var(--aurora-editor-background)',
            color: 'var(--aurora-editor-foreground)',
            border: '1px solid var(--aurora-common-border)',
          }}
        />
      </div>
      <button
        onClick={onCommit}
        disabled={!canCommit}
        className="w-full py-2 px-4 rounded-lg text-[13px] font-medium transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        style={{
          background: canCommit ? 'var(--aurora-common-primary)' : 'var(--aurora-common-border)',
          color: canCommit ? 'white' : 'var(--aurora-sidebar-foreground)',
        }}
      >
        <Check className="w-4 h-4" />
        Commit
      </button>
    </div>
  );
};

export default GitCommitInput;
