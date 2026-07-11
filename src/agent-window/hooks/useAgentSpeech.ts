/**
 * Agent Window — speech capture hook.
 *
 * Wraps the SAME local speech pipeline the IDE chat uses (`speechService` →
 * Qwen3-ASR via candle), minus the IDE-only chrome (Tailwind button, settings
 * modal, ConfirmDialog). It records mic audio, resamples to 16 kHz mono PCM,
 * sends it to the Rust transcriber, and hands the transcript back to the caller
 * (the composer inserts it at the caret).
 *
 * Speech settings come from the shared `useSettingsStore` (the agent window and
 * the IDE read the same provider/speech config), so anything configured in the
 * IDE's Speech settings "just works" here too.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { isAuroraRuntimeAvailable } from "../../lib/runtime";
import { speechService } from "../../services/speech";
import { useSettingsStore } from "../../store/useSettingsStore";

const TARGET_SAMPLE_RATE = 16_000;

/** How long a mic notice (warning/error) stays before it auto-dismisses. */
const MIC_NOTICE_TTL_MS = 5_000;

/**
 * "The user granted mic access through our own in-app modal" — persisted per
 * installation in `localStorage`. Shared with the IDE's SpeechInputButton (both
 * surfaces run under the same app origin), so allowing once anywhere means we
 * never surprise the user with a prompt again.
 */
const MIC_PERMISSION_KEY = "aurora.speech.permissionGranted";

const readMicPermissionRemembered = (): boolean => {
  try {
    return localStorage.getItem(MIC_PERMISSION_KEY) === "true";
  } catch {
    return false;
  }
};

const writeMicPermissionRemembered = (granted: boolean): void => {
  try {
    if (granted) localStorage.setItem(MIC_PERMISSION_KEY, "true");
    else localStorage.removeItem(MIC_PERMISSION_KEY);
  } catch {
    // Some embeddings disable storage — the modal simply keeps asking. Fine.
  }
};

/**
 * The native WebView mic auto-grant handler only needs installing once per app
 * session; this module-scope guard stops us re-invoking it on every composer
 * mount.
 */
let nativeHandlerRequested = false;

function mergeChunks(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return merged;
}

function resampleLinear(samples: Float32Array, src: number, dst: number): Float32Array {
  if (src === dst) return samples;
  const ratio = src / dst;
  const len = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(len);
  for (let i = 0; i < len; i += 1) {
    const idx = i * ratio;
    const before = Math.floor(idx);
    const after = Math.min(before + 1, samples.length - 1);
    const w = idx - before;
    out[i] = samples[before] * (1 - w) + samples[after] * w;
  }
  return out;
}

function pcmToBase64(pcm: Float32Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}


/** Severity of a transient mic notice — drives colour + tone, not behaviour. */
export type MicNoticeSeverity = "warning" | "error";

export interface MicNotice {
  /** Message shown under the composer (and as the mic-button tooltip). */
  text: string;
  /** `warning` → soft yellow, `error` → red. Both auto-dismiss after ~5s. */
  severity: MicNoticeSeverity;
}

export interface AgentSpeech {
  speechEnabled: boolean;
  isRecording: boolean;
  isTranscribing: boolean;
  /** Transient mic notice (auto-dismisses ~5s); `null` when nothing to show. */
  notice: MicNotice | null;
  /** Toggle record ↔ stop+transcribe (opens the consent modal on first use). */
  toggle: () => void;
  /** The recording visualizer element (the shimmer bar) — mount only while
   *  recording; the hook feeds it a `--level` from the live mic input. */
  visualizerRef: RefObject<HTMLDivElement>;
  /** True while the in-app microphone-consent modal is showing. */
  permissionOpen: boolean;
  /** User allowed access via the modal — optionally remember and start. */
  confirmPermission: (remember: boolean) => void;
  /** User dismissed the modal without granting. */
  dismissPermission: () => void;
}

