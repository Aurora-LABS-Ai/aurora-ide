import React from 'react';
import { CheckCircle2, Globe, Loader2, Wifi } from 'lucide-react';
import type { LocalProvider } from '../../services/local-model-detector';
import {
  Section,
  FormBlock,
  ActionButton,
  IdeTextInput,
} from '../modals/settings-primitives';

interface Props {
  customUrl: string;
  onUrlChange: (v: string) => void;
  customProbing: boolean;
  customResult: LocalProvider | null;
  customError: string | null;
  onErrorClear: () => void;
  onProbe: () => void;
}

export const LocalCustomServerCard: React.FC<Props> = ({
  customUrl,
  onUrlChange,
  customProbing,
  customResult,
  customError,
  onErrorClear,
  onProbe,
}) => (
  <Section
    title="Custom Server"
    description="Connect to Ollama or LM Studio on another machine, Docker, WSL, or a custom port."
    icon={<Globe className="h-3.5 w-3.5 text-text-secondary" />}
  >
    <FormBlock>
      <div className="flex gap-1.5">
        <div className="flex-1">
          <IdeTextInput
            type="text"
            value={customUrl}
            onChange={(event) => {
              onUrlChange(event.target.value);
              onErrorClear();
            }}
            placeholder="http://192.168.1.100:11434"
            onKeyDown={(event) => {
              if (event.key === 'Enter') onProbe();
            }}
          />
        </div>
        <ActionButton
          variant="primary"
          icon={
            customProbing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Wifi className="h-3 w-3" />
            )
          }
          disabled={!customUrl.trim() || customProbing}
          onClick={onProbe}
        >
          {customProbing ? 'Probing…' : 'Probe'}
        </ActionButton>
      </div>

      {customError && (
        <p
          className="mt-2 text-[11px]"
          style={{ color: 'var(--aurora-common-danger)' }}
        >
          {customError}
        </p>
      )}

      {customResult && !customError && (
        <p
          className="mt-2 inline-flex items-center gap-1 text-[11px]"
          style={{ color: 'var(--aurora-common-success)' }}
        >
          <CheckCircle2 className="h-3 w-3" />
          Found {customResult.name} with {customResult.models.length} model
          {customResult.models.length === 1 ? '' : 's'}
        </p>
      )}
    </FormBlock>
  </Section>
);
