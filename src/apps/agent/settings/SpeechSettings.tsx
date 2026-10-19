/**
 * Agent Window — Settings · Preferences › Voice input (view).
 *
 * Speech capture lives in this window (`useAgentSpeech` → the composer mic),
 * and this is where it is set up. Built on `--agw-*` primitives; the retired
 * IDE version was Tailwind + `--aurora-*` and would read as a foreign panel.
 *
 * Rendered by `PreferencesSettings` next to the dictation-polish toggle, so
 * everything about talking to Aurora sits on one page.
 *
 * ## Two ways to dictate
 *
 * The "Transcribe" control is the fork, and it is written as a question about
 * *when words appear* rather than which program runs, because that is the part
 * the user cares about:
 *
 * - **On stop** records everything and transcribes once at the end, through
 *   CrispASR. The original behaviour.
 * - **As I speak** shows words while you talk, with a choice of model:
 *   - **Phonon-2** (default) on the same CrispASR, so it shares the runtime
 *     folder with On stop and has only its own model file. English only, so
 *     the Language row is not shown for it. It can correct a word it already
 *     showed while the sentence is still open.
 *   - **Confucius4-R2T2** on audio.cpp. The last word or two arrive when you
 *     stop, because the model will not commit to them until the next moment
 *     of audio agrees.
 *
 * Different programs keep their own paths. Language is shared, since it means
 * the same thing to every engine that reads it.
 *
 * Both check themselves against the machine (debounced) on every change, so
 * the panel states what will actually happen rather than what was typed.
 * Controls that cannot work here are not rendered at all — a disabled control
 * that silently reverts is worse than an absent one.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { speechService, type SpeechValidationResult } from "@/apps/agent/services/speech/speech";
import {
  speechStreamService,
  toStreamConfig,
  type SpeechStreamValidation,
} from "@/apps/agent/services/speech/speech-stream";
import {
  useAgentSettingsStore,
  type SpeechLiveEngine,
  type SpeechMode,
} from "@/apps/agent/store/settings/useAgentSettingsStore";
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

const MODE_OPTIONS = [
  { value: "batch" as const, label: "On stop" },
  { value: "live" as const, label: "As I speak" },
];

const LIVE_ENGINE_OPTIONS: SelectOption[] = [
  { value: "phonon", label: "Phonon-2", meta: "English · CrispASR" },
  { value: "r2t2", label: "Confucius4-R2T2", meta: "audio.cpp" },
];

/**
 * The live engine names its own backends. `gpu` is CUDA here: Vulkan exists
 * but offering a third button for it would mean explaining the difference, and
 * anyone who needs it can say so once we hear that they do.
 */
const LIVE_BACKEND_FROM_DEVICE: Record<SpeechDevice, string> = {
  auto: "auto",
  gpu: "cuda",
  cpu: "cpu",
};

function deviceFromLiveBackend(backend: string): SpeechDevice {
  if (backend === "cuda") return "gpu";
  if (backend === "cpu") return "cpu";
  return "auto";
}

