import React from 'react';
import { SlidersHorizontal } from 'lucide-react';
import type { LocalProvider } from '../../services/local-model-detector';
import { IdeSwitch } from '../ui/IdeSwitch';
import {
  Section,
  FormBlock,
  FieldLabel,
  IdeTextInput,
} from '../modals/settings-primitives';

interface Props {
  currentProvider: LocalProvider;
  contextWindow: number;
  maxOutputTokens: number;
  thinkingEnabled: boolean;
  onContextWindowChange: (v: number) => void;
  onMaxOutputChange: (v: number) => void;
  onThinkingChange: (v: boolean) => void;
  onBlurSave: () => void;
}

export const LocalParametersCard: React.FC<Props> = ({
  contextWindow,
  maxOutputTokens,
  thinkingEnabled,
  onContextWindowChange,
  onMaxOutputChange,
  onThinkingChange,
  onBlurSave,
}) => (
  <Section
    title="Parameters"
    description="Auto-saved on change. Adjusts context window, max output tokens, and reasoning."
    icon={<SlidersHorizontal className="h-3.5 w-3.5 text-text-secondary" />}
  >
    <FormBlock divided={false} className="!py-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_auto]">
        <div>
          <div className="mb-1 flex items-center justify-between">
            <FieldLabel>Context Window</FieldLabel>
            <span className="font-mono text-[10px] text-text-disabled">
              {contextWindow.toLocaleString()}
            </span>
          </div>
          <IdeTextInput
            type="number"
            value={String(contextWindow)}
            onChange={(event) => {
              const next = parseInt(event.target.value, 10);
              if (!Number.isNaN(next) && next > 0) onContextWindowChange(next);
            }}
            onBlur={onBlurSave}
            min={1024}
            max={2097152}
            step={1024}
          />
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <FieldLabel>Max Output</FieldLabel>
            <span className="font-mono text-[10px] text-text-disabled">
              {maxOutputTokens.toLocaleString()}
            </span>
          </div>
          <IdeTextInput
            type="number"
            value={String(maxOutputTokens)}
            onChange={(event) => {
              const next = parseInt(event.target.value, 10);
              if (!Number.isNaN(next) && next > 0) onMaxOutputChange(next);
            }}
            onBlur={onBlurSave}
            min={256}
            max={131072}
            step={256}
          />
        </div>

        <div className="flex flex-col items-start gap-1.5 md:items-center">
          <FieldLabel className="whitespace-nowrap">Thinking</FieldLabel>
          <IdeSwitch
            checked={thinkingEnabled}
            onChange={onThinkingChange}
            ariaLabel="Toggle thinking mode"
            size="sm"
            variant="primary"
          />
        </div>
      </div>
    </FormBlock>
  </Section>
);
