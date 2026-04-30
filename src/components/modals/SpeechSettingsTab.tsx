import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle,
  Cpu,
  Download,
  ExternalLink,
  FolderOpen,
  Loader2,
  TriangleAlert,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';

import { speechService, type SpeechValidationResult } from '../../services/speech';
import { useSettingsStore } from '../../store/useSettingsStore';
import { IdeSelect } from '../ui/IdeSelect';
import { IdeSwitch } from '../ui/IdeSwitch';
import {
  Section,
  FormRow,
  FormRowLast,
  FormBlock,
  StatusPill,
  ActionButton,
  IconButton,
  IdeTextInput,
} from './settings-primitives';

const QWEN_MODEL_URL = 'https://huggingface.co/Qwen/Qwen3-ASR-0.6B';

const engineOptions = [
  {
    label: 'Qwen3-ASR',
    value: 'qwen3-rust',
    description: 'Native Rust safetensors engine',
  },
  {
    label: 'CrispASR GGUF',
    value: 'crispasr-gguf',
    description: 'Optional GGUF compatibility runtime',
  },
];

const crispBackendOptions = [
  { label: 'Auto', value: 'auto', description: 'Use runtime default' },
  { label: 'Qwen3 ASR', value: 'qwen3' },
  { label: 'Whisper', value: 'whisper' },
  { label: 'Parakeet', value: 'parakeet' },
  { label: 'Canary', value: 'canary' },
  { label: 'Canary CTC', value: 'canary-ctc' },
  { label: 'FastConformer CTC', value: 'fastconformer-ctc' },
  { label: 'Wav2Vec2', value: 'wav2vec2' },
];

const languageOptions = [
  { label: 'Auto', value: 'auto' },
  { label: 'English', value: 'en' },
  { label: 'Chinese', value: 'zh' },
  { label: 'Spanish', value: 'es' },
  { label: 'French', value: 'fr' },
  { label: 'German', value: 'de' },
  { label: 'Japanese', value: 'ja' },
];

