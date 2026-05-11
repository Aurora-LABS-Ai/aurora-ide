import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, ImageIcon, Sparkles, Wrench, X } from 'lucide-react';

import type { LLMModel } from '../../store/useSettingsStore';
import { IdeSwitch } from '../ui/IdeSwitch';
import {
  ActionButton,
  FieldLabel,
  FormBlock,
  FormRow,
  FormRowLast,
  IconButton,
  IdeTextInput,
  Section,
  StatusPill,
} from './settings-primitives';

/**
 * Add / edit a single per-provider model row.
 *
 * v15+ — capabilities (vision, thinking, tool-stream) and per-model
 * context/output overrides live on the model row itself rather than
 * the provider, so this dialog is the single place those switches
 * live in the UI. Reused for both Add (no `initial`) and Edit
 * (`initial` provided).
 */

export interface ModelDraft {
  modelKey: string;
  label?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision: boolean;
  supportsThinking: boolean;
  supportsToolStream: boolean;
  enabled: boolean;
}

export interface ModelEditorDialogProps {
  isOpen: boolean;
  /** When supplied, the dialog opens in Edit mode (modelKey is locked). */
  initial?: LLMModel;
  /** Provider name shown in the header so the user knows where the model lands. */
  providerName: string;
  /** Provider's default context window — surfaced as input placeholder. */
  providerContextWindow: number;
  /** Provider's default max output — surfaced as input placeholder. */
  providerMaxOutput: number;
  /** Existing modelKey set under this provider — used for duplicate-key validation in Add mode. */
  existingKeys: string[];
  onClose: () => void;
  onSave: (draft: ModelDraft) => void;
}

const dialogShellStyle: React.CSSProperties = {
  backgroundColor: 'var(--aurora-sidebar-background)',
  border: '1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)',
  borderRadius: 8,
  boxShadow: '0 12px 48px rgba(0,0,0,0.45)',
};

