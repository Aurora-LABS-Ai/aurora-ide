import { describe, expect, it } from "vitest";

import { DEFAULT_SPEECH_LIVE, normalizeSpeechLive } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { toStreamConfig } from "./speech-stream";

/**
 * The two places live dictation converts between what is stored and what the
 * program is actually told. Both have failed quietly in the past elsewhere in
 * this codebase: a saved row from an older build losing fields, and a setting
 * reaching a child process in a shape it does not accept.
 */
describe("live dictation settings", () => {
  describe("reading a saved row", () => {
    it("fills in fields a row saved by an older build never had", () => {
      const stored = { runtimePath: "C:/audiocpp_cli.exe", modelPath: "C:/r2t2.gguf" };
      const live = normalizeSpeechLive(stored);
      expect(live.runtimePath).toBe("C:/audiocpp_cli.exe");
      expect(live.chunkMs).toBe(DEFAULT_SPEECH_LIVE.chunkMs);
      expect(live.holdBack).toBe(DEFAULT_SPEECH_LIVE.holdBack);
      expect(live.idleSeconds).toBe(DEFAULT_SPEECH_LIVE.idleSeconds);
    });

    it("starts a row saved before Phonon on Phonon, with its old paths kept", () => {
      // Phonon is the default. The R2T2 paths stay, so switching back works.
      const live = normalizeSpeechLive({ runtimePath: "C:/audiocpp_cli.exe", modelPath: "C:/r2t2.gguf" });
      expect(live.engine).toBe("phonon");
      expect(live.keepLoaded).toBe(true);
      expect(live.phononModelPath).toBe("");
      expect(live.modelPath).toBe("C:/r2t2.gguf");
      expect(normalizeSpeechLive({ engine: "r2t2" }).engine).toBe("r2t2");
      expect(normalizeSpeechLive({ engine: "nonsense" }).engine).toBe("phonon");
      expect(normalizeSpeechLive({ keepLoaded: false }).keepLoaded).toBe(false);
    });

    it("treats a missing or broken value as a fresh set of defaults", () => {
      expect(normalizeSpeechLive(undefined)).toEqual(DEFAULT_SPEECH_LIVE);
      expect(normalizeSpeechLive(null)).toEqual(DEFAULT_SPEECH_LIVE);
      expect(normalizeSpeechLive("not an object")).toEqual(DEFAULT_SPEECH_LIVE);
    });

    it("pulls numbers back into what the model accepts", () => {
      // The panel bounds these, but a hand-edited database row or a future
      // build's value would otherwise reach the program and fail its own
      // check with a message nobody sees.
      expect(normalizeSpeechLive({ chunkMs: 5 }).chunkMs).toBe(80);
      expect(normalizeSpeechLive({ chunkMs: 99_999 }).chunkMs).toBe(2000);
      expect(normalizeSpeechLive({ holdBack: 0 }).holdBack).toBe(1);
      expect(normalizeSpeechLive({ idleSeconds: -60 }).idleSeconds).toBe(0);
      expect(normalizeSpeechLive({ chunkMs: Number.NaN }).chunkMs).toBe(
        DEFAULT_SPEECH_LIVE.chunkMs,
      );
    });
  });

  describe("telling R2T2 what to do", () => {
    const live = {
      ...DEFAULT_SPEECH_LIVE,
      engine: "r2t2" as const,
      runtimePath: "cli.exe",
      modelPath: "m.gguf",
    };
    const crisp = "C:/crispasr";

    it("names the engine and uses its own program and model", () => {
      const config = toStreamConfig(live, "auto", crisp);
      expect(config.engine).toBe("r2t2");
      expect(config.runtimePath).toBe("cli.exe");
      expect(config.modelPath).toBe("m.gguf");
    });

    it("turns the shared language code into the name the model expects", () => {
      // The setting is shared with the record-then-transcribe engine, which
      // uses codes. This model only answers to names.
      expect(toStreamConfig(live, "en", crisp).language).toBe("English");
      expect(toStreamConfig(live, "zh", crisp).language).toBe("Chinese");
      expect(toStreamConfig(live, "ja", crisp).language).toBe("Japanese");
    });

    it("asks the model to work the language out when there is no hint", () => {
      expect(toStreamConfig(live, "auto", crisp).language).toBeUndefined();
      expect(toStreamConfig(live, "", crisp).language).toBeUndefined();
    });

    it("drops a language it has no name for rather than passing it through", () => {
      // The program refuses a language it does not know and never starts.
      // Detecting the language is a worse answer than the user asked for, but
      // a far better one than dictation silently not working.
      expect(toStreamConfig(live, "xx", crisp).language).toBeUndefined();
    });

    it("leaves out the extra library folder when none is set", () => {
      // An empty string would go on PATH as the current directory.
      expect(toStreamConfig(live, "auto", crisp).libraryPath).toBeUndefined();
      expect(
        toStreamConfig({ ...live, libraryPath: "C:/cuda" }, "auto", crisp).libraryPath,
      ).toBe("C:/cuda");
    });

    it("carries hold-back through under the name the program uses", () => {
      expect(toStreamConfig({ ...live, holdBack: 5 }, "auto", crisp).unfixedTokens).toBe(5);
    });
  });

  describe("telling Phonon what to do", () => {
    const live = {
      ...DEFAULT_SPEECH_LIVE,
      runtimePath: "audiocpp_cli.exe",
      modelPath: "r2t2.gguf",
      phononModelPath: "E:/phonon2-q8_0.gguf",
      libraryPath: "C:/cuda",
    };

    it("runs on the On stop CrispASR folder with its own model file", () => {
      const config = toStreamConfig(live, "auto", "E:/crispasr-build");
      expect(config.engine).toBe("phonon");
      expect(config.runtimePath).toBe("E:/crispasr-build");
      expect(config.modelPath).toBe("E:/phonon2-q8_0.gguf");
    });

    it("sends no language and no R2T2-only folder", () => {
      // English only, and CrispASR finds its own CUDA files beside it.
      const config = toStreamConfig(live, "de", "E:/crispasr-build");
      expect(config.language).toBeUndefined();
      expect(config.libraryPath).toBeUndefined();
    });
  });
});
