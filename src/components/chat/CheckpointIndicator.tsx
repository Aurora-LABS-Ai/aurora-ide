/**
 * Checkpoint Indicator Component
 *
 * Shows a checkpoint indicator on user messages that have a checkpoint.
 * Clicking the indicator restores to that checkpoint state:
 * - Files are restored to checkpoint state
 * - Messages after checkpoint are deleted
 * - The checkpoint message content is put back in input box
 */

import React, { useState, useCallback } from 'react';
import { History, Loader2 } from 'lucide-react';
import { useCheckpointStore } from '../../store/useCheckpointStore';
import { useThreadStore } from '../../store/useThreadStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useChatStore } from '../../store/useChatStore';

interface CheckpointIndicatorProps {
  messageId: string;
  messageContent: string; // The content of this message to restore to input
  className?: string;
}

export const CheckpointIndicator: React.FC<CheckpointIndicatorProps> = ({
  messageId,
  messageContent,
  className = '',
}) => {
  const [showConfirm, setShowConfirm] = useState(false);
  const { hasCheckpoint, getCheckpoint, restoreToCheckpoint, isRestoring } = useCheckpointStore();
  const { removeMessagesAfter } = useThreadStore();
  const { refreshDirectory } = useWorkspaceStore();
  const { setInputContent } = useChatStore();

  const checkpoint = getCheckpoint(messageId);
  const hasCP = hasCheckpoint(messageId);

  const handleRestore = useCallback(async () => {
    if (!checkpoint) return;

    // Perform the restore (restores files to checkpoint state)
    await restoreToCheckpoint(checkpoint.id);

    // Always do UI updates even if backend restore had issues
    // Remove messages INCLUDING and after this checkpoint message
    // (the message itself should be "unsent" - put back in input)
    removeMessagesAfter(messageId, true); // true = include this message

    // Put the message content back in the input box
    setInputContent(messageContent);

    // Refresh file explorer to show restored files
    refreshDirectory();

    setShowConfirm(false);
  }, [
    checkpoint,
    messageId,
    messageContent,
    restoreToCheckpoint,
    removeMessagesAfter,
    setInputContent,
    refreshDirectory,
  ]);

  if (!hasCP) {
    return null;
  }

  if (isRestoring) {
    return (
      <div className={`flex items-center gap-1 text-checkpoint ${className}`}>
        <Loader2 className="w-3 h-3 animate-spin" />
        <span className="text-[10px]">Restoring...</span>
      </div>
    );
  }

  if (showConfirm) {
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        <span className="text-[10px] text-checkpoint">Restore to this point?</span>
        <button
          onClick={handleRestore}
          className="px-2 py-0.5 text-[10px] bg-checkpoint/20 hover:bg-checkpoint/30 text-checkpoint rounded transition-colors"
        >
          Yes
        </button>
        <button
          onClick={() => setShowConfirm(false)}
          className="px-2 py-0.5 text-[10px] bg-white/5 hover:bg-white/10 text-text-secondary rounded transition-colors"
        >
          No
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setShowConfirm(true)}
      className={`flex items-center gap-1 text-text-disabled hover:text-checkpoint transition-colors group ${className}`}
      title="Restore to this checkpoint (undo changes after this message)"
    >
      <History className="w-3 h-3" />
      <span className="text-[10px] opacity-0 group-hover:opacity-100 transition-opacity">
        checkpoint
      </span>
    </button>
  );
};
