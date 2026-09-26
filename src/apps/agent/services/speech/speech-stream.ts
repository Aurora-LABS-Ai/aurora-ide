/**
 * Live dictation — the front-end half.
 *
 * Its sibling `speech.ts` records everything and transcribes once at the end.
 * This one keeps a program running while you talk and words come back as you
 * say them, so it is a second service rather than more options on that one.
 *
 * ## The shape of a recording
 *
 * ```
 * arm()          start the program, let it load the model (~3.5s)
 *   -> onReady   it is listening; only now is audio worth sending
 * write() x N    one call per block the microphone hands us
 * stop()
 *   -> onFinal   the whole text, including the last words it held back
 * ```
 *
 * `onWords` fires throughout with whatever is new. Those pieces join end to
 * end, so the caller appends them. The model keeps the last word or two to
 * itself until the next moment of audio confirms them, which is why `onFinal`
 * can contain more than every `onWords` put together — and why the caller
 * should replace its text with `onFinal` rather than appending it.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import type { SpeechLiveSettings } from "@/apps/agent/store/settings/useAgentSettingsStore";

/** What the Rust side needs to start the program. */
export interface SpeechStreamConfig {
  runtimePath: string;
  modelPath: string;
  backend: string;
  chunkMs: number;
  unfixedTokens: number;
  language?: string;
  libraryPath?: string;
}

/** What a setup check found. Every field is something the panel can say. */
export interface SpeechStreamValidation {
  ready: boolean;
  runtimeOk: boolean;
  modelOk: boolean;
  executablePath: string | null;
  missingLibraries: string[];
  message: string;
}

/** The model wants a language name, not a two-letter code. */
const LANGUAGE_NAMES: Record<string, string> = {
  ar: "Arabic",
  cs: "Czech",
  da: "Danish",
  de: "German",
  el: "Greek",
  en: "English",
  es: "Spanish",
  fa: "Persian",
  fi: "Finnish",
  fil: "Filipino",
  fr: "French",
  hi: "Hindi",
  hu: "Hungarian",
  id: "Indonesian",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  mk: "Macedonian",
  ms: "Malay",
  nl: "Dutch",
  pl: "Polish",
  pt: "Portuguese",
  ro: "Romanian",
  ru: "Russian",
  sv: "Swedish",
  th: "Thai",
  tr: "Turkish",
  vi: "Vietnamese",
  yue: "Cantonese",
  zh: "Chinese",
};

/**
 * Turn the stored settings into what Rust expects.
 *
 * `language` is the shared setting the batch engine also uses, where it is a
 * code. An unknown code is dropped rather than passed through, because the
 * model refuses a language it does not recognise and detecting it is a better
 * outcome than failing to start.
 */
export function toStreamConfig(
  live: SpeechLiveSettings,
  language: string,
): SpeechStreamConfig {
  const code = (language || "auto").trim().toLowerCase();
  const named = code === "auto" ? undefined : LANGUAGE_NAMES[code];
  return {
    runtimePath: live.runtimePath,
    modelPath: live.modelPath,
    backend: live.backend || "auto",
    chunkMs: live.chunkMs,
    unfixedTokens: live.holdBack,
    language: named,
    libraryPath: live.libraryPath || undefined,
  };
}

/** Raw f32 samples to the base64 the IPC layer can carry. */
export function pcmToBase64(pcm: Float32Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

interface SessionEvent {
  sessionId: string;
  text: string;
}

export interface SpeechStreamHandlers {
  /** The model finished loading and is listening. */
  onReady: () => void;
  /** New words. These join end to end. */
  onWords: (text: string) => void;
  /** The whole text. Replace what you have with this, do not append it. */
  onFinal: (text: string) => void;
  /** Something went wrong, already worded for a person. */
  onError: (message: string) => void;
}

/**
 * One recording, from armed to finished.
 *
 * Every listener filters on the session id, so a leftover program from a
 * previous recording cannot write into the current one.
 */
export class SpeechStreamSession {
  private unlisteners: UnlistenFn[] = [];
  private sessionId: string | null = null;
  private closed = false;

  private readonly handlers: SpeechStreamHandlers;

  private constructor(handlers: SpeechStreamHandlers) {
    this.handlers = handlers;
  }

  /**
   * Start the program and begin loading the model. Resolves once it is
   * running; `onReady` follows when it can actually hear.
   */
  static async arm(
    config: SpeechStreamConfig,
    handlers: SpeechStreamHandlers,
  ): Promise<SpeechStreamSession> {
    const session = new SpeechStreamSession(handlers);
    // Listen before arming. The model takes seconds to load so there is room
    // to spare, but ordering it this way means a fast failure is still heard.
    await session.subscribe();
    try {
      session.sessionId = await auroraInvoke<string>("speech_stream_arm", { config });
    } catch (error) {
      await session.dispose();
      throw error;
    }
    return session;
  }

  private async subscribe(): Promise<void> {
    const mine = (event: { payload: SessionEvent }) =>
      !this.closed && this.sessionId !== null && event.payload.sessionId === this.sessionId;

    this.unlisteners = await Promise.all([
      listen<SessionEvent>("speech_stream_ready", (e) => {
        if (mine(e)) this.handlers.onReady();
      }),
      listen<SessionEvent>("speech_stream_partial", (e) => {
        if (mine(e)) this.handlers.onWords(e.payload.text);
      }),
      listen<SessionEvent>("speech_stream_final", (e) => {
        if (mine(e)) this.handlers.onFinal(e.payload.text);
      }),
      listen<SessionEvent>("speech_stream_error", (e) => {
        if (mine(e)) this.handlers.onError(e.payload.text);
      }),
    ]);
  }

  /** Send one block of captured audio. */
  async write(pcm: Float32Array): Promise<void> {
    if (this.closed || !this.sessionId || pcm.length === 0) return;
    await auroraInvoke<void>("speech_stream_write", {
      sessionId: this.sessionId,
      pcmBase64: pcmToBase64(pcm),
    });
  }

  /** Stop recording and wait for `onFinal`. */
  async stop(): Promise<void> {
    if (this.closed || !this.sessionId) return;
    await auroraInvoke<void>("speech_stream_stop", { sessionId: this.sessionId });
  }

  /** Throw the recording away and release the model. */
  async cancel(): Promise<void> {
    if (this.sessionId && !this.closed) {
      try {
        await auroraInvoke<void>("speech_stream_cancel", { sessionId: this.sessionId });
      } catch {
        // Already gone. Cancelling twice is not a failure.
      }
    }
    await this.dispose();
  }

  /** Drop the listeners. Safe to call more than once. */
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.unlisteners) {
      try {
        off();
      } catch {
        // The window may be tearing down; nothing useful to do.
      }
    }
    this.unlisteners = [];
  }
}

export const speechStreamService = {
  /** Check the program, model and CUDA files without loading anything. */
  validate(config: SpeechStreamConfig): Promise<SpeechStreamValidation> {
    return auroraInvoke<SpeechStreamValidation>("speech_stream_validate", { config });
  },

  /** Stop every recording. Used when the window closes. */
  shutdown(): Promise<void> {
    return auroraInvoke<void>("speech_stream_shutdown");
  },
};
