/**
 * Agent Window — Settings · Preferences › Voice input (view).
 *
 * Speech capture already lives in this window (`useAgentSpeech` → the composer
 * mic), but its configuration only existed in the IDE's settings modal. With
 * the IDE agent retired that would have left a working feature with no way to
 * set it up, so this is that surface rebuilt on `--agw-*` primitives — the IDE
 * version is Tailwind + `--aurora-*` and would read as a foreign panel here.
 *
 * Rendered by `PreferencesSettings` next to the dictation-polish toggle, so
 * everything about talking to Aurora sits on one page.
 *
 * Two engines need different things:
 *   qwen3-rust    → a model FOLDER (config.json, tokenizer.json, safetensors)
 *   crispasr-gguf → a runtime folder + a .gguf model FILE + a model family
 *
 * `speechService.validateConfig` re-checks against the machine (debounced) on
 * every change, so the panel states what will actually happen rather than what
 * was typed. Controls that cannot work on this machine are not rendered at all
 * — a disabled control that silently reverts is worse than an absent one.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { speechService, type SpeechValidationResult } from "@/apps/agent/services/speech/speech";
import { useSettingsStore } from "@/kernel/store/useSettingsStore";
import {
  AgwButton,
  AgwPill,
  AgwSegmented,
  AgwSelect,
  AgwSwitch,
  AgwTextInput,
  SettingsBlock,
  SettingsRow,
  SettingsSection,
  type SelectOption,
} from "./primitives";

const QWEN_MODEL_URL = "https://huggingface.co/Qwen/Qwen3-ASR-0.6B";

type SpeechDevice = "auto" | "cpu" | "gpu";

const BACKEND_OPTIONS: SelectOption[] = [
  { value: "auto", label: "Auto", meta: "runtime default" },
  { value: "qwen3", label: "Qwen3 ASR" },
  { value: "whisper", label: "Whisper" },
  { value: "parakeet", label: "Parakeet" },
  { value: "canary", label: "Canary" },
  { value: "canary-ctc", label: "Canary CTC" },
  { value: "fastconformer-ctc", label: "FastConformer CTC" },
  { value: "wav2vec2", label: "Wav2Vec2" },
];

const LANGUAGE_OPTIONS: SelectOption[] = [
  { value: "auto", label: "Auto", meta: "detect per phrase" },
  { value: "en", label: "English" },
  { value: "zh", label: "Chinese" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "ja", label: "Japanese" },
];

const openExternal = async (url: string) => {
  try {
    const { open: openShell } = await import("@tauri-apps/plugin-shell");
    await openShell(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
};

export const SpeechSettings: React.FC = () => {
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

  const isQwenEngine = speechEngine !== "crispasr-gguf";

  const validate = useCallback(async () => {
    setIsValidating(true);
    try {
      setValidation(
        await speechService.validateConfig({
          backend: speechBackend,
          devicePreference: speechDevicePreference,
          engine: speechEngine,
          modelPath: speechModelPath,
          nThreads: speechThreads,
          runtimePath: speechRuntimePath,
        }),
      );
    } catch (error) {
      setValidation({
        availableBackends: [],
        cudaCompiled: false,
        deviceMessage: "",
        effectiveDevice: "cpu",
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
    if (!speechEnabled || !speechModelPath) return;
    const timer = window.setTimeout(() => {
      void validate();
    }, 350);
    return () => window.clearTimeout(timer);
  }, [speechEnabled, speechModelPath, validate]);

  // A GPU preference this machine cannot honour is a lie in the UI — fall
  // back to Auto as soon as validation reports no usable GPU runtime.
  useEffect(() => {
    if (!validation || speechDevicePreference !== "gpu" || validation.gpuAvailable) return;
    setSpeechDevicePreference("auto");
  }, [setSpeechDevicePreference, speechDevicePreference, validation]);

  const chooseRuntimePath = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select CrispASR runtime folder",
    });
    if (typeof selected === "string") setSpeechRuntimePath(selected);
  };

  const chooseModelPath = async () => {
    const selected = await open({
      directory: isQwenEngine,
      filters: isQwenEngine ? undefined : [{ extensions: ["gguf"], name: "GGUF speech models" }],
      multiple: false,
      title: isQwenEngine ? "Select Qwen3-ASR model folder" : "Select GGUF speech model",
    });
    if (typeof selected === "string") setSpeechModelPath(selected);
  };

  const statusReady = validation?.ready ?? false;
  const resolvedBackends = useMemo(
    () => validation?.availableBackends.join(", ") || null,
    [validation],
  );

  // GPU is offered only when it can actually be picked. Until validation has
  // run we trust the stored preference so the control never flickers.
  const gpuUsable = validation ? validation.gpuAvailable : speechDevicePreference === "gpu";
  const deviceOptions = useMemo(
    () =>
      gpuUsable
        ? [
            { value: "auto" as const, label: "Auto" },
            { value: "gpu" as const, label: "GPU" },
            { value: "cpu" as const, label: "CPU" },
          ]
        : [
            { value: "auto" as const, label: "Auto" },
            { value: "cpu" as const, label: "CPU" },
          ],
    [gpuUsable],
  );

  const deviceHint = gpuUsable
    ? "GPU speeds up transcription when the runtime supports it."
    : validation?.cudaCompiled
      ? "No compatible GPU was detected on this machine, so only CPU is offered."
      : "This Aurora build is CPU-only — a CUDA build is needed before GPU can be offered.";

  const badge = !speechEnabled ? null : isValidating ? (
    <AgwPill tone="info" dot={false}>
      Checking…
    </AgwPill>
  ) : statusReady ? (
    <AgwPill tone="success">Ready</AgwPill>
  ) : (
    <AgwPill tone="warning">Needs setup</AgwPill>
  );

  const modelLabel = isQwenEngine ? "Model folder" : "Model file (.gguf)";

  return (
    <SettingsSection
      icon="mic"
      title="Voice input"
      description="Dictate into the composer instead of typing. Audio is transcribed on this machine — nothing is uploaded."
      badge={badge}
    >
      <SettingsRow
        last={!speechEnabled}
        label="Enable voice input"
        hint="Shows the microphone button in the message box."
      >
        <AgwSwitch
          checked={speechEnabled}
          onChange={setSpeechEnabled}
          ariaLabel="Enable voice input"
        />
      </SettingsRow>

      {speechEnabled && (
        <>
          <SettingsRow
            label="Engine"
            hint="Qwen3-ASR is the built-in Rust engine. CrispASR GGUF is a compatibility runtime for other model families."
          >
            <AgwSegmented
              value={isQwenEngine ? "qwen3-rust" : "crispasr-gguf"}
              ariaLabel="Speech engine"
              options={[
                { value: "qwen3-rust", label: "Qwen3-ASR" },
                { value: "crispasr-gguf", label: "CrispASR GGUF" },
              ]}
              onChange={setSpeechEngine}
            />
          </SettingsRow>

          <SettingsRow
            alignTop
            label={modelLabel}
            hint={
              isQwenEngine
                ? "The downloaded folder holding config.json, tokenizer.json and model.safetensors."
                : "A GGUF speech model file."
            }
          >
            <div className="agw-set-field-row">
              <AgwTextInput
                value={speechModelPath}
                placeholder={isQwenEngine ? "…\\Qwen3-ASR-0.6B" : "…\\model.gguf"}
                onChange={(e) => setSpeechModelPath(e.target.value)}
                aria-label={modelLabel}
              />
              <AgwButton icon="folder" onClick={() => void chooseModelPath()}>
                Browse
              </AgwButton>
            </div>
          </SettingsRow>

          {isQwenEngine ? (
            <SettingsRow
              label="Get the model"
              hint="About 1.2 GB. Download it once, then point the field above at the folder."
            >
              <AgwButton icon="download" onClick={() => void openExternal(QWEN_MODEL_URL)}>
                Qwen3-ASR-0.6B
              </AgwButton>
            </SettingsRow>
          ) : (
            <>
              <SettingsRow
                alignTop
                label="Runtime folder"
                hint="The folder holding crispasr.exe and its libraries."
              >
                <div className="agw-set-field-row">
                  <AgwTextInput
                    value={speechRuntimePath}
                    placeholder="…\\crispasr"
                    onChange={(e) => setSpeechRuntimePath(e.target.value)}
                    aria-label="Runtime folder"
                  />
                  <AgwButton icon="folder" onClick={() => void chooseRuntimePath()}>
                    Browse
                  </AgwButton>
                </div>
              </SettingsRow>

              <SettingsRow
                label="Model family"
                hint="Must match the model file above. Auto lets the runtime decide."
              >
                <AgwSelect
                  value={speechBackend}
                  options={BACKEND_OPTIONS}
                  onChange={setSpeechBackend}
                  ariaLabel="Runtime model family"
                  width={210}
                />
              </SettingsRow>

              <SettingsRow
                label="CPU threads"
                hint="Threads the runtime may use when transcribing on CPU."
              >
                <input
                  type="number"
                  className="agw-set-input"
                  style={{ width: 78, fontVariantNumeric: "tabular-nums" }}
                  min={1}
                  max={32}
                  value={speechThreads}
                  onChange={(e) => setSpeechThreads(Number(e.target.value))}
                  aria-label="CPU threads"
                />
              </SettingsRow>
            </>
          )}

          <SettingsRow label="Device" hint={deviceHint}>
            <AgwSegmented<SpeechDevice>
              value={speechDevicePreference}
              ariaLabel="Speech device"
              options={deviceOptions}
              onChange={setSpeechDevicePreference}
            />
          </SettingsRow>

          <SettingsRow
            last={!validation}
            label="Language"
            hint="A hint for the recognizer. Auto detects the language of each phrase."
          >
            <AgwSelect
              value={speechLanguage}
              options={LANGUAGE_OPTIONS}
              onChange={setSpeechLanguage}
              ariaLabel="Speech language"
              width={210}
            />
          </SettingsRow>

          <SettingsRow
            last={!validation}
            label="Check setup"
            hint="Confirm the model and device are found and ready."
          >
            <div className="agw-set-inline-row">
              {validation && (
                <AgwPill tone={statusReady ? "success" : "warning"}>
                  {statusReady ? "Ready" : "Not ready"}
                </AgwPill>
              )}
              <AgwButton
                variant="primary"
                icon="check"
                disabled={isValidating}
                onClick={() => void validate()}
              >
                {isValidating ? "Checking…" : "Validate"}
              </AgwButton>
            </div>
          </SettingsRow>

          {validation && (
            <SettingsBlock last>
              <p
                className="text-[12px] leading-relaxed"
                style={{
                  color: statusReady ? "var(--agw-text-subtle)" : "var(--agw-warning)",
                }}
              >
                {validation.message}
              </p>
              {validation.deviceMessage && (
                <p
                  className="text-[12px] leading-relaxed"
                  style={{ color: "var(--agw-text-subtle)", marginTop: 4 }}
                >
                  {validation.deviceMessage}
                </p>
              )}
              {resolvedBackends && (
                <p
                  className="text-[12px] leading-relaxed"
                  style={{ color: "var(--agw-text-subtle)", marginTop: 4 }}
                >
                  Available engines: {resolvedBackends}
                </p>
              )}
            </SettingsBlock>
          )}
        </>
      )}
    </SettingsSection>
  );
};
