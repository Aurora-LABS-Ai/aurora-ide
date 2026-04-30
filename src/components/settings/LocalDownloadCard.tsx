import React from 'react';
import { AlertTriangle, CheckCircle2, Download, Loader2, Trash2 } from 'lucide-react';
import type { LocalProvider, PullProgress } from '../../services/local-model-detector';
import { formatBytes } from './local-provider-utils';
import {
  Section,
  FormBlock,
  ActionButton,
  IdeTextInput,
} from '../modals/settings-primitives';

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
  pullModelName,
  onPullModelNameChange,
  pulling,
  pullProgress,
  pullError,
  onPullErrorClear,
  pullSuccess,
  onPullSuccessClear,
  onPull,
  onCancelPull,
  deleting,
  deleteConfirm,
  onDeleteConfirm,
  onDelete,
}) => {
  const pullProgressPct =
    pullProgress?.total && pullProgress.completed
      ? Math.round((pullProgress.completed / pullProgress.total) * 100)
      : 0;

  return (
    <Section
      title="Download Model"
      description={
        <>
          Pull from the Ollama registry (e.g.{' '}
          <code
            className="font-mono text-[10.5px]"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--aurora-editor-foreground) 5%, transparent)',
              padding: '0 4px',
              borderRadius: 3,
            }}
          >
            qwen3:8b
          </code>
          ).
        </>
      }
      icon={<Download className="h-3.5 w-3.5 text-text-secondary" />}
    >
      <FormBlock>
        <div className="flex gap-1.5">
          <div className="flex-1">
            <IdeTextInput
              type="text"
              value={pullModelName}
              onChange={(event) => {
                onPullModelNameChange(event.target.value);
                onPullErrorClear();
                onPullSuccessClear();
              }}
              placeholder="model:tag"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !pulling) onPull();
              }}
              disabled={pulling}
            />
          </div>
          {!pulling ? (
            <ActionButton
              variant="primary"
              icon={<Download className="h-3 w-3" />}
              disabled={!pullModelName.trim()}
              onClick={onPull}
            >
              Pull
            </ActionButton>
          ) : (
            <ActionButton variant="danger" onClick={onCancelPull}>
              Cancel
            </ActionButton>
          )}
        </div>

        {pulling && pullProgress && (
          <div className="mt-2 space-y-1.5">
            <div
              className="h-1.5 overflow-hidden"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--aurora-common-muted) 60%, transparent)',
                borderRadius: 4,
              }}
            >
              <div
                className="h-full transition-all duration-300"
                style={{
                  width: `${pullProgressPct}%`,
                  backgroundColor: 'var(--aurora-common-primary)',
                  borderRadius: 4,
                }}
              />
            </div>
            <div className="flex items-center justify-between text-[10px] text-text-disabled">
              <span>{pullProgress.status}</span>
              {pullProgress.total && pullProgress.completed ? (
                <span>
                  {formatBytes(pullProgress.completed)} / {formatBytes(pullProgress.total)} (
                  {pullProgressPct}%)
                </span>
              ) : null}
            </div>
          </div>
        )}

        {pullError && (
          <p
            className="mt-2 inline-flex items-center gap-1.5 text-[11px]"
            style={{ color: 'var(--aurora-common-danger)' }}
          >
            <AlertTriangle size={12} /> {pullError}
          </p>
        )}
        {pullSuccess && (
          <p
            className="mt-2 inline-flex items-center gap-1.5 text-[11px]"
            style={{ color: 'var(--aurora-common-success)' }}
          >
            <CheckCircle2 size={12} /> Model downloaded successfully!
          </p>
        )}
      </FormBlock>

      {selectedModelId && (
        <FormBlock divided={false}>
          {deleteConfirm === selectedModelId ? (
            <div
              className="space-y-2 px-3 py-2.5"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--aurora-common-danger) 6%, transparent)',
                border: '1px solid color-mix(in srgb, var(--aurora-common-danger) 30%, transparent)',
                borderRadius: 6,
              }}
            >
              <p
                className="text-[11px] font-medium"
                style={{ color: 'var(--aurora-common-danger)' }}
              >
                Delete <code className="font-mono">{selectedModelId}</code>? This cannot be undone.
              </p>
              <div className="flex gap-1.5">
                <ActionButton
                  variant="danger"
                  icon={
                    deleting === selectedModelId ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )
                  }
                  disabled={deleting === selectedModelId}
                  onClick={() => onDelete(selectedModelId)}
                >
                  Confirm Delete
                </ActionButton>
                <ActionButton variant="secondary" onClick={() => onDeleteConfirm(null)}>
                  Cancel
                </ActionButton>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onDeleteConfirm(selectedModelId)}
              className="inline-flex items-center gap-1.5 text-[11px] transition-colors"
              style={{
                color: 'color-mix(in srgb, var(--aurora-common-danger) 70%, transparent)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--aurora-common-danger)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color =
                  'color-mix(in srgb, var(--aurora-common-danger) 70%, transparent)';
              }}
            >
              <Trash2 size={11} /> Delete {selectedModelId}
            </button>
          )}
        </FormBlock>
      )}

    </Section>
  );
};
