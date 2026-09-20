/**
 * Agent Window — speech capture hook.
 *
 * Wraps the SAME local speech pipeline the IDE chat uses (`speechService` →
 * CrispASR child process), minus the IDE-only chrome (Tailwind button, settings
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

import { isAuroraRuntimeAvailable } from "@/kernel/lib/ipc/runtime";
import { speechService } from "@/apps/agent/services/speech/speech";
import {
  SpeechStreamSession,
  toStreamConfig,
} from "@/apps/agent/services/speech/speech-stream";
import { useSettingsStore } from "@/kernel/store/useSettingsStore";
import { runDictationCleanup } from "@/apps/agent/adapters/prompt-refine";
import {
  dictationCleanupReady,
  refineConfig,
  useAgentRefineStore,
} from "@/apps/agent/store/composer/useAgentRefineStore";

const TARGET_SAMPLE_RATE = 16_000;

/** Longest we let the local cleanup model hold up transcript insertion. */
const DICTATION_CLEANUP_TIMEOUT_MS = 6_000;

/**
 * Optional pass over a fresh transcript: the local prompt-refine model adds
 * punctuation/casing and strips filler words. Runs inside the existing
 * "transcribing" spinner window; ANY failure (off, unconfigured, slow, model
 * error) falls back to the raw transcript — dictation never breaks.
 */
async function polishTranscript(text: string): Promise<string> {
  const refine = useAgentRefineStore.getState();
  if (!dictationCleanupReady(refine)) return text;
  try {
    const cleaned = await Promise.race([
      runDictationCleanup(`dictation_${Date.now()}`, text, refineConfig(refine)),
      new Promise<string>((_, reject) =>
        window.setTimeout(
          () => reject(new Error("dictation cleanup timed out")),
          DICTATION_CLEANUP_TIMEOUT_MS,
        ),
      ),
    ]);
    return cleaned.trim() || text;
  } catch (err) {
    console.warn("[agent-window] dictation cleanup skipped:", err);
    return text;
  }
}

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
  /**
   * Live dictation is loading its model. Only ever true for the first
   * recording after a cold start or an idle release — about 3.5 seconds. The
   * mic button shows it so the wait is explained rather than felt as a hang.
   */
  isLoadingModel: boolean;
  /** Transient mic notice (auto-dismisses ~5s); `null` when nothing to show. */
  notice: MicNotice | null;
  /** Toggle record ↔ stop+transcribe (opens the consent modal on first use). */
  toggle: () => void;
  /** Smoothed 0..1 speech level, updated every animation frame while
   *  recording. Read it from a render loop — it is deliberately a ref, so a
   *  new level never re-renders the composer. */
  levelRef: RefObject<number>;
  /** True while the in-app microphone-consent modal is showing. */
  permissionOpen: boolean;
  /** User allowed access via the modal — optionally remember and start. */
  confirmPermission: (remember: boolean) => void;
  /** User dismissed the modal without granting. */
  dismissPermission: () => void;
}

/**
 * @param onTranscript Insert a finished transcript at the caret. Used by the
 *   record-then-transcribe path, and as a fallback when `onWords` is absent.
 * @param onWords Append text exactly as given, no spacing added. Live
 *   dictation arrives in pieces that already carry their own spacing.
 */