export function useAgentSpeech(onTranscript: (text: string) => void): AgentSpeech {
  const {
    speechBackend,
    speechDevicePreference,
    speechEnabled,
    speechEngine,
    speechLanguage,
    speechModelPath,
    speechRuntimePath,
    speechThreads,
    setSpeechDevicePreference,
  } = useSettingsStore();

  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [notice, setNotice] = useState<MicNotice | null>(null);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const noticeTimerRef = useRef<number | null>(null);

  // Clear any showing notice + cancel its pending auto-dismiss.
  const clearNotice = useCallback(() => {
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    setNotice(null);
  }, []);

  // Show a warning (soft yellow) or error (red) that auto-dismisses after
  // MIC_NOTICE_TTL_MS. A newer notice replaces the current one and restarts
  // the timer, so messages never pile up or linger under the composer.
  const showNotice = useCallback((text: string, severity: MicNoticeSeverity) => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    setNotice({ text, severity });
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null;
      setNotice(null);
    }, MIC_NOTICE_TTL_MS);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  // Suppress the WebView's OWN native mic prompt on the agent window (the IDE
  // main window does this at startup; the JS-created agent window would
  // otherwise fall through to it). Runs once, early — well before the user can
  // click the mic — so the in-app modal is the only prompt they ever see.
  //
  // Only consume the one-shot guard AFTER we've confirmed the runtime is up: if
  // the effect fires before the Tauri bridge is ready we must NOT mark it done,
  // or the handler would never install (the guarantee then falls to the install
  // we also run just-in-time inside `actuallyStartRecording`).
  useEffect(() => {
    if (nativeHandlerRequested) return;
    if (!isAuroraRuntimeAvailable()) return;
    nativeHandlerRequested = true;
    void speechService.ensureMicPermissionHandler().catch((err) => {
      // Best-effort: if it fails, we simply fall back to the native prompt.
      console.warn("[agent-window] mic permission handler warm-up failed:", err);
    });
  }, []);

  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  // The recording visualizer (a shimmer bar). We only feed it a smoothed 0..1
  // input level via a CSS variable — all rendering is CSS.
  const visualizerRef = useRef<HTMLDivElement>(null);
  const levelRef = useRef(0);
  const chunksRef = useRef<Float32Array[]>([]);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const cleanupAudio = useCallback(() => {
    if (animationRef.current !== null) {
      window.cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    void audioContextRef.current?.close().catch(() => {});
    analyserRef.current = null;
    audioContextRef.current = null;
    processorRef.current = null;
    sourceRef.current = null;
    streamRef.current = null;
  }, []);

  useEffect(() => cleanupAudio, [cleanupAudio]);

  // Drive the shimmer's intensity from the live mic level: compute an RMS of the
  // time-domain samples, map it to a lively 0..1, smooth it, and hand it to CSS
  // as `--level`. The shimmer sweep runs on its own; this makes it brighten and
  // swell when you actually speak.
  const updateLevel = useCallback(() => {
    animationRef.current = window.requestAnimationFrame(updateLevel);
    const analyser = analyserRef.current;
    const el = visualizerRef.current;
    if (!analyser || !el) return;

    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length); // ~0..1, mostly small for speech
    const target = Math.min(1, rms * 3.4); // amplify into a visible range
    // Asymmetric smoothing: snap up fast on a syllable, fall gently.
    const k = target > levelRef.current ? 0.4 : 0.12;
    levelRef.current += (target - levelRef.current) * k;
    el.style.setProperty("--level", levelRef.current.toFixed(3));
  }, []);

  useEffect(() => {
    if (!isRecording) return;
    if (animationRef.current === null) {
      animationRef.current = window.requestAnimationFrame(updateLevel);
    }
    return () => {
      if (animationRef.current !== null) {
        window.cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [isRecording, updateLevel]);

  const runtimeRequest = useCallback(
    (devicePreference = speechDevicePreference) => ({
      backend: speechBackend,
      devicePreference,
      engine: speechEngine,
      modelPath: speechModelPath,
      nThreads: speechThreads,
      runtimePath: speechRuntimePath,
    }),
    [speechBackend, speechDevicePreference, speechEngine, speechModelPath, speechRuntimePath, speechThreads],
  );

  const actuallyStartRecording = useCallback(async () => {
    clearNotice();
    if (!speechModelPath.trim()) {
      console.warn("[agent-window] mic: speech model path not configured (Settings → Speech)");
      showNotice("Configure Speech in the IDE's Settings first.", "warning");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      console.warn("[agent-window] mic: navigator.mediaDevices.getUserMedia is unavailable in this WebView");
      showNotice("Microphone is not available in this WebView.", "error");
      return;
    }
    try {
      // Register the WebView's mic auto-grant handler BEFORE we call
      // getUserMedia. The boot warm-up usually beats the first click, but the
      // agent window is a JS-created WebView whose handler install races the
      // click; installing here (idempotent) guarantees the permission request
      // resolves to a grant instead of silently auto-denying. A missing command
      // (older build) just falls back to the native prompt — still functional.
      if (isAuroraRuntimeAvailable()) {
        await speechService.ensureMicPermissionHandler().catch((err) => {
          console.warn("[agent-window] mic permission handler install failed:", err);
        });
      }

      let validation = await speechService.validateConfig(runtimeRequest());
      if (!validation.ready && speechDevicePreference === "gpu" && !validation.gpuAvailable) {
        setSpeechDevicePreference("auto");
        validation = await speechService.validateConfig(runtimeRequest("auto"));
      }
      if (!validation.ready) {
        console.warn("[agent-window] mic: speech config not ready:", validation.message);
        showNotice(validation.message, "warning");
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: TARGET_SAMPLE_RATE,
        },
      });
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.5;
      chunksRef.current = [];
      processor.onaudioprocess = (e) => {
        chunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        e.outputBuffer.getChannelData(0).fill(0);
      };
      source.connect(analyser);
      analyser.connect(processor);
      processor.connect(audioContext.destination);
      streamRef.current = stream;
      audioContextRef.current = audioContext;
      sourceRef.current = source;
      analyserRef.current = analyser;
      processorRef.current = processor;
      setIsRecording(true);
    } catch (err) {
      console.error("[agent-window] mic: failed to start recording:", err);
      cleanupAudio();
      // A real platform denial means our remembered "granted" flag is stale:
      // clear it so the NEXT click reopens the consent modal (and re-runs the
      // handler install) instead of silently retrying a denied getUserMedia.
      const denied =
        err instanceof DOMException &&
        (err.name === "NotAllowedError" || err.name === "SecurityError");
      if (denied) {
        writeMicPermissionRemembered(false);
        showNotice("Microphone access was blocked. Click the mic again to retry.", "error");
      } else {
        showNotice(err instanceof Error ? err.message : "Microphone access failed.", "error");
      }
    }
  }, [
    cleanupAudio,
    clearNotice,
    runtimeRequest,
    setSpeechDevicePreference,
    showNotice,
    speechDevicePreference,
    speechModelPath,
  ]);

  // Gate the first recording behind our own in-app consent modal so the user
  // is never surprised by a raw permission prompt. Once they've allowed (and
  // asked us to remember), later recordings start straight away.
  const requestStart = useCallback(() => {
    clearNotice();
    if (readMicPermissionRemembered()) {
      void actuallyStartRecording();
      return;
    }
    setPermissionOpen(true);
  }, [actuallyStartRecording, clearNotice]);

  const confirmPermission = useCallback(
    (remember: boolean) => {
      setPermissionOpen(false);
      if (remember) writeMicPermissionRemembered(true);
      void actuallyStartRecording();
    },
    [actuallyStartRecording],
  );

  const dismissPermission = useCallback(() => {
    setPermissionOpen(false);
  }, []);

  const stopRecording = useCallback(async () => {
    const sourceRate = audioContextRef.current?.sampleRate || TARGET_SAMPLE_RATE;
    const chunks = [...chunksRef.current];
    cleanupAudio();
    setIsRecording(false);

    const merged = mergeChunks(chunks);
    if (merged.length < TARGET_SAMPLE_RATE / 4) {
      showNotice("Recording was too short.", "warning");
      return;
    }
    const pcm = resampleLinear(merged, sourceRate, TARGET_SAMPLE_RATE);
    setIsTranscribing(true);
    clearNotice();
    try {
      const result = await speechService.transcribePcm({
        audioPcmBase64: pcmToBase64(pcm),
        backend: speechBackend,
        devicePreference: speechDevicePreference,
        engine: speechEngine,
        language: speechLanguage,
        modelPath: speechModelPath,
        nThreads: speechThreads,
        runtimePath: speechRuntimePath,
      });
      const text = result.transcript.trim();
      if (text) onTranscript(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // "…did not return a transcript" (silence / no speech) is expected and
      // soft — surface it as a warning. Anything else is a real failure.
      const noSpeech = /return(?:ed)? (?:a )?transcript|no speech|no transcript/i.test(message);
      showNotice(message, noSpeech ? "warning" : "error");
    } finally {
      setIsTranscribing(false);
    }
  }, [
    cleanupAudio,
    clearNotice,
    onTranscript,
    showNotice,
    speechBackend,
    speechDevicePreference,
    speechEngine,
    speechLanguage,
    speechModelPath,
    speechRuntimePath,
    speechThreads,
  ]);

  const toggle = useCallback(() => {
    if (isTranscribing) return;
    if (isRecording) void stopRecording();
    else requestStart();
  }, [isRecording, isTranscribing, requestStart, stopRecording]);

  return {
    speechEnabled,
    isRecording,
    isTranscribing,
    notice,
    toggle,
    visualizerRef,
    permissionOpen,
    confirmPermission,
    dismissPermission,
  };
}