const openExternal = async (url: string) => {
  try {
    const { open: openShell } = await import('@tauri-apps/plugin-shell');
    await openShell(url);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
};

export const SpeechSettingsTab: React.FC = () => {
  const {
    setSpeechBackend,
    setSpeechDevicePreference,
    setSpeechEnabled,
    setSpeechEngine,
    setSpeechLanguage,
    setSpeechModelPath,
    setSpeechRuntimePath,
    setSpeechThreads,
    speechBackend,
    speechDevicePreference,
    speechEnabled,
    speechEngine,
    speechLanguage,
    speechModelPath,
    speechRuntimePath,
    speechThreads,
  } = useSettingsStore();

  const [validation, setValidation] = useState<SpeechValidationResult | null>(null);
  const [isValidating, setIsValidating] = useState(false);

  const isQwenEngine = speechEngine !== 'crispasr-gguf';

  const validate = useCallback(async () => {
    setIsValidating(true);
    try {
      const result = await speechService.validateConfig({
        backend: speechBackend,
        devicePreference: speechDevicePreference,
        engine: speechEngine,
        modelPath: speechModelPath,
        nThreads: speechThreads,
        runtimePath: speechRuntimePath,
      });
      setValidation(result);
    } catch (error) {
      setValidation({
        availableBackends: [],
        cudaCompiled: false,
        deviceMessage: '',
        effectiveDevice: 'cpu',
        engine: speechEngine,
        gpuAvailable: false,
        libraryPath: null,
        message: error instanceof Error ? error.message : String(error),
        modelOk: false,
        ready: false,
        runtimeOk: false,
      });
    } finally {
      setIsValidating(false);
    }
  }, [
    speechBackend,
    speechDevicePreference,
    speechEngine,
    speechModelPath,
    speechRuntimePath,
    speechThreads,
  ]);

  useEffect(() => {
    if (!speechModelPath) return;
    const timer = window.setTimeout(() => {
      void validate();
    }, 350);
    return () => window.clearTimeout(timer);
  }, [
    speechBackend,
    speechDevicePreference,
    speechEngine,
    speechModelPath,
    speechRuntimePath,
    speechThreads,
    validate,
  ]);

  useEffect(() => {
    if (!validation || speechDevicePreference !== 'gpu' || validation.gpuAvailable) {
      return;
    }
    setSpeechDevicePreference('auto');
  }, [setSpeechDevicePreference, speechDevicePreference, validation]);

  const chooseRuntimePath = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Select CrispASR runtime folder',
    });
    if (typeof selected === 'string') {
      setSpeechRuntimePath(selected);
    }
  };

  const chooseModelPath = async () => {
    const selected = await open({
      directory: isQwenEngine,
      filters: isQwenEngine
        ? undefined
        : [{ extensions: ['gguf'], name: 'GGUF speech models' }],
      multiple: false,
      title: isQwenEngine ? 'Select Qwen3-ASR model folder' : 'Select GGUF speech model',
    });
    if (typeof selected === 'string') {
      setSpeechModelPath(selected);
    }
  };

  const modelLabel = isQwenEngine ? 'Model folder' : 'Model file';
  const modelHint = isQwenEngine
    ? 'Folder with config.json, tokenizer.json, and model.safetensors.'
    : 'Path to a GGUF speech model file.';
  const modelPlaceholder = isQwenEngine
    ? 'Folder with config.json, tokenizer.json, model.safetensors'
    : 'Path to a GGUF speech model';
  const statusReady = validation?.ready;

  const resolvedBackends = useMemo(() => {
    if (!validation?.availableBackends.length) return null;
    return validation.availableBackends.join(', ');
  }, [validation]);

  const deviceOptions = useMemo(() => {
    const gpuDisabled = Boolean(validation && !validation.gpuAvailable);
    const gpuDescription = validation?.cudaCompiled
      ? 'No compatible GPU runtime detected'
      : 'Requires CUDA-enabled Aurora build';

    return [
      {
        label: 'Auto',
        value: 'auto',
        description: validation?.gpuAvailable
          ? 'Use GPU when available'
          : 'Use the available local device',
      },
      {
        label: gpuDisabled ? 'GPU unavailable' : 'GPU',
        value: 'gpu',
        description: gpuDisabled ? gpuDescription : 'Require GPU acceleration',
        disabled: gpuDisabled,
        tone: gpuDisabled ? ('warning' as const) : ('default' as const),
      },
      { label: 'CPU', value: 'cpu', description: 'Use CPU' },
    ];
  }, [validation]);

  const headerBadge = isValidating ? (
    <StatusPill variant="info">Checking…</StatusPill>
  ) : speechEnabled && statusReady ? (
    <StatusPill variant="success">Ready</StatusPill>
  ) : speechEnabled ? (
    <StatusPill variant="warning">Needs setup</StatusPill>
  ) : (
    <StatusPill variant="neutral">Disabled</StatusPill>
  );

  return (
    <div className="space-y-6 pb-2">
      {/* ============================================================ */}
      {/* Speech input toggle                                          */}
      {/* ============================================================ */}
      <Section
        title="Speech Input"
        description="Local speech-to-text for the chat input. Add a model folder, pick a device, then use the microphone button in chat."
        badge={headerBadge}
      >
        <FormRowLast
          label="Enable speech input"
          hint="Show the microphone button in chat. Recordings are processed locally — no cloud upload."
        >
          <IdeSwitch
            ariaLabel="Enable speech input"
            checked={speechEnabled}
            onChange={setSpeechEnabled}
            size="sm"
            variant="primary"
          />
        </FormRowLast>
      </Section>

      {/* ============================================================ */}
      {/* Engine + model path                                          */}
      {/* ============================================================ */}
      <Section
        title="Engine & Model"
        description="Pick the speech engine and point Aurora at the model files."
      >
        <FormRow label="Engine" hint="Native Rust engine is faster; GGUF runtime is for compatibility.">
          <IdeSelect
            ariaLabel="Select speech engine"
            align="end"
            className="min-w-[200px]"
            onChange={(value) => setSpeechEngine(String(value))}
            options={engineOptions}
            value={speechEngine}
          />
        </FormRow>

        <FormRowLast label={modelLabel} hint={modelHint} align="top">
          <div className="flex w-[300px] gap-1.5">
            <IdeTextInput
              onChange={(event) => setSpeechModelPath(event.target.value)}
              placeholder={modelPlaceholder}
              value={speechModelPath}
            />
            <IconButton
              ariaLabel="Choose model"
              title={isQwenEngine ? 'Choose model folder' : 'Choose model file'}
              onClick={() => {
                void chooseModelPath();
              }}
              variant="secondary"
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        </FormRowLast>
      </Section>

      {/* ============================================================ */}
      {/* Qwen download hint OR Crisp runtime                          */}
      {/* ============================================================ */}
      {isQwenEngine ? (
        <Section
          title="Qwen3-ASR Model"
          description="Download the Hugging Face model, then select the downloaded folder above."
          badge={<StatusPill variant="info">External download</StatusPill>}
        >
          <FormBlock divided={false}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] font-medium leading-snug text-text-primary">
                  Qwen/Qwen3-ASR-0.6B
                </p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-text-secondary">
                  Around 1.2 GB. Required files: config.json, tokenizer.json, model.safetensors.
                </p>
              </div>
              <ActionButton
                variant="primary"
                icon={<Download className="h-3 w-3" />}
                onClick={() => void openExternal(QWEN_MODEL_URL)}
              >
                Open model page
                <ExternalLink className="h-3 w-3" />
              </ActionButton>
            </div>
          </FormBlock>
        </Section>
      ) : (
        <Section
          title="CrispASR Runtime"
          description="Configure the GGUF runtime and backend used for inference."
        >
          <FormRow
            label="Runtime folder"
            hint="Folder containing crispasr.exe and supporting libraries."
            align="top"
          >
            <div className="flex w-[300px] gap-1.5">
              <IdeTextInput
                onChange={(event) => setSpeechRuntimePath(event.target.value)}
                placeholder="Folder containing crispasr.exe"
                value={speechRuntimePath}
              />
              <IconButton
                ariaLabel="Choose runtime folder"
                title="Choose runtime folder"
                onClick={() => {
                  void chooseRuntimePath();
                }}
                variant="secondary"
              >
                <FolderOpen className="h-3.5 w-3.5" />
              </IconButton>
            </div>
          </FormRow>

          <FormRowLast label="Runtime backend" hint="Speech model family used by the runtime.">
            <IdeSelect
              ariaLabel="Select CrispASR backend"
              align="end"
              className="min-w-[180px]"
              onChange={(value) => setSpeechBackend(String(value))}
              options={crispBackendOptions}
              value={speechBackend}
            />
          </FormRowLast>
        </Section>
      )}

      {/* ============================================================ */}
      {/* Device, language, threads                                    */}
      {/* ============================================================ */}
      <Section
        title="Inference"
        description="Tune how Aurora runs the speech model on your machine."
      >
        <FormRow label="Device" hint="GPU accelerates transcription when supported by the runtime.">
          <IdeSelect
            ariaLabel="Select speech device"
            align="end"
            className="min-w-[180px]"
            onChange={(value) =>
              setSpeechDevicePreference(String(value) as 'auto' | 'cpu' | 'gpu')
            }
            options={deviceOptions}
            value={speechDevicePreference}
          />
        </FormRow>

        <FormRow label="Language" hint="Hint for the recognizer — Auto detects language per utterance.">
          <IdeSelect
            ariaLabel="Select speech language"
            align="end"
            className="min-w-[140px]"
            onChange={(value) => setSpeechLanguage(String(value))}
            options={languageOptions}
            value={speechLanguage}
          />
        </FormRow>

        <FormRowLast
          label="CPU threads"
          hint={
            isQwenEngine
              ? 'Native engine manages threads automatically.'
              : 'Threads used by the GGUF runtime when not using GPU.'
          }
        >
          <input
            disabled={isQwenEngine}
            max={32}
            min={1}
            onChange={(event) => setSpeechThreads(Number(event.target.value))}
            type="number"
            value={speechThreads}
            aria-label="Number of CPU threads"
            className="h-7 w-20 px-2 text-[11.5px] font-mono font-semibold text-text-primary disabled:opacity-50 focus:outline-none"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--aurora-editor-background) 65%, var(--aurora-common-secondary) 35%)',
              border: '1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)',
              borderRadius: 6,
            }}
          />
        </FormRowLast>
      </Section>

      {/* ============================================================ */}
      {/* Validation                                                   */}
      {/* ============================================================ */}
      <Section
        title="Diagnostics"
        description="Verify the runtime, model, and device configuration end-to-end."
        badge={
          isValidating ? (
            <StatusPill variant="info" dot={false}>
              Checking…
            </StatusPill>
          ) : statusReady ? (
            <StatusPill variant="success">Ready</StatusPill>
          ) : (
            <StatusPill variant="warning">Not ready</StatusPill>
          )
        }
      >
        <FormBlock divided={false}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5 shrink-0">
                {isValidating ? (
                  <Loader2 className="h-4 w-4 animate-spin text-text-secondary" />
                ) : statusReady ? (
                  <CheckCircle className="h-4 w-4 text-success" />
                ) : (
                  <TriangleAlert className="h-4 w-4 text-warning" />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-[12.5px] font-medium leading-snug text-text-primary">
                  {validation?.message || 'Select a model path to enable speech input.'}
                </p>
                {validation?.deviceMessage && (
                  <p className="mt-1 text-[11.5px] leading-relaxed text-text-secondary">
                    {validation.deviceMessage}
                  </p>
                )}
                {resolvedBackends && (
                  <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-disabled">
                    Engine: <span className="font-mono normal-case tracking-normal text-text-secondary">{resolvedBackends}</span>
                  </p>
                )}
              </div>
            </div>
            <ActionButton
              variant="primary"
              icon={isValidating ? undefined : <Cpu className="h-3 w-3" />}
              loading={isValidating}
              disabled={isValidating}
              onClick={() => void validate()}
            >
              Validate
            </ActionButton>
          </div>
        </FormBlock>
      </Section>

    </div>
  );
};
