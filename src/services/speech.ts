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
};
