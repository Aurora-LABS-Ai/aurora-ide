import { auroraInvoke } from "../lib/runtime";

export type SpeechDevicePreference = "auto" | "cpu" | "gpu";

export interface SpeechRuntimeRequest {
  backend?: string;
  devicePreference?: SpeechDevicePreference;
  engine?: string;
  modelPath: string;
  nThreads?: number;
  runtimePath: string;
}

export interface SpeechValidationResult {
  availableBackends: string[];
  cudaCompiled: boolean;
  deviceMessage: string;
  effectiveDevice: "cpu" | "gpu";
  engine: string;
  gpuAvailable: boolean;
  libraryPath: string | null;
  message: string;
  modelOk: boolean;
  ready: boolean;
  runtimeOk: boolean;
}

export interface SpeechTranscriptionResult {
  backend: string;
  transcript: string;
}

export interface SpeechTranscribeRequest extends SpeechRuntimeRequest {
  audioPcmBase64: string;
  language?: string;
}

export const speechService = {
  validateConfig(request: SpeechRuntimeRequest): Promise<SpeechValidationResult> {
    return auroraInvoke<SpeechValidationResult>("speech_validate_config", {
      request,
    });
  },

  transcribePcm(request: SpeechTranscribeRequest): Promise<SpeechTranscriptionResult> {
    return auroraInvoke<SpeechTranscriptionResult>("speech_transcribe_pcm", {
      request,
    });
  },

  /**
   * Install the native WebView microphone auto-grant handler on the agent
   * window so its OS-level "…wants to use your microphone" prompt is suppressed
   * — Aurora's own in-app modal becomes the only microphone gate. No-op outside
   * the desktop runtime; safe to call repeatedly. Only meaningful in the agent
   * window (the IDE main window installs this at startup).
   */
  ensureMicPermissionHandler(): Promise<void> {
    return auroraInvoke<void>("install_agent_media_permission_handler");
  },
};