export const ModelEditorDialog: React.FC<ModelEditorDialogProps> = ({
  isOpen,
  initial,
  providerName,
  providerContextWindow,
  providerMaxOutput,
  existingKeys,
  onClose,
  onSave,
}) => {
  const isEdit = !!initial;
  const [modelKey, setModelKey] = useState('');
  const [label, setLabel] = useState('');
  const [contextWindow, setContextWindow] = useState<string>('');
  const [maxOutputTokens, setMaxOutputTokens] = useState<string>('');
  const [supportsVision, setSupportsVision] = useState(false);
  const [supportsThinking, setSupportsThinking] = useState(false);
  const [supportsToolStream, setSupportsToolStream] = useState(false);
  const [enabled, setEnabled] = useState(true);

  // Reset internal state every time the dialog opens or the target model changes.
  useEffect(() => {
    if (!isOpen) return;
    setModelKey(initial?.modelKey ?? '');
    setLabel(initial?.label ?? '');
    setContextWindow(
      initial?.contextWindow !== undefined ? String(initial.contextWindow) : '',
    );
    setMaxOutputTokens(
      initial?.maxOutputTokens !== undefined ? String(initial.maxOutputTokens) : '',
    );
    setSupportsVision(initial?.supportsVision ?? false);
    setSupportsThinking(initial?.supportsThinking ?? false);
    setSupportsToolStream(initial?.supportsToolStream ?? false);
    setEnabled(initial?.enabled ?? true);
  }, [isOpen, initial]);

  // ESC closes the dialog. Bound to the document so it works even
  // when focus is inside an input.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;
  // The Settings panel that hosts us is itself a centered modal whose
  // outer container creates a new containing block (transform / filter
  // ancestors are common in those kinds of shells). That bounds any
  // `position: fixed` descendants to the modal's box and clips them
  // top/bottom. Render via portal to escape into <body>.
  if (typeof document === 'undefined') return null;

  const trimmedKey = modelKey.trim();
  const duplicate =
    !isEdit && trimmedKey.length > 0 && existingKeys.includes(trimmedKey);
  const isValid = trimmedKey.length > 0 && !duplicate;

  const handleSave = () => {
    if (!isValid) return;
    const ctx = contextWindow.trim() ? Number.parseInt(contextWindow, 10) : undefined;
    const out = maxOutputTokens.trim() ? Number.parseInt(maxOutputTokens, 10) : undefined;
    onSave({
      modelKey: trimmedKey,
      label: label.trim() || undefined,
      contextWindow: Number.isFinite(ctx) ? ctx : undefined,
      maxOutputTokens: Number.isFinite(out) ? out : undefined,
      supportsVision,
      supportsThinking,
      supportsToolStream,
      enabled,
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[560px] max-h-[calc(100vh-32px)] overflow-y-auto scrollbar-thin"
        style={dialogShellStyle}
        onClick={(event) => event.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between gap-3 px-4 py-3"
          style={{
            borderBottom:
              '1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)',
            backgroundColor:
              'color-mix(in srgb, var(--aurora-title-bar-background) 50%, var(--aurora-sidebar-background) 50%)',
          }}
        >
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold text-text-primary">
              {isEdit ? 'Edit model' : 'Add model'}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-text-secondary">
              {providerName}
            </p>
          </div>
          <IconButton ariaLabel="Close" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </div>

        {/* Body */}
        <div className="space-y-3 p-4">
          <Section title="Identity">
            <FormBlock>
              <FieldLabel className="mb-1">Model ID *</FieldLabel>
              <IdeTextInput
                value={modelKey}
                onChange={(event) => setModelKey(event.target.value)}
                placeholder="e.g. gpt-4o, llama3.2:70b, accounts/.../qwen3-coder"
                disabled={isEdit}
                style={{ fontFamily: 'monospace' }}
              />
              {duplicate && (
                <p
                  className="mt-1 text-[11px]"
                  style={{ color: 'var(--aurora-common-danger)' }}
                >
                  A model with this ID already exists under {providerName}.
                </p>
              )}
            </FormBlock>
            <FormBlock divided={false}>
              <FieldLabel className="mb-1">Display label</FieldLabel>
              <IdeTextInput
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Optional — falls back to a humanized model ID"
              />
            </FormBlock>
          </Section>

          <Section title="Capabilities">
            <FormRow
              label="Vision capable"
              hint="Tick if this model accepts image content blocks (Claude 3+, GPT-4o, Llama-vision, …). Drives the browser_screenshot tool gate and switches the API adapter into multimodal tool-result mode."
            >
              <div className="flex items-center gap-2">
                <ImageIcon
                  className="h-3 w-3"
                  style={{
                    color: supportsVision
                      ? 'var(--aurora-common-primary)'
                      : 'var(--aurora-editor-foreground-muted)',
                  }}
                />
                <IdeSwitch
                  checked={supportsVision}
                  onChange={setSupportsVision}
                  ariaLabel="Toggle vision capability"
                  variant="primary"
                  size="sm"
                />
              </div>
            </FormRow>
            <FormRow
              label="Thinking / reasoning"
              hint="Tick when this model exposes a reasoning_content field (DeepSeek-R1, GLM-Z, Fireworks GPT-OSS) or native Anthropic thinking blocks."
            >
              <div className="flex items-center gap-2">
                <Sparkles
                  className="h-3 w-3"
                  style={{
                    color: supportsThinking
                      ? 'var(--aurora-common-primary)'
                      : 'var(--aurora-editor-foreground-muted)',
                  }}
                />
                <IdeSwitch
                  checked={supportsThinking}
                  onChange={setSupportsThinking}
                  ariaLabel="Toggle thinking capability"
                  variant="primary"
                  size="sm"
                />
              </div>
            </FormRow>
            <FormRow
              label="Streaming tool calls"
              hint="Tick when the provider streams partial tool-call deltas (GLM-4.5, MiniMax). Most OpenAI-compatible endpoints don't need this."
            >
              <div className="flex items-center gap-2">
                <Wrench
                  className="h-3 w-3"
                  style={{
                    color: supportsToolStream
                      ? 'var(--aurora-common-primary)'
                      : 'var(--aurora-editor-foreground-muted)',
                  }}
                />
                <IdeSwitch
                  checked={supportsToolStream}
                  onChange={setSupportsToolStream}
                  ariaLabel="Toggle tool-stream capability"
                  variant="primary"
                  size="sm"
                />
              </div>
            </FormRow>
            <FormRowLast
              label="Enabled"
              hint="Disabled models stay in the list but won't appear in the selector dropdown."
            >
              <div className="flex items-center gap-2">
                <Eye
                  className="h-3 w-3"
                  style={{
                    color: enabled
                      ? 'var(--aurora-common-success)'
                      : 'var(--aurora-editor-foreground-muted)',
                  }}
                />
                <IdeSwitch
                  checked={enabled}
                  onChange={setEnabled}
                  ariaLabel="Toggle model enabled"
                  variant="primary"
                  size="sm"
                />
              </div>
            </FormRowLast>
          </Section>

          <Section
            title="Limits"
            description="Leave blank to inherit the provider defaults. Override here when a specific model has tighter limits than the rest of its family."
            badge={<StatusPill variant="neutral" dot={false}>Optional</StatusPill>}
          >
            <FormBlock>
              <FieldLabel className="mb-1">Context window override</FieldLabel>
              <IdeTextInput
                type="number"
                value={contextWindow}
                onChange={(event) => setContextWindow(event.target.value)}
                placeholder={`Inherit (${providerContextWindow.toLocaleString()})`}
                style={{ fontFamily: 'monospace' }}
              />
            </FormBlock>
            <FormBlock divided={false}>
              <FieldLabel className="mb-1">Max output tokens override</FieldLabel>
              <IdeTextInput
                type="number"
                value={maxOutputTokens}
                onChange={(event) => setMaxOutputTokens(event.target.value)}
                placeholder={`Inherit (${providerMaxOutput.toLocaleString()})`}
                style={{ fontFamily: 'monospace' }}
              />
            </FormBlock>
          </Section>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-4 py-3"
          style={{
            borderTop:
              '1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)',
            backgroundColor:
              'color-mix(in srgb, var(--aurora-title-bar-background) 50%, var(--aurora-sidebar-background) 50%)',
          }}
        >
          <ActionButton variant="secondary" onClick={onClose}>
            Cancel
          </ActionButton>
          <ActionButton variant="primary" onClick={handleSave} disabled={!isValid}>
            {isEdit ? 'Save changes' : 'Add model'}
          </ActionButton>
        </div>
      </div>
    </div>,
    document.body,
  );
};
