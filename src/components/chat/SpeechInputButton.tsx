import React, { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mic, Square } from "lucide-react";
import clsx from "clsx";

import { speechService } from "../../services/speech";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { ConfirmDialog } from "../ui/ConfirmDialog";

/**
 * Key for remembering that the user has explicitly granted microphone
 * access through our in-app confirmation modal. We never call
 * `getUserMedia` without an in-app `Allow` (so the user is never
 * surprised by the WebView's native permission prompt), but on
 * subsequent recordings we skip our modal entirely if this flag is set.
 *
 * Persisted per-installation in `localStorage` so a fresh app launch
 * remembers the choice without a database round-trip.
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
    if (granted) {
      localStorage.setItem(MIC_PERMISSION_KEY, "true");
    } else {
      localStorage.removeItem(MIC_PERMISSION_KEY);
    }
  } catch {
    // Some embeddings disable storage; the modal will keep asking — fine.
  }
};

interface SpeechInputButtonProps {
  disabled?: boolean;
  onTranscript: (transcript: string) => void;
}

const TARGET_SAMPLE_RATE = 16_000;

const mergeChunks = (chunks: Float32Array[]): Float32Array => {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
};

const resampleLinear = (
  samples: Float32Array,
  sourceRate: number,
  targetRate: number,
): Float32Array => {
  if (sourceRate === targetRate) return samples;
  const ratio = sourceRate / targetRate;
  const targetLength = Math.max(1, Math.round(samples.length / ratio));
  const output = new Float32Array(targetLength);

  for (let i = 0; i < targetLength; i += 1) {
    const sourceIndex = i * ratio;
    const before = Math.floor(sourceIndex);
    const after = Math.min(before + 1, samples.length - 1);
    const weight = sourceIndex - before;
    output[i] = samples[before] * (1 - weight) + samples[after] * weight;
  }

  return output;
};

const pcmToBase64 = (pcm: Float32Array): string => {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

// Resolve a CSS variable to a concrete color the canvas can use.
const resolveCssColor = (variable: string, fallback: string): string => {
  if (typeof window === "undefined") return fallback;
  try {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue(variable)
      .trim();
    return value || fallback;
  } catch {
    return fallback;
  }
};

const hexToRgba = (color: string, alpha: number): string => {
  const trimmed = color.trim();
  if (trimmed.startsWith("rgb")) {
    return trimmed.replace(/rgba?\(([^)]+)\)/, (_, body) => {
      const parts = body.split(",").map((part: string) => part.trim());
      const [r, g, b] = parts;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    });
  }
  if (trimmed.startsWith("#")) {
    const hex = trimmed.slice(1);
    const expanded =
      hex.length === 3
        ? hex
            .split("")
            .map((char) => char + char)
            .join("")
        : hex;
    const r = parseInt(expanded.slice(0, 2), 16);
    const g = parseInt(expanded.slice(2, 4), 16);
    const b = parseInt(expanded.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return trimmed;
};

export const SpeechInputButton: React.FC<SpeechInputButtonProps> = ({
  disabled,
  onTranscript,
}) => {
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
  const { setSettingsOpen } = useUiStore();

  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [permissionPromptOpen, setPermissionPromptOpen] = useState(false);
  const [rememberPermission, setRememberPermission] = useState(true);

  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
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
    streamRef.current?.getTracks().forEach((track) => track.stop());
    void audioContextRef.current?.close().catch(() => {});

    analyserRef.current = null;
    audioContextRef.current = null;
    processorRef.current = null;
    sourceRef.current = null;
    streamRef.current = null;
  }, []);

  useEffect(() => cleanupAudio, [cleanupAudio]);

  // ───────────────────────────────────────────────────────────────────────
  // Real time-domain waveform.  We render the actual oscilloscope trace
  // (audio sample → vertical position) as a smooth polyline plus a soft
  // amplitude fill underneath.
  //
  // BUG FIX (the one the user has been chasing for days):
  // We MUST schedule the next `requestAnimationFrame` BEFORE bailing on
  // missing refs, otherwise a single null read kills the loop forever.
  // The canvas is conditionally rendered only while `isRecording` is true,
  // so the very first call after `setIsRecording(true)` runs before React
  // commits the canvas — `canvasRef.current` is null on that frame.  By
  // queuing the next frame first, the loop survives that gap and starts
  // drawing as soon as the canvas is mounted.
  // ───────────────────────────────────────────────────────────────────────
  const drawWaveform = useCallback(() => {
    animationRef.current = window.requestAnimationFrame(drawWaveform);

    const analyser = analyserRef.current;
    const canvas = canvasRef.current;
    if (!analyser || !canvas) return;

    // Some WebView environments lay the canvas out at 0×0 for the first
    // frame.  Skip drawing in that case but keep the loop alive.
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (cssWidth === 0 || cssHeight === 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Back the canvas with the device pixel ratio for crisp rendering.
    const dpr = window.devicePixelRatio || 1;
    const targetWidth = Math.round(cssWidth * dpr);
    const targetHeight = Math.round(cssHeight * dpr);
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    const w = canvas.width;
    const h = canvas.height;
    const center = h / 2;

    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);

    ctx.clearRect(0, 0, w, h);

    const primaryColor = resolveCssColor("--aurora-common-primary", "#7c5cff");

    // Faint baseline.
    ctx.fillStyle = hexToRgba(primaryColor, 0.18);
    ctx.fillRect(0, Math.floor(center), w, Math.max(1, Math.floor(dpr)));

    const sampleStep = Math.max(1, Math.floor(data.length / w));
    const points: Array<[number, number]> = [];

    for (let x = 0; x < w; x += 1) {
      const idx = Math.min(data.length - 1, x * sampleStep);
      // 0–255 → -1..1
      const sample = (data[idx] - 128) / 128;
      const y = center - sample * (h * 0.42);
      points.push([x, y]);
    }

    // Amplitude fill region (under the waveline).
    const fillGradient = ctx.createLinearGradient(0, 0, 0, h);
    fillGradient.addColorStop(0, hexToRgba(primaryColor, 0.0));
    fillGradient.addColorStop(0.5, hexToRgba(primaryColor, 0.18));
    fillGradient.addColorStop(1, hexToRgba(primaryColor, 0.0));
    ctx.fillStyle = fillGradient;
    ctx.beginPath();
    ctx.moveTo(0, center);
    for (const [x, y] of points) {
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, center);
    ctx.closePath();
    ctx.fill();

    // Waveform line trace.
    ctx.lineWidth = Math.max(1, 1.4 * dpr);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = primaryColor;
    ctx.shadowColor = hexToRgba(primaryColor, 0.45);
    ctx.shadowBlur = 4 * dpr;
    ctx.beginPath();
    if (points.length > 0) {
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i += 1) {
        ctx.lineTo(points[i][0], points[i][1]);
      }
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }, []);

  // Drive the animation from an effect so the loop only starts once the
  // canvas has been committed to the DOM.  This is what makes the waveform
  // actually appear instead of getting trapped in the null-canvas gap.
  useEffect(() => {
    if (!isRecording) return;
    if (animationRef.current === null) {
      animationRef.current = window.requestAnimationFrame(drawWaveform);
    }
    return () => {
      if (animationRef.current !== null) {
        window.cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [isRecording, drawWaveform]);

  const createRuntimeRequest = useCallback(
    (devicePreference = speechDevicePreference) => ({
      backend: speechBackend,
      devicePreference,
      engine: speechEngine,
      modelPath: speechModelPath,
      nThreads: speechThreads,
      runtimePath: speechRuntimePath,
    }),
    [
      speechBackend,
      speechDevicePreference,
      speechEngine,
      speechModelPath,
      speechRuntimePath,
      speechThreads,
    ],
  );

  /**
   * Inner mic-access flow. Only call this *after* the user has
   * explicitly confirmed through the in-app permission modal (or has a
   * remembered prior confirmation). The native WebView prompt may still
   * pop on the first call per session — Tauri's release build can
   * pre-authorise via config, but the dev server at `localhost:5173`
   * runs under Chromium's own permission gate and always prompts.
   */
  const actuallyStartRecording = useCallback(async () => {
    setError(null);

    if (!speechModelPath.trim()) {
      setSettingsOpen(true);
      setError("Configure Speech settings first.");
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Microphone recording is not available in this WebView.");
      return;
    }

    try {
      let validation = await speechService.validateConfig(createRuntimeRequest());
      if (
        !validation.ready &&
        speechDevicePreference === "gpu" &&
        !validation.gpuAvailable
      ) {
        setSpeechDevicePreference("auto");
        validation = await speechService.validateConfig(
          createRuntimeRequest("auto"),
        );
      }

      if (!validation.ready) {
        setError(validation.message);
        if (!validation.modelOk || !validation.runtimeOk) {
          setSettingsOpen(true);
        }
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
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        chunksRef.current.push(new Float32Array(input));
        event.outputBuffer.getChannelData(0).fill(0);
      };

      source.connect(analyser);
      analyser.connect(processor);
      processor.connect(audioContext.destination);

      streamRef.current = stream;
      audioContextRef.current = audioContext;
      sourceRef.current = source;
      analyserRef.current = analyser;
      processorRef.current = processor;
      // The animation loop is started by the useEffect that watches
      // `isRecording` — it fires after the canvas mounts.
      setIsRecording(true);
    } catch (err) {
      cleanupAudio();
      setError(err instanceof Error ? err.message : "Microphone access failed.");
    }
  }, [
    cleanupAudio,
    createRuntimeRequest,
    setSettingsOpen,
    setSpeechDevicePreference,
    speechDevicePreference,
    speechModelPath,
  ]);

  /**
   * Public entry point bound to the mic button. Asks the user for
   * microphone access through our IDE-styled `ConfirmDialog` before
   * the WebView's native permission prompt has a chance to appear.
   * Once the user has remembered the choice, subsequent recordings
   * skip the modal and call `actuallyStartRecording` directly.
   */
  const startRecording = useCallback(async () => {
    setError(null);
    if (readMicPermissionRemembered()) {
      await actuallyStartRecording();
      return;
    }
    setRememberPermission(true);
    setPermissionPromptOpen(true);
  }, [actuallyStartRecording]);

  const handlePermissionConfirm = useCallback(() => {
    setPermissionPromptOpen(false);
    if (rememberPermission) {
      writeMicPermissionRemembered(true);
    }
    void actuallyStartRecording();
  }, [actuallyStartRecording, rememberPermission]);

  const handlePermissionCancel = useCallback(() => {
    setPermissionPromptOpen(false);
  }, []);

  const stopRecording = useCallback(async () => {
    const sourceRate = audioContextRef.current?.sampleRate || TARGET_SAMPLE_RATE;
    const chunks = [...chunksRef.current];
    cleanupAudio();
    setIsRecording(false);

    const merged = mergeChunks(chunks);
    if (merged.length < TARGET_SAMPLE_RATE / 4) {
      setError("Recording was too short.");
      return;
    }

    const pcm = resampleLinear(merged, sourceRate, TARGET_SAMPLE_RATE);
    setIsTranscribing(true);
    setError(null);

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
      onTranscript(result.transcript);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsTranscribing(false);
    }
  }, [
    cleanupAudio,
    onTranscript,
    speechBackend,
    speechDevicePreference,
    speechEngine,
    speechLanguage,
    speechModelPath,
    speechRuntimePath,
    speechThreads,
  ]);

  if (!speechEnabled) return null;

  const hasError = Boolean(error);

  // Wrapperless icon button — no border / no background at idle, only a
  // subtle accent on hover. Matches the title-bar / explorer button vibe.
  const iconColor = isRecording
    ? "var(--aurora-common-error)"
    : hasError
      ? "var(--aurora-common-warning)"
      : isTranscribing
        ? "var(--aurora-common-primary)"
        : isHovered
          ? "var(--aurora-editor-foreground)"
          : "var(--aurora-text-secondary, var(--aurora-editor-foreground))";

  const triggerStyle: React.CSSProperties = {
    color: iconColor,
    backgroundColor: isRecording
      ? "color-mix(in srgb, var(--aurora-common-error) 14%, transparent)"
      : isHovered && !isTranscribing
        ? "color-mix(in srgb, var(--aurora-common-primary) 8%, transparent)"
        : "transparent",
    border: "none",
    borderRadius: 5,
    transition: "background-color 140ms ease, color 140ms ease",
  };

  return (
    <div className="flex items-center gap-1.5" title={error || undefined}>
      {isRecording && (
        <div
          className="flex h-7 w-32 items-center"
          style={{
            border:
              "1px solid color-mix(in srgb, var(--aurora-common-primary) 25%, transparent)",
            backgroundColor:
              "color-mix(in srgb, var(--aurora-common-primary) 6%, var(--aurora-chat-surface) 94%)",
            borderRadius: 7,
            padding: "2px 4px",
            overflow: "hidden",
          }}
        >
          <canvas
            ref={canvasRef}
            className="block h-full w-full"
            style={{ display: "block" }}
          />
        </div>
      )}
      <button
        aria-label={isRecording ? "Stop speech input" : "Start speech input"}
        className={clsx(
          "flex h-7 w-7 items-center justify-center transition-all outline-none focus:outline-none",
        )}
        disabled={disabled || isTranscribing}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onClick={(event) => {
          event.stopPropagation();
          void (isRecording ? stopRecording() : startRecording());
        }}
        style={triggerStyle}
        title={error || (isRecording ? "Stop recording" : "Speak")}
      >
        {isTranscribing ? (
          <Loader2 size={13} className="animate-spin" />
        ) : isRecording ? (
          <Square size={11} fill="currentColor" />
        ) : (
          <Mic size={14} />
        )}
      </button>

      {/* IDE-styled permission gate. Shown the first time the user
          clicks the mic button (or any time after they revoke). On
          confirm we stash a `localStorage` flag so subsequent runs go
          straight to `actuallyStartRecording`. */}
      <ConfirmDialog
        isOpen={permissionPromptOpen}
        variant="info"
        icon={Mic}
        title="Allow microphone access"
        description={
          <>
            Aurora records audio locally to transcribe what you say into the chat
            input. Audio is processed on this machine via the configured speech
            engine; nothing is uploaded.
          </>
        }
        confirmLabel="Allow microphone"
        cancelLabel="Not now"
        onConfirm={handlePermissionConfirm}
        onCancel={handlePermissionCancel}
      >
        <label className="flex items-center gap-2 text-[12px] text-text-secondary cursor-pointer select-none">
          <input
            type="checkbox"
            checked={rememberPermission}
            onChange={(e) => setRememberPermission(e.target.checked)}
            className="h-3.5 w-3.5 accent-primary cursor-pointer"
          />
          <span>Remember this choice on this machine</span>
        </label>
      </ConfirmDialog>
    </div>
  );
};
