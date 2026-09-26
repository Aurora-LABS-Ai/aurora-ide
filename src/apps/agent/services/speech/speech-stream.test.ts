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

  describe("telling the program what to do", () => {
    const live = { ...DEFAULT_SPEECH_LIVE, runtimePath: "cli.exe", modelPath: "m.gguf" };

    it("turns the shared language code into the name the model expects", () => {
      // The setting is shared with the record-then-transcribe engine, which
      // uses codes. This model only answers to names.
      expect(toStreamConfig(live, "en").language).toBe("English");
      expect(toStreamConfig(live, "zh").language).toBe("Chinese");
      expect(toStreamConfig(live, "ja").language).toBe("Japanese");
    });

    it("asks the model to work the language out when there is no hint", () => {
      expect(toStreamConfig(live, "auto").language).toBeUndefined();
      expect(toStreamConfig(live, "").language).toBeUndefined();
    });

    it("drops a language it has no name for rather than passing it through", () => {
      // The program refuses a language it does not know and never starts.
      // Detecting the language is a worse answer than the user asked for, but
      // a far better one than dictation silently not working.
      expect(toStreamConfig(live, "xx").language).toBeUndefined();
    });

    it("leaves out the extra library folder when none is set", () => {
      // An empty string would go on PATH as the current directory.
      expect(toStreamConfig(live, "auto").libraryPath).toBeUndefined();
      expect(toStreamConfig({ ...live, libraryPath: "C:/cuda" }, "auto").libraryPath).toBe(
        "C:/cuda",
      );
    });

    it("carries hold-back through under the name the program uses", () => {
      expect(toStreamConfig({ ...live, holdBack: 5 }, "auto").unfixedTokens).toBe(5);
    });
  });
});
