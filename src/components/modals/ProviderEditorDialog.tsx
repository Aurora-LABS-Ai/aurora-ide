import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, EyeOff, Globe, Server, X } from 'lucide-react';

import { IdeSelect } from '../ui/IdeSelect';
import {
  ActionButton,
  FieldLabel,
  FormBlock,
  IconButton,
  IdeTextInput,
  Section,
  StatusPill,
} from './settings-primitives';

/**
 * Add a new custom provider.
 *
 * Mirrors `ModelEditorDialog`: portal-rendered to escape the Settings
 * modal's containing block, ESC-to-close, internal scroll cap so a
 * tall body never pushes the action buttons off-screen.
 *
 * Per-model capabilities (vision, thinking, tool-stream) and per-model
 * context/output overrides live in `ModelEditorDialog`. This dialog
 * only captures the **transport + auth + defaults** surface plus an
 * initial model ID so the provider has at least one model row from
 * day one. The user can add more models from the provider's detail
 * view in the Providers hub.
 */

export interface ProviderDraft {
  name: string;
  nickname: string;
  providerType: 'openai' | 'anthropic' | 'custom';
  baseUrl: string;
  apiKey: string;
  initialModelKey: string;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface ProviderEditorDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (draft: ProviderDraft) => void;
}

const dialogShellStyle: React.CSSProperties = {
  backgroundColor: 'var(--aurora-sidebar-background)',
  border: '1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)',
  borderRadius: 8,
  boxShadow: '0 12px 48px rgba(0,0,0,0.45)',
};

export const ProviderEditorDialog: React.FC<ProviderEditorDialogProps> = ({
  isOpen,
  onClose,
  onSave,
}) => {
  const [name, setName] = useState('');
  const [nickname, setNickname] = useState('');
  const [providerType, setProviderType] = useState<'openai' | 'anthropic' | 'custom'>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [model, setModel] = useState('');
  const [contextWindow, setContextWindow] = useState<string>('200000');
  const [maxOutputTokens, setMaxOutputTokens] = useState<string>('8192');

  // Reset on every open so a previous abandoned draft doesn't leak.
  useEffect(() => {
    if (!isOpen) return;
    setName('');
    setNickname('');
    setProviderType('openai');
    setBaseUrl('');
    setApiKey('');
    setShowApiKey(false);
    setModel('');
    setContextWindow('200000');
    setMaxOutputTokens('8192');
  }, [isOpen]);

  // ESC to close. Bound at document level so it works while focus is
  // inside an input.
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
  if (typeof document === 'undefined') return null;

  const trimmedName = name.trim();
  const trimmedBaseUrl = baseUrl.trim();
  const trimmedModel = model.trim();
  const isValid = !!(trimmedName && trimmedBaseUrl && trimmedModel);

  const handleSave = () => {
    if (!isValid) return;
    const ctx = Number.parseInt(contextWindow, 10);
    const out = Number.parseInt(maxOutputTokens, 10);
    onSave({
      name: trimmedName,
      nickname: nickname.trim() || trimmedName,
      providerType,
      baseUrl: trimmedBaseUrl.replace(/\/$/, ''),
      apiKey: apiKey.trim(),
      initialModelKey: trimmedModel,
      contextWindow: Number.isFinite(ctx) && ctx > 0 ? ctx : 200000,
      maxOutputTokens: Number.isFinite(out) && out > 0 ? out : 8192,
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[600px] max-h-[calc(100vh-32px)] overflow-y-auto scrollbar-thin"
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
              Add provider
            </p>
            <p className="mt-0.5 truncate text-[11px] text-text-secondary">
              Endpoint, auth, and defaults. Per-model capabilities are set on each model.
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
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <FieldLabel className="mb-1">Name *</FieldLabel>
                  <IdeTextInput
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="My OpenRouter"
                    autoFocus
                  />
                </div>
                <div>
                  <FieldLabel className="mb-1">Selector name</FieldLabel>
                  <IdeTextInput
                    value={nickname}
                    onChange={(event) => setNickname(event.target.value)}
                    placeholder={name || 'OpenRouter'}
                  />
                </div>
              </div>
            </FormBlock>
            <FormBlock divided={false}>
              <FieldLabel className="mb-1">API format *</FieldLabel>
              <IdeSelect
                ariaLabel="Select provider API format"
                options={[
                  { label: 'OpenAI compatible', value: 'openai' },
                  { label: 'Anthropic compatible', value: 'anthropic' },
                  { label: 'Custom (OpenAI-like)', value: 'custom' },
                ]}
                onChange={(next) => setProviderType(String(next) as typeof providerType)}
                value={providerType}
              />
            </FormBlock>
          </Section>

          <Section
            title="Connection"
            description="Where Aurora will route requests for this provider."
            badge={
              <StatusPill variant="neutral" dot={false}>
                <Globe className="h-2.5 w-2.5" />
                {providerType === 'anthropic' ? 'Anthropic' : 'OpenAI-compat'}
              </StatusPill>
            }
          >
            <FormBlock>
              <FieldLabel className="mb-1">Base URL *</FieldLabel>
              <IdeTextInput
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={
                  providerType === 'anthropic'
                    ? 'https://api.anthropic.com'
                    : 'https://api.openrouter.ai/v1'
                }
                style={{ fontFamily: 'monospace' }}
              />
            </FormBlock>
            <FormBlock divided={false}>
              <FieldLabel className="mb-1">API key</FieldLabel>
              <div className="flex gap-1.5">
                <div className="flex-1">
                  <IdeTextInput
                    type={showApiKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="sk-…  (leave blank for local servers)"
                    style={{ fontFamily: 'monospace' }}
                  />
                </div>
                <IconButton
                  ariaLabel={showApiKey ? 'Hide key' : 'Show key'}
                  onClick={() => setShowApiKey(!showApiKey)}
                >
                  {showApiKey ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                </IconButton>
              </div>
            </FormBlock>
          </Section>

          <Section
            title="First model"
            description="A provider needs at least one model. Capabilities (vision, thinking) are configured on the model after creation."
            badge={
              <StatusPill variant="info" dot={false}>
                <Server className="h-2.5 w-2.5" />
                Required
              </StatusPill>
            }
          >
            <FormBlock>
              <FieldLabel className="mb-1">Model ID *</FieldLabel>
              <IdeTextInput
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="gpt-4o-mini, llama3.2:70b, accounts/.../qwen3-coder"
                style={{ fontFamily: 'monospace' }}
              />
            </FormBlock>
            <FormBlock divided={false}>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <FieldLabel className="mb-1">Default context window</FieldLabel>
                  <IdeTextInput
                    type="number"
                    value={contextWindow}
                    onChange={(event) => setContextWindow(event.target.value)}
                    style={{ fontFamily: 'monospace' }}
                  />
                </div>
                <div>
                  <FieldLabel className="mb-1">Default max output</FieldLabel>
                  <IdeTextInput
                    type="number"
                    value={maxOutputTokens}
                    onChange={(event) => setMaxOutputTokens(event.target.value)}
                    style={{ fontFamily: 'monospace' }}
                  />
                </div>
              </div>
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
            Add provider
          </ActionButton>
        </div>
      </div>
    </div>,
    document.body,
  );
};