export function useAgentSpeech(
  onTranscript: (text: string) => void,
  onWords?: (text: string) => void,
): AgentSpeech {
  const {
    speechBackend,
    speechDevicePreference,
    speechEnabled,
    speechEngine,
    speechLanguage,
    speechModelPath,
    speechRuntimePath,
    speechThreads,
    speechMode,
    speechLive,
    setSpeechDevicePreference,
  } = useSettingsStore();
  const live = speechMode === "live";

  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isLoadingModel, setIsLoadingModel] = useState(false);
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
  // Smoothed 0..1 speech level, published as a ref rather than written onto an
  // element. It used to be set as a `--level` CSS variable on a shimmer bar,
  // because that bar was rendered entirely in CSS. The visualiser is a canvas
  // now (`ComposerAurora`), which needs the NUMBER each frame — reading it back
  // out of a CSS custom property would mean a `getComputedStyle` per frame.
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

  // Measure the live mic level: RMS of the time-domain samples, amplified into
  // a range that actually moves, then smoothed. `ComposerAurora` reads the
  // result every frame to decide how far the curtain reaches.
  const updateLevel = useCallback(() => {
    animationRef.current = window.requestAnimationFrame(updateLevel);
    const analyser = analyserRef.current;
    if (!analyser) return;

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

  // ---- live dictation -----------------------------------------------------
  //
  // The program exits when a recording ends, so "kept warm" means: as soon as
  // one recording finishes, a fresh one is started and left waiting with the
  // model already loaded. Only the first recording after a cold start or an
  // idle release pays the ~3.5s load.

  /** Armed and waiting, or currently recording. */
  const liveRef = useRef<SpeechStreamSession | null>(null);
  /** The waiting program has finished loading and can hear. */
  const liveReadyRef = useRef(false);
  /** Resolved by the ready event, so a click can wait for the model. */
  const liveReadyWaiters = useRef<Array<() => void>>([]);
  /** Everything this recording has put into the composer so far. */
  const liveInsertedRef = useRef("");
  const idleTimerRef = useRef<number | null>(null);
  /** Latest settings, read inside callbacks that must not re-create per key. */
  const liveConfigRef = useRef({ speechLive, speechLanguage });
  liveConfigRef.current = { speechLive, speechLanguage };

  const appendWords = useCallback(
    (text: string) => {
      if (!text) return;
      liveInsertedRef.current += text;
      // Verbatim: the model's pieces already carry their own spacing, and the
      // caret-insert helper would add another space before ones like " and".
      (onWords ?? onTranscript)(text);
    },
    [onTranscript, onWords],
  );

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  /** Let go of the loaded model. It holds about 2.3 GB of video memory. */
  const releaseLive = useCallback(async () => {
    clearIdleTimer();
    const session = liveRef.current;
    liveRef.current = null;
    liveReadyRef.current = false;
    liveReadyWaiters.current = [];
    if (session) await session.cancel();
  }, [clearIdleTimer]);

  const startIdleTimer = useCallback(() => {
    clearIdleTimer();
    const seconds = liveConfigRef.current.speechLive.idleSeconds;
    if (seconds <= 0) return; // 0 means keep it loaded
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      void releaseLive();
    }, seconds * 1000);
  }, [clearIdleTimer, releaseLive]);

  /**
   * Start a program and leave it waiting with the model loaded. Safe to call
   * when one is already waiting: it does nothing.
   */
  const armLive = useCallback(async (): Promise<void> => {
    if (liveRef.current) return;
    const { speechLive: cfg, speechLanguage: lang } = liveConfigRef.current;
    liveReadyRef.current = false;
    const session = await SpeechStreamSession.arm(toStreamConfig(cfg, lang), {
      onReady: () => {
        liveReadyRef.current = true;
        const waiters = liveReadyWaiters.current;
        liveReadyWaiters.current = [];
        waiters.forEach((resolve) => resolve());
      },
      onWords: appendWords,
      onFinal: (text) => {
        // The held-back words land here. Add only what is not already in the
        // composer. If the model rewrote earlier text the two will not line up,
        // and adding nothing beats duplicating a sentence.
        const already = liveInsertedRef.current;
        if (text.startsWith(already)) appendWords(text.slice(already.length));
        else if (!already) appendWords(text);
        liveInsertedRef.current = "";
        setIsTranscribing(false);
        // That program has exited. Load the next one now so the following
        // click is instant, and start counting down to releasing it.
        liveRef.current = null;
        liveReadyRef.current = false;
        void armLive().then(startIdleTimer);
      },
      onError: (message) => {
        showNotice(message, "error");
        setIsTranscribing(false);
      },
    });
    liveRef.current = session;
  }, [appendWords, showNotice, startIdleTimer]);

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

  /**
   * Open the microphone and hand every captured block to `onBlock`.
   *
   * Shared by both paths: recording the audio is identical, only what happens
   * to each block differs — buffered for one transcription at the end, or sent
   * straight out as it arrives.
   */
  const openMicrophone = useCallback(
    async (onBlock: (samples: Float32Array, sampleRate: number) => void): Promise<boolean> => {
      if (!navigator.mediaDevices?.getUserMedia) {
        console.warn("[agent-window] mic: getUserMedia is unavailable in this WebView");
        showNotice("Microphone is not available in this WebView.", "error");
        return false;
      }
      try {
        // Register the WebView's mic auto-grant handler BEFORE we call
        // getUserMedia. The boot warm-up usually beats the first click, but the
        // agent window is a JS-created WebView whose handler install races the
        // click; installing here (idempotent) guarantees the permission request
        // resolves to a grant instead of silently auto-denying. A missing
        // command (older build) falls back to the native prompt — still works.
        if (isAuroraRuntimeAvailable()) {
          await speechService.ensureMicPermissionHandler().catch((err) => {
            console.warn("[agent-window] mic permission handler install failed:", err);
          });
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
        processor.onaudioprocess = (e) => {
          onBlock(new Float32Array(e.inputBuffer.getChannelData(0)), audioContext.sampleRate);
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
        return true;
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
        return false;
      }
    },
    [cleanupAudio, showNotice],
  );

  /** Start a recording whose words appear as they are spoken. */
  const startLiveRecording = useCallback(async () => {
    const { speechLive: cfg } = liveConfigRef.current;
    if (!cfg.runtimePath.trim() || !cfg.modelPath.trim()) {
      showNotice("Set up live dictation in Preferences → Voice input first.", "warning");
      return;
    }

    clearIdleTimer();
    liveInsertedRef.current = "";

    try {
      if (!liveRef.current) await armLive();
      // Only the first recording after a cold start waits here. The button
      // says so rather than looking stuck.
      if (!liveReadyRef.current) {
        setIsLoadingModel(true);
        await new Promise<void>((resolve) => liveReadyWaiters.current.push(resolve));
      }
    } catch (err) {
      showNotice(
        err instanceof Error ? err.message : "Could not start live dictation.",
        "error",
      );
      return;
    } finally {
      setIsLoadingModel(false);
    }

    const session = liveRef.current;
    if (!session) return;

    const opened = await openMicrophone((samples, sampleRate) => {
      // The model wants 16 kHz. Most inputs capture at 44.1 or 48, so each
      // block is converted on the way past rather than all at once at the end.
      const pcm = resampleLinear(samples, sampleRate, TARGET_SAMPLE_RATE);
      void session.write(pcm).catch((err) => {
        console.warn("[agent-window] live dictation: dropped a block:", err);
      });
    });
    if (!opened) {
      // The microphone never opened, so the loaded program has nothing to do.
      // Leave it warm and start the countdown rather than wasting the load.
      startIdleTimer();
    }
  }, [armLive, clearIdleTimer, openMicrophone, showNotice, startIdleTimer]);

  const actuallyStartRecording = useCallback(async () => {
    clearNotice();
    if (live) {
      await startLiveRecording();
      return;
    }
    if (!speechModelPath.trim()) {
      console.warn("[agent-window] mic: speech model path not configured (Settings → Speech)");
      showNotice("Configure Speech in the IDE's Settings first.", "warning");
      return;
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

    chunksRef.current = [];
    await openMicrophone((samples) => {
      chunksRef.current.push(samples);
    });
  }, [
    clearNotice,
    live,
    openMicrophone,
    runtimeRequest,
    setSpeechDevicePreference,
    showNotice,
    speechDevicePreference,
    speechModelPath,
    startLiveRecording,
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
    if (live) {
      cleanupAudio();
      setIsRecording(false);
      const session = liveRef.current;
      if (!session) return;
      // The words it held back arrive on the final event, which also arms the
      // next program. Until then the button shows it is still finishing.
      setIsTranscribing(true);
      try {
        await session.stop();
      } catch (err) {
        setIsTranscribing(false);
        showNotice(
          err instanceof Error ? err.message : "Could not finish the recording.",
          "error",
        );
      }
      return;
    }

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
      if (text) onTranscript(await polishTranscript(text));
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
    live,
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
    if (isTranscribing || isLoadingModel) return;
    if (isRecording) void stopRecording();
    else requestStart();
  }, [isLoadingModel, isRecording, isTranscribing, requestStart, stopRecording]);

  // A loaded model is 2.3 GB of video memory and a running program. Let go of
  // it when the composer goes away, and when dictation is switched back to the
  // record-then-transcribe engine — otherwise it would sit there unused with
  // nothing left that could ever release it.
  useEffect(() => {
    if (!live || !speechEnabled) void releaseLive();
  }, [live, releaseLive, speechEnabled]);

  useEffect(() => () => void releaseLive(), [releaseLive]);

  // Closing the window tears the WebView down without necessarily running the
  // unmount above, which would leave a loaded model and a running program with
  // nothing left to stop them. `kill_on_drop` still catches it when Aurora
  // itself exits, but not when only this window goes.
  useEffect(() => {
    const onGone = () => void releaseLive();
    window.addEventListener("pagehide", onGone);
    return () => window.removeEventListener("pagehide", onGone);
  }, [releaseLive]);

  return {
    speechEnabled,
    isRecording,
    isTranscribing,
    isLoadingModel,
    notice,
    toggle,
    levelRef,
    permissionOpen,
    confirmPermission,
    dismissPermission,
  };
}
