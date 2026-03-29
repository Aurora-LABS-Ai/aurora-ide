import React from 'react';
import { AlertTriangle, CheckCircle2, Download, Loader2, Trash2 } from 'lucide-react';
import type { LocalProvider, PullProgress } from '../../services/local-model-detector';
import { formatBytes } from './local-provider-utils';
import {
  settingsCardStyle,
  settingsDangerPanelStyle,
  settingsInputStyle,
  settingsPrimaryButtonStyle,
} from '../modals/settings-shared';

interface Props {
  currentProvider: LocalProvider;
  selectedModelId: string;
  pullModelName: string;
  onPullModelNameChange: (v: string) => void;
  pulling: boolean;
  pullProgress: PullProgress | null;
  pullError: string | null;
  onPullErrorClear: () => void;
  pullSuccess: boolean;
  onPullSuccessClear: () => void;
  onPull: () => void;
  onCancelPull: () => void;
  deleting: string | null;
  deleteConfirm: string | null;
  onDeleteConfirm: (id: string | null) => void;
  onDelete: (id: string) => void;
}

export const LocalDownloadCard: React.FC<Props> = ({
  selectedModelId,
  pullModelName, onPullModelNameChange,
  pulling, pullProgress, pullError, onPullErrorClear, pullSuccess, onPullSuccessClear,
  onPull, onCancelPull,
  deleting, deleteConfirm, onDeleteConfirm, onDelete,
}) => {
  const pullProgressPct = pullProgress?.total && pullProgress.completed
    ? Math.round((pullProgress.completed / pullProgress.total) * 100)
    : 0;

  return (
    <div className="rounded-[20px] px-5 py-4 space-y-3" style={settingsCardStyle}>
      <div className="flex items-center gap-2">
        <Download className="w-3.5 h-3.5 text-text-secondary" />
        <span className="text-[11px] font-semibold text-text-primary tracking-wide uppercase">Download Model</span>
      </div>
      <p className="text-[10px] text-text-disabled">
        Pull from the Ollama registry (e.g. <code className="bg-sidebar px-1 rounded">qwen3:8b</code>).
      </p>

      <div className="flex gap-2">
        <input
          type="text"
          value={pullModelName}
          onChange={(e) => { onPullModelNameChange(e.target.value); onPullErrorClear(); onPullSuccessClear(); }}
          placeholder="model:tag"
          onKeyDown={(e) => { if (e.key === 'Enter' && !pulling) onPull(); }}
          disabled={pulling}
          className="flex-1 rounded-xl px-3 py-2 text-xs text-text-primary placeholder:text-text-disabled focus:outline-none transition-colors"
          style={settingsInputStyle}
        />
        {!pulling ? (
          <button
            onClick={onPull}
            disabled={!pullModelName.trim()}
            className="px-4 py-2 rounded-xl text-primary-foreground text-xs font-semibold hover:bg-primary-hover transition-colors disabled:opacity-50 flex items-center gap-1.5 shrink-0"
            style={settingsPrimaryButtonStyle}
          >
            <Download size={12} /> Pull
          </button>
        ) : (
          <button
            onClick={onCancelPull}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-danger border border-danger/30 hover:bg-danger/10 transition-colors flex items-center gap-1.5 shrink-0"
          >
            Cancel
          </button>
        )}
      </div>

      {/* Progress */}
      {pulling && pullProgress && (
        <div className="space-y-1.5">
          <div className="h-2 rounded-full overflow-hidden" style={{
            backgroundColor: 'color-mix(in srgb, var(--aurora-common-muted) 60%, transparent)',
          }}>
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{ width: `${pullProgressPct}%`, backgroundColor: 'var(--aurora-common-primary)' }}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] text-text-disabled">
            <span>{pullProgress.status}</span>
            {pullProgress.total && pullProgress.completed ? (
              <span>{formatBytes(pullProgress.completed)} / {formatBytes(pullProgress.total)} ({pullProgressPct}%)</span>
            ) : null}
          </div>
        </div>
      )}

      {pullError && (
        <p className="text-[11px] text-danger flex items-center gap-1.5">
          <AlertTriangle size={12} /> {pullError}
        </p>
      )}
      {pullSuccess && (
        <p className="text-[11px] text-success flex items-center gap-1.5">
          <CheckCircle2 size={12} /> Model downloaded successfully!
        </p>
      )}

      {/* Delete */}
      {selectedModelId && (
        <div className="pt-2 border-t" style={{ borderColor: 'color-mix(in srgb, var(--aurora-common-border) 40%, transparent)' }}>
          {deleteConfirm === selectedModelId ? (
            <div className="rounded-xl p-3 space-y-2" style={settingsDangerPanelStyle}>
              <p className="text-[11px] text-danger font-medium">
                Delete <code className="font-mono">{selectedModelId}</code>? This cannot be undone.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => onDelete(selectedModelId)}
                  disabled={deleting === selectedModelId}
                  className="px-3 py-1.5 rounded-lg bg-danger text-primary-foreground text-[11px] font-semibold hover:bg-danger/90 disabled:opacity-50 flex items-center gap-1"
                >
                  {deleting === selectedModelId ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
                  Confirm Delete
                </button>
                <button
                  onClick={() => onDeleteConfirm(null)}
                  className="px-3 py-1.5 rounded-lg text-[11px] text-text-secondary hover:text-text-primary transition-colors"
                  style={settingsInputStyle}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => onDeleteConfirm(selectedModelId)}
              className="text-[11px] text-danger/70 hover:text-danger transition-colors flex items-center gap-1.5"
            >
              <Trash2 size={11} /> Delete {selectedModelId}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