export const SpeechSettings: React.FC = () => {
  const {
    setSpeechBackend,
    setSpeechDevicePreference,
    setSpeechEnabled,
    setSpeechLanguage,
    setSpeechLive,
    setSpeechMode,
    setSpeechModelPath,
    setSpeechRuntimePath,
    setSpeechThreads,
    speechBackend,
    speechDevicePreference,
    speechEnabled,
    speechEngine,
    speechLanguage,
    speechLive,
    speechMode,
    speechModelPath,
    speechRuntimePath,
    speechThreads,
  } = useAgentSettingsStore();

  const live = speechMode === "live";
  const phonon = live && speechLive.engine === "phonon";

  const [validation, setValidation] = useState<SpeechValidationResult | null>(null);
  const [liveValidation, setLiveValidation] = useState<SpeechStreamValidation | null>(null);
  const [isValidating, setIsValidating] = useState(false);

  const validateBatch = useCallback(async () => {
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

  const validateLive = useCallback(async () => {
    setIsValidating(true);
    try {
      setLiveValidation(
        await speechStreamService.validate(
          toStreamConfig(speechLive, speechLanguage, speechRuntimePath),
        ),
      );
    } catch (error) {
      setLiveValidation({
        ready: false,
        runtimeOk: false,
        modelOk: false,
        executablePath: null,
        missingLibraries: [],
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsValidating(false);
    }
  }, [speechLanguage, speechLive, speechRuntimePath]);

  const validate = live ? validateLive : validateBatch;

  const activeModelPath = phonon
    ? speechLive.phononModelPath
    : live
      ? speechLive.modelPath
      : speechModelPath;

  useEffect(() => {
    if (!speechEnabled) return;
    if (!activeModelPath) return;
    const timer = window.setTimeout(() => {
      void validate();
    }, 350);
    return () => window.clearTimeout(timer);
  }, [activeModelPath, speechEnabled, validate]);

  // A GPU preference this machine cannot honour is a lie in the UI — fall
  // back to Auto as soon as validation reports no usable GPU runtime.
  useEffect(() => {
    if (live) return;
    if (!validation || speechDevicePreference !== "gpu" || validation.gpuAvailable) return;
    setSpeechDevicePreference("auto");
  }, [live, setSpeechDevicePreference, speechDevicePreference, validation]);

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
      directory: false,
      filters: [{ extensions: ["gguf"], name: "GGUF speech models" }],
      multiple: false,
      title: "Select GGUF speech model",
    });
    if (typeof selected === "string") setSpeechModelPath(selected);
  };

  const chooseLiveRuntime = async () => {
    const selected = await open({
      directory: false,
      filters: [{ extensions: ["exe"], name: "audiocpp_cli" }],
      multiple: false,
      title: "Select audiocpp_cli",
    });
    if (typeof selected === "string") setSpeechLive({ runtimePath: selected });
  };

  const chooseLiveModel = async () => {
    const selected = await open({
      directory: false,
      filters: [{ extensions: ["gguf"], name: "GGUF speech models" }],
      multiple: false,
      title: "Select the Confucius4-R2T2 model",
    });
    if (typeof selected === "string") setSpeechLive({ modelPath: selected });
  };

  const choosePhononModel = async () => {
    const selected = await open({
      directory: false,
      filters: [{ extensions: ["gguf"], name: "GGUF speech models" }],
      multiple: false,
      title: "Select the Phonon-2 model",
    });
    if (typeof selected === "string") setSpeechLive({ phononModelPath: selected });
  };

  const chooseLiveLibrary = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select the CUDA runtime folder",
    });
    if (typeof selected === "string") setSpeechLive({ libraryPath: selected });
  };

  const statusReady = (live ? liveValidation?.ready : validation?.ready) ?? false;
  const statusMessage = live ? liveValidation?.message : validation?.message;
  const hasChecked = live ? liveValidation !== null : validation !== null;

  const resolvedBackends = useMemo(
    () => validation?.availableBackends.join(", ") || null,
    [validation],
  );

  // GPU is offered only when it can actually be picked. Until validation has
  // run we trust the stored preference so the control never flickers.
  const gpuUsable = validation ? validation.gpuAvailable : speechDevicePreference === "gpu";
  const deviceOptions = useMemo(
    () =>
      gpuUsable || live
        ? [
            { value: "auto" as const, label: "Auto" },
            { value: "gpu" as const, label: "GPU" },
            { value: "cpu" as const, label: "CPU" },
          ]
        : [
            { value: "auto" as const, label: "Auto" },
            { value: "cpu" as const, label: "CPU" },
          ],
    [gpuUsable, live],
  );

  const deviceHint = phonon
    ? "GPU keeps up with speech. On CPU it may fall behind."
    : live
    ? "Live dictation needs a GPU to keep up with speech. On CPU it will fall behind."
    : gpuUsable
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

  const idleMinutes = Math.round(speechLive.idleSeconds / 60);

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
            label="Transcribe"
            hint={
              live
                ? "Words appear while you talk. The last one or two arrive when you stop."
                : "The recording is transcribed once, after you stop."
            }
          >
            <AgwSegmented<SpeechMode>
              value={speechMode}
              ariaLabel="When words appear"
              options={MODE_OPTIONS}
              onChange={setSpeechMode}
            />
          </SettingsRow>

          {live && (
            <SettingsRow
              label="Model"
              hint={
                phonon
                  ? "English only. Can correct a word while the sentence is still open."
                  : "Many languages. The last word or two appear when you stop."
              }
            >
              <AgwSelect
                value={speechLive.engine}
                options={LIVE_ENGINE_OPTIONS}
                onChange={(engine) => setSpeechLive({ engine: engine as SpeechLiveEngine })}
                ariaLabel="Live dictation model"
                width={210}
              />
            </SettingsRow>
          )}

          {phonon ? (
            <>
              <SettingsRow
                alignTop
                label="Runtime folder"
                hint="The folder holding crispasr.exe. Shared with On stop."
              >
                <div className="agw-set-field-row">
                  <AgwTextInput
                    value={speechRuntimePath}
                    placeholder="…\\crispasr"
                    onChange={(e) => setSpeechRuntimePath(e.target.value)}
                    aria-label="CrispASR runtime folder"
                  />
                  <AgwButton icon="folder" onClick={() => void chooseRuntimePath()}>
                    Browse
                  </AgwButton>
                </div>
              </SettingsRow>

              <SettingsRow
                alignTop
                label="Model file (.gguf)"
                hint="Phonon-2. q8_0 transcribes the same as f16 at half the size."
              >
                <div className="agw-set-field-row">
                  <AgwTextInput
                    value={speechLive.phononModelPath}
                    placeholder="…\\phonon2-q8_0.gguf"
                    onChange={(e) => setSpeechLive({ phononModelPath: e.target.value })}
                    aria-label="Phonon-2 model file"
                  />
                  <AgwButton icon="folder" onClick={() => void choosePhononModel()}>
                    Browse
                  </AgwButton>
                </div>
              </SettingsRow>

              <SettingsRow
                label="Keep model loaded"
                hint={
                  speechLive.keepLoaded
                    ? "The next recording starts at once. The model stays in video memory between recordings."
                    : "Loaded on each click and released after, which takes about a second. Nothing you say in that second is lost."
                }
              >
                <AgwSwitch
                  checked={speechLive.keepLoaded}
                  onChange={(keepLoaded) => setSpeechLive({ keepLoaded })}
                  ariaLabel="Keep the live dictation model loaded"
                />
              </SettingsRow>
            </>
          ) : live ? (
            <>
              <SettingsRow
                alignTop
                label="Program"
                hint="audiocpp_cli from your own audio.cpp build. Needs a build from 2026-09-19 or later."
              >
                <div className="agw-set-field-row">
                  <AgwTextInput
                    value={speechLive.runtimePath}
                    placeholder="…\\bin\\audiocpp_cli.exe"
                    onChange={(e) => setSpeechLive({ runtimePath: e.target.value })}
                    aria-label="audio.cpp program"
                  />
                  <AgwButton icon="folder" onClick={() => void chooseLiveRuntime()}>
                    Browse
                  </AgwButton>
                </div>
              </SettingsRow>

              <SettingsRow
                alignTop
                label="Model file (.gguf)"
                hint="Confucius4-R2T2. Q8_0 or better; smaller ones are refused when loading."
              >
                <div className="agw-set-field-row">
                  <AgwTextInput
                    value={speechLive.modelPath}
                    placeholder="…\\r2t2-q8_0.gguf"
                    onChange={(e) => setSpeechLive({ modelPath: e.target.value })}
                    aria-label="Live dictation model file"
                  />
                  <AgwButton icon="folder" onClick={() => void chooseLiveModel()}>
                    Browse
                  </AgwButton>
                </div>
              </SettingsRow>

              <SettingsRow
                alignTop
                label="CUDA folder"
                hint="Only for GPU. CUDA 13 keeps its files in the toolkit's bin\\x64 folder, and the program cannot start without them."
              >
                <div className="agw-set-field-row">
                  <AgwTextInput
                    value={speechLive.libraryPath}
                    placeholder="…\\CUDA\\v13.2\\bin\\x64"
                    onChange={(e) => setSpeechLive({ libraryPath: e.target.value })}
                    aria-label="CUDA runtime folder"
                  />
                  <AgwButton icon="folder" onClick={() => void chooseLiveLibrary()}>
                    Browse
                  </AgwButton>
                </div>
              </SettingsRow>

              <SettingsRow
                label="Hold back"
                hint="Words kept back until the model is sure of them. They appear when you stop. Lower shows text sooner but risks keeping a wrong word."
              >
                <input
                  type="number"
                  className="agw-set-input"
                  style={{ width: 78, fontVariantNumeric: "tabular-nums" }}
                  min={1}
                  max={16}
                  value={speechLive.holdBack}
                  onChange={(e) => setSpeechLive({ holdBack: Number(e.target.value) })}
                  aria-label="Words held back"
                />
              </SettingsRow>

              <SettingsRow
                label="Chunk size"
                hint="How much audio the model takes at a time, in milliseconds. Lower reacts faster and is slightly less accurate."
              >
                <input
                  type="number"
                  className="agw-set-input"
                  style={{ width: 90, fontVariantNumeric: "tabular-nums" }}
                  min={80}
                  max={2000}
                  step={20}
                  value={speechLive.chunkMs}
                  onChange={(e) => setSpeechLive({ chunkMs: Number(e.target.value) })}
                  aria-label="Chunk size in milliseconds"
                />
              </SettingsRow>

              <SettingsRow
                label="Release after"
                hint="Minutes of not dictating before the model is unloaded. It holds about 2.3 GB of video memory while it waits. 0 keeps it loaded."
              >
                <input
                  type="number"
                  className="agw-set-input"
                  style={{ width: 78, fontVariantNumeric: "tabular-nums" }}
                  min={0}
                  max={1440}
                  value={idleMinutes}
                  onChange={(e) =>
                    setSpeechLive({ idleSeconds: Math.max(0, Number(e.target.value)) * 60 })
                  }
                  aria-label="Release the model after this many minutes"
                />
              </SettingsRow>
            </>
          ) : (
            <>
              <SettingsRow
                alignTop
                label="Model file (.gguf)"
                hint="A GGUF speech model file."
              >
                <div className="agw-set-field-row">
                  <AgwTextInput
                    value={speechModelPath}
                    placeholder="…\\model.gguf"
                    onChange={(e) => setSpeechModelPath(e.target.value)}
                    aria-label="Model file (.gguf)"
                  />
                  <AgwButton icon="folder" onClick={() => void chooseModelPath()}>
                    Browse
                  </AgwButton>
                </div>
              </SettingsRow>

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
              value={live ? deviceFromLiveBackend(speechLive.backend) : speechDevicePreference}
              ariaLabel="Speech device"
              options={deviceOptions}
              onChange={(device) => {
                if (live) setSpeechLive({ backend: LIVE_BACKEND_FROM_DEVICE[device] });
                else setSpeechDevicePreference(device);
              }}
            />
          </SettingsRow>

          {!phonon && (
            <SettingsRow
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
          )}

          <SettingsRow
            last={!hasChecked}
            label="Check setup"
            hint="Confirm the model and device are found and ready."
          >
            <div className="agw-set-inline-row">
              {hasChecked && (
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

          {hasChecked && (
            <SettingsBlock last>
              <p
                className="text-[12px] leading-relaxed"
                style={{
                  color: statusReady ? "var(--agw-text-subtle)" : "var(--agw-warning)",
                }}
              >
                {statusMessage}
              </p>
              {!live && validation?.deviceMessage && (
                <p
                  className="text-[12px] leading-relaxed"
                  style={{ color: "var(--agw-text-subtle)", marginTop: 4 }}
                >
                  {validation.deviceMessage}
                </p>
              )}
              {!live && resolvedBackends && (
                <p
                  className="text-[12px] leading-relaxed"
                  style={{ color: "var(--agw-text-subtle)", marginTop: 4 }}
                >
                  Available engines: {resolvedBackends}
                </p>
              )}
              {live && liveValidation?.executablePath && (
                <p
                  className="text-[12px] leading-relaxed"
                  style={{ color: "var(--agw-text-subtle)", marginTop: 4 }}
                >
                  Using {liveValidation.executablePath}
                </p>
              )}
            </SettingsBlock>
          )}
        </>
      )}
    </SettingsSection>
  );
};
