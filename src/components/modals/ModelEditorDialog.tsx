import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { DollarSign, Eye, ImageIcon, Sparkles, Wrench, X } from 'lucide-react';

import type { LLMModel } from '../../store/useSettingsStore';
import { IdeSwitch } from '../ui/IdeSwitch';
import {
  ActionButton,
  FieldLabel,
  IconButton,
  IdeTextInput,
  Section,
  StatusPill,
} from './settings-primitives';
import { settingsRowDividerColor } from './settings-shared';

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
  /** USD per 1M tokens. `undefined` = unset → cost row hidden in UI. */
  priceCacheHitPerMtok?: number;
  priceCacheMissPerMtok?: number;
  priceOutputPerMtok?: number;
  priceCurrency?: string;
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
  boxShadow: '0 12px 48px var(--aurora-common-shadow-elevated)',
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
  // Pricing — stored as strings so the user can clear them. Empty
  // string means "unset / inherit nothing"; a non-empty value is
  // parsed to f64 on save.
  const [priceCacheHit, setPriceCacheHit] = useState<string>('');
  const [priceCacheMiss, setPriceCacheMiss] = useState<string>('');
  const [priceOutput, setPriceOutput] = useState<string>('');

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
    setPriceCacheHit(
      initial?.priceCacheHitPerMtok !== undefined
        ? String(initial.priceCacheHitPerMtok)
        : '',
    );
    setPriceCacheMiss(
      initial?.priceCacheMissPerMtok !== undefined
        ? String(initial.priceCacheMissPerMtok)
        : '',
    );
    setPriceOutput(
      initial?.priceOutputPerMtok !== undefined
        ? String(initial.priceOutputPerMtok)
        : '',
    );
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

  const parsePrice = (s: string): number | undefined => {
    const trimmed = s.trim();
    if (!trimmed) return undefined;
    const n = Number.parseFloat(trimmed);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return n;
  };

  const handleSave = () => {
    if (!isValid) return;
    const ctx = contextWindow.trim() ? Number.parseInt(contextWindow, 10) : undefined;
    const out = maxOutputTokens.trim() ? Number.parseInt(maxOutputTokens, 10) : undefined;
    const cacheHit = parsePrice(priceCacheHit);
    const cacheMiss = parsePrice(priceCacheMiss);
    const output = parsePrice(priceOutput);
    onSave({
      modelKey: trimmedKey,
      label: label.trim() || undefined,
      contextWindow: Number.isFinite(ctx) ? ctx : undefined,
      maxOutputTokens: Number.isFinite(out) ? out : undefined,
      supportsVision,
      supportsThinking,
      supportsToolStream,
      enabled,
      priceCacheHitPerMtok: cacheHit,
      priceCacheMissPerMtok: cacheMiss,
      priceOutputPerMtok: output,
      // Only stamp currency when at least one price is set; null/USD
      // are equivalent on the read side, but keeping it null when
      // unset is cleaner for "Reset to defaults" semantics later.
      priceCurrency:
        cacheHit !== undefined || cacheMiss !== undefined || output !== undefined
          ? 'USD'
          : undefined,
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim backdrop-blur-sm p-6"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-[820px] max-h-[calc(100vh-48px)] flex-col"
        style={dialogShellStyle}
        onClick={(event) => event.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex shrink-0 items-center justify-between gap-3 px-5 py-3"
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

        {/* Body — grid layout, scroll only if viewport is truly small */}
        <div className="flex-1 overflow-y-auto scrollbar-thin px-5 py-4">
          <div className="grid grid-cols-2 gap-x-4 gap-y-4">
            {/* Identity — full width with 2-column inner grid */}
            <div className="col-span-2">
              <Section title="Identity">
                <div className="grid grid-cols-2 gap-x-4 px-4 py-3.5">
                  <div className="min-w-0">
                    <FieldLabel className="mb-1.5">Model ID *</FieldLabel>
                    <IdeTextInput
                      value={modelKey}
                      onChange={(event) => setModelKey(event.target.value)}
                      placeholder="e.g. gpt-4o, deepseek-v4-pro, llama3.2:70b"
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
                  </div>
                  <div className="min-w-0">
                    <FieldLabel className="mb-1.5">Display label</FieldLabel>
                    <IdeTextInput
                      value={label}
                      onChange={(event) => setLabel(event.target.value)}
                      placeholder="Optional — falls back to humanized ID"
                    />
                  </div>
                </div>
              </Section>
            </div>

            {/* Capabilities — left column, compact toggle rows */}
            <div className="min-w-0">
              <Section title="Capabilities">
                <CapabilityRow
                  icon={
                    <ImageIcon
                      className="h-3.5 w-3.5"
                      style={{
                        color: supportsVision
                          ? 'var(--aurora-common-primary)'
                          : 'var(--aurora-editor-foreground-muted)',
                      }}
                    />
                  }
                  label="Vision"
                  hint="Accepts image content blocks"
                  checked={supportsVision}
                  onChange={setSupportsVision}
                  ariaLabel="Toggle vision capability"
                />
                <CapabilityRow
                  icon={
                    <Sparkles
                      className="h-3.5 w-3.5"
                      style={{
                        color: supportsThinking
                          ? 'var(--aurora-common-primary)'
                          : 'var(--aurora-editor-foreground-muted)',
                      }}
                    />
                  }
                  label="Thinking"
                  hint="Streams reasoning_content / thinking blocks"
                  checked={supportsThinking}
                  onChange={setSupportsThinking}
                  ariaLabel="Toggle thinking capability"
                />
                <CapabilityRow
                  icon={
                    <Wrench
                      className="h-3.5 w-3.5"
                      style={{
                        color: supportsToolStream
                          ? 'var(--aurora-common-primary)'
                          : 'var(--aurora-editor-foreground-muted)',
                      }}
                    />
                  }
                  label="Tool streaming"
                  hint="Provider streams partial tool-call deltas"
                  checked={supportsToolStream}
                  onChange={setSupportsToolStream}
                  ariaLabel="Toggle tool-stream capability"
                />
                <CapabilityRow
                  icon={
                    <Eye
                      className="h-3.5 w-3.5"
                      style={{
                        color: enabled
                          ? 'var(--aurora-common-success)'
                          : 'var(--aurora-editor-foreground-muted)',
                      }}
                    />
                  }
                  label="Enabled"
                  hint="Show in the model selector dropdown"
                  checked={enabled}
                  onChange={setEnabled}
                  ariaLabel="Toggle model enabled"
                  isLast
                />
              </Section>
            </div>

            {/* Limits — right column */}
            <div className="min-w-0">
              <Section
                title="Limits"
                badge={<StatusPill variant="neutral" dot={false}>Optional</StatusPill>}
              >
                <div className="px-4 py-3.5 space-y-3">
                  <div>
                    <FieldLabel className="mb-1.5">Context window</FieldLabel>
                    <IdeTextInput
                      type="number"
                      value={contextWindow}
                      onChange={(event) => setContextWindow(event.target.value)}
                      placeholder={`Inherit (${providerContextWindow.toLocaleString()})`}
                      style={{ fontFamily: 'monospace' }}
                    />
                  </div>
                  <div>
                    <FieldLabel className="mb-1.5">Max output tokens</FieldLabel>
                    <IdeTextInput
                      type="number"
                      value={maxOutputTokens}
                      onChange={(event) => setMaxOutputTokens(event.target.value)}
                      placeholder={`Inherit (${providerMaxOutput.toLocaleString()})`}
                      style={{ fontFamily: 'monospace' }}
                    />
                  </div>
                </div>
              </Section>
            </div>

            {/* Pricing — full width, 3-column grid */}
            <div className="col-span-2">
              <Section
                title="Pricing"
                description="USD per 1M tokens. Drives the live cost estimate in the chat context badge."
                badge={
                  <StatusPill variant="neutral" dot={false}>
                    <DollarSign className="h-2.5 w-2.5" />
                    <span className="ml-0.5">USD / 1M tok</span>
                  </StatusPill>
                }
              >
                <div className="grid grid-cols-3 gap-x-4 px-4 py-3.5">
                  <div className="min-w-0">
                    <FieldLabel className="mb-1.5">Cache hit</FieldLabel>
                    <IdeTextInput
                      type="number"
                      value={priceCacheHit}
                      onChange={(event) => setPriceCacheHit(event.target.value)}
                      placeholder="0.003625"
                      style={{ fontFamily: 'monospace' }}
                    />
                  </div>
                  <div className="min-w-0">
                    <FieldLabel className="mb-1.5">Cache miss / fresh input</FieldLabel>
                    <IdeTextInput
                      type="number"
                      value={priceCacheMiss}
                      onChange={(event) => setPriceCacheMiss(event.target.value)}
                      placeholder="0.435"
                      style={{ fontFamily: 'monospace' }}
                    />
                  </div>
                  <div className="min-w-0">
                    <FieldLabel className="mb-1.5">Output</FieldLabel>
                    <IdeTextInput
                      type="number"
                      value={priceOutput}
                      onChange={(event) => setPriceOutput(event.target.value)}
                      placeholder="0.87"
                      style={{ fontFamily: 'monospace' }}
                    />
                  </div>
                </div>
              </Section>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex shrink-0 items-center justify-end gap-2 px-5 py-3"
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

// ---------------------------------------------------------------------------
// CapabilityRow — compact single-line toggle row that fits inside a narrow
// column. Icon + label + optional hint on the left, switch pinned right.
// Last row drops its divider so it sits flush with the Section panel border.
// ---------------------------------------------------------------------------

interface CapabilityRowProps {
  icon: React.ReactNode;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
  isLast?: boolean;
}

const CapabilityRow: React.FC<CapabilityRowProps> = ({
  icon,
  label,
  hint,
  checked,
  onChange,
  ariaLabel,
  isLast,
}) => (
  <div
    className="flex items-center gap-3 px-4 py-2.5"
    style={
      isLast
        ? undefined
        : { borderBottom: `1px solid ${settingsRowDividerColor}` }
    }
  >
    <span className="flex h-5 w-5 shrink-0 items-center justify-center">
      {icon}
    </span>
    <div className="min-w-0 flex-1">
      <p className="truncate text-[12.5px] font-medium leading-tight text-text-primary">
        {label}
      </p>
      <p className="mt-0.5 truncate text-[10.5px] leading-tight text-text-secondary">
        {hint}
      </p>
    </div>
    <IdeSwitch
      checked={checked}
      onChange={onChange}
      ariaLabel={ariaLabel}
      variant="primary"
      size="sm"
    />
  </div>
);
