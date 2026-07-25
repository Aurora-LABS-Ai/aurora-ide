/**
 * Agent Window — Settings · Preferences (view).
 *
 * Personal, window-level UX preferences — the small "how the window behaves for
 * me" toggles that aren't about the agent's capabilities or the model. New cues
 * of this kind (notifications, status, motion) land here as they're built, so
 * they have one predictable home instead of scattering across other pages.
 *
 * All toggles read/write the shared `useSettingsStore` so they persist and stay
 * in lockstep with the IDE.
 */

import React from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { useSettingsStore, type TitleMakerMode } from "../../store/useSettingsStore";
import { useAgentThemeStore } from "../store/useAgentThemeStore";
import { useAgentTypingStore } from "../store/useAgentTypingStore";
import {
  refineConfigured,
  refinePathsConfigured,
  useAgentRefineStore,
  type RefineDevice,
} from "../store/useAgentRefineStore";
import { validateRefine, type RefineValidation } from "../adapters/prompt-refine";
import {
  formatCommandShortcut,
  shortcutFromKeyboardEvent,
} from "../lib/command-shortcut";
import {
  AgwButton,
  AgwPill,
  AgwSegmented,
  AgwSwitch,
  AgwTextInput,
  SettingsBlock,
  SettingsRow,
  SettingsSection,
} from "./primitives";

export const PreferencesSettings: React.FC = () => {
  const notifyOnTurnComplete = useSettingsStore((s) => s.notifyOnTurnComplete);
  const setNotifyOnTurnComplete = useSettingsStore((s) => s.setNotifyOnTurnComplete);

  const showActivityInTitle = useSettingsStore((s) => s.showActivityInTitle);
  const setShowActivityInTitle = useSettingsStore((s) => s.setShowActivityInTitle);

  // Composer layout (agent-window scoped — lives in the theme store).
  const modelSelectorPosition = useAgentThemeStore((s) => s.modelSelectorPosition);
  const setModelSelectorPosition = useAgentThemeStore((s) => s.setModelSelectorPosition);
  const commandCenterShortcut = useAgentThemeStore((s) => s.commandCenterShortcut);
  const setCommandCenterShortcut = useAgentThemeStore((s) => s.setCommandCenterShortcut);

  // Typing assistance (agent-window scoped — local, statistical engine).
  const autocorrect = useAgentTypingStore((s) => s.autocorrect);
  const setAutocorrect = useAgentTypingStore((s) => s.setAutocorrect);
  const completion = useAgentTypingStore((s) => s.completion);
  const setCompletion = useAgentTypingStore((s) => s.setCompletion);
  const nextWord = useAgentTypingStore((s) => s.nextWord);
  const setNextWord = useAgentTypingStore((s) => s.setNextWord);
  const learn = useAgentTypingStore((s) => s.learn);
  const setLearn = useAgentTypingStore((s) => s.setLearn);

  // Prompt refine (agent-window scoped — drives a local llama.cpp GGUF).
  const refineEnabled = useAgentRefineStore((s) => s.enabled);
  const setRefineEnabled = useAgentRefineStore((s) => s.setEnabled);
  const llamaDir = useAgentRefineStore((s) => s.llamaDir);
  const setLlamaDir = useAgentRefineStore((s) => s.setLlamaDir);
  const modelPath = useAgentRefineStore((s) => s.modelPath);
  const setModelPath = useAgentRefineStore((s) => s.setModelPath);
  const refineDevice = useAgentRefineStore((s) => s.device);
  const setRefineDevice = useAgentRefineStore((s) => s.setDevice);
  const refineReady = useAgentRefineStore(refineConfigured);

  const refinePathsReady = useAgentRefineStore(refinePathsConfigured);
  const dictationCleanupEnabled = useAgentRefineStore((s) => s.dictationCleanupEnabled);
  const setDictationCleanupEnabled = useAgentRefineStore((s) => s.setDictationCleanupEnabled);
  const replySuggestionsEnabled = useAgentRefineStore((s) => s.replySuggestionsEnabled);
  const setReplySuggestionsEnabled = useAgentRefineStore((s) => s.setReplySuggestionsEnabled);

  // Chat titles (shared store — the runtime reads these on a chat's first message).
  const titleMode = useSettingsStore((s) => s.titleMakerMode);
  const titleBaseUrl = useSettingsStore((s) => s.titleMakerBaseUrl);
  const titleApiKey = useSettingsStore((s) => s.titleMakerApiKey);
  const titleModel = useSettingsStore((s) => s.titleMakerModel);
  const setTitleMaker = useSettingsStore((s) => s.setTitleMaker);
  const [showTitleKey, setShowTitleKey] = React.useState(false);

  const [refineCheck, setRefineCheck] = React.useState<RefineValidation | null>(null);
  const [refineChecking, setRefineChecking] = React.useState(false);

  const runRefineCheck = React.useCallback(async () => {
    setRefineChecking(true);
    try {
      setRefineCheck(await validateRefine({ llamaDir, modelPath, device: refineDevice }));
    } catch (err) {
      setRefineCheck({
        ready: false,
        completionOk: false,
        modelOk: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRefineChecking(false);
    }
  }, [llamaDir, modelPath, refineDevice]);

  const pickLlamaDir = async () => {
    const sel = await open({
      directory: true,
      multiple: false,
      title: "Select the llama.cpp folder (with llama-completion.exe)",
    });
    if (typeof sel === "string") setLlamaDir(sel);
  };

  const pickModel = async () => {
    const sel = await open({
      multiple: false,
      filters: [{ name: "GGUF model", extensions: ["gguf"] }],
      title: "Select a GGUF model",
    });
    if (typeof sel === "string") setModelPath(sel);
  };

  return (
    <div className="agw-set-wide">
      <SettingsSection
        icon="send"
        title="Composer"
        description="How the message input's controls are arranged. Agent / Plan mode now lives inside the model picker."
      >
        <SettingsRow
          last
          label="Model selector position"
          hint="Put the model picker in the top control row or the bottom action row."
        >
          <AgwSegmented<"top" | "bottom">
            value={modelSelectorPosition}
            ariaLabel="Model selector position"
            options={[
              { value: "top", label: "Top" },
              { value: "bottom", label: "Bottom" },
            ]}
            onChange={setModelSelectorPosition}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        icon="search"
        title="Command center"
        description="Search settings, projects, chats, window actions, and quick switches from one place."
      >
        <SettingsRow
          last
          label="Open command center"
          hint="Focus the shortcut field, then press your preferred key combination. Press Backspace to restore Ctrl+K."
        >
          <button
            type="button"
            className="agw-shortcut-recorder"
            data-agw-shortcut-recorder
            aria-label="Record command center keyboard shortcut"
            title="Click, then press a keyboard shortcut"
            onKeyDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Escape") {
                event.currentTarget.blur();
                return;
              }
              if (event.key === "Backspace" || event.key === "Delete") {
                setCommandCenterShortcut("Mod+K");
                return;
              }
              const shortcut = shortcutFromKeyboardEvent(event.nativeEvent);
              if (shortcut) setCommandCenterShortcut(shortcut);
            }}
          >
            <span>Record</span>
            <kbd>{formatCommandShortcut(commandCenterShortcut)}</kbd>
          </button>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        icon="type"
        title="Typing assistance"
        description="Local, on-device writing help in the message box — nothing leaves your machine. Each feature is independent, so you can run just the ones you want. First use downloads nothing; the built-in dictionaries load once."
      >
        <SettingsRow
          label="Autocorrect misspellings"
          hint="Fix a clearly misspelled word the moment you type a space or punctuation after it. Real words, code, and names are left alone. Press Backspace right after a fix to undo it and keep your original — that word won't be corrected again."
        >
          <AgwSwitch
            checked={autocorrect}
            onChange={setAutocorrect}
            ariaLabel="Autocorrect misspelled words on a space or punctuation"
          />
        </SettingsRow>

        <SettingsRow
          label="Inline word completion"
          hint="Show the rest of the word you're typing as gray ghost text. Press → (Right-arrow) at the end of the line to accept it."
        >
          <AgwSwitch
            checked={completion}
            onChange={setCompletion}
            ariaLabel="Show inline word completion as ghost text"
          />
        </SettingsRow>

        <SettingsRow
          label="Next-word prediction"
          hint="After a space, suggest the likely next word as gray ghost text. Press → (Right-arrow) to accept."
        >
          <AgwSwitch
            checked={nextWord}
            onChange={setNextWord}
            ariaLabel="Predict the next word as ghost text"
          />
        </SettingsRow>

        <SettingsRow
          last
          label="Learn the words I type"
          hint="Adapt to your own vocabulary — words you use often are protected from autocorrect and surface earlier in suggestions. Stored only on this device."
        >
          <AgwSwitch
            checked={learn}
            onChange={setLearn}
            ariaLabel="Learn from the words you type to improve suggestions"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        icon="refine"
        title="Prompt refine"
        description="A ✦ button in the composer rewrites your prompt to be clearer without changing its intent — runs fully locally on a small GGUF model through your own llama.cpp build (no server, nothing leaves your machine)."
      >
        <SettingsRow
          label="Enable prompt refine"
          hint="Show the ✦ refine button in the message box. It stays hidden until the llama.cpp folder and a model are set below."
        >
          <AgwSwitch
            checked={refineEnabled}
            onChange={setRefineEnabled}
            ariaLabel="Enable prompt refine"
          />
        </SettingsRow>

        {refineEnabled && (
          <>
            <SettingsRow
              label="llama.cpp folder"
              hint="The folder containing llama-completion.exe and its DLLs (e.g. a llama-bXXXX-bin-win-cuda build)."
              alignTop
            >
              <div className="agw-set-field-row">
                <AgwTextInput
                  value={llamaDir}
                  placeholder="E:\\llama-bin\\llama-bXXXX-bin-win-cuda-x64"
                  onChange={(e) => setLlamaDir(e.target.value)}
                />
                <AgwButton icon="folder" onClick={() => void pickLlamaDir()}>
                  Browse
                </AgwButton>
              </div>
            </SettingsRow>

            <SettingsRow
              label="Model (.gguf)"
              hint="A small instruct model works best — e.g. Qwen2.5-0.5B-Instruct. The GGUF's own tokenizer is used; no extra files needed."
              alignTop
            >
              <div className="agw-set-field-row">
                <AgwTextInput
                  value={modelPath}
                  placeholder="…\\qwen2.5-0.5b-instruct.gguf"
                  onChange={(e) => setModelPath(e.target.value)}
                />
                <AgwButton icon="folder" onClick={() => void pickModel()}>
                  Browse
                </AgwButton>
              </div>
            </SettingsRow>

            <SettingsRow
              label="Device"
              hint="GPU uses your llama.cpp CUDA build; CPU works everywhere."
            >
              <AgwSegmented<RefineDevice>
                value={refineDevice}
                ariaLabel="Refine device"
                options={[
                  { value: "gpu", label: "GPU" },
                  { value: "cpu", label: "CPU" },
                ]}
                onChange={setRefineDevice}
              />
            </SettingsRow>

            <SettingsRow
              last
              label="Check setup"
              hint="Confirm the binary and model are found and ready."
            >
              <div className="agw-set-inline-row">
                {refineCheck && (
                  <AgwPill tone={refineCheck.ready ? "success" : "warning"}>
                    {refineCheck.ready ? "Ready" : "Not ready"}
                  </AgwPill>
                )}
                <AgwButton
                  variant="primary"
                  icon="check"
                  disabled={!refineReady || refineChecking}
                  onClick={() => void runRefineCheck()}
                >
                  {refineChecking ? "Checking…" : "Validate"}
                </AgwButton>
              </div>
            </SettingsRow>

            {refineCheck && (
              <SettingsBlock last>
                <p
                  className="text-[12px] leading-relaxed"
                  style={{
                    color: refineCheck.ready
                      ? "var(--agw-text-subtle)"
                      : "var(--agw-warning)",
                  }}
                >
                  {refineCheck.message}
                </p>
              </SettingsBlock>
            )}
          </>
        )}
      </SettingsSection>

      <SettingsSection
        icon="refine"
        title="Composer assists"
        description={
          refinePathsReady
            ? "Writing help that runs on the model configured under Prompt refine. Everything stays on this computer."
            : "Writing help that runs on a local model. Set the llama.cpp folder and model under Prompt refine to turn these on."
        }
      >
        <SettingsRow
          label="Polish voice dictation"
          hint="Add punctuation and remove filler words from voice input before it appears in the message box."
        >
          <AgwSwitch
            checked={dictationCleanupEnabled}
            onChange={setDictationCleanupEnabled}
            disabled={!refinePathsReady}
            ariaLabel="Polish voice dictation with the local model"
          />
        </SettingsRow>

        <SettingsRow
          last
          label="Suggest quick replies"
          hint="After each response, show up to three tappable replies. Tapping one fills the message box; press Enter to send."
        >
          <AgwSwitch
            checked={replySuggestionsEnabled}
            onChange={setReplySuggestionsEnabled}
            disabled={!refinePathsReady}
            ariaLabel="Suggest quick replies after each response"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        icon="message"
        title="Chat titles"
        description="How each new chat gets its name in the sidebar. Only the first message of a chat is used; if generation fails, the name derived from your message is kept."
      >
        <SettingsRow
          label="Title source"
          hint="Off names the chat from your first message. Local uses the same on-device model as Prompt refine — nothing leaves your machine. Cloud asks the endpoint you set below."
          last={titleMode === "off"}
        >
          <AgwSegmented<TitleMakerMode>
            value={titleMode}
            ariaLabel="Chat title source"
            options={[
              { value: "off", label: "Off" },
              { value: "local", label: "Local" },
              { value: "cloud", label: "Cloud" },
            ]}
            onChange={(mode) => setTitleMaker({ mode })}
          />
        </SettingsRow>

        {titleMode === "local" && (
          <SettingsRow
            last
            label="Local model"
            hint={
              refinePathsReady
                ? "Titles run on the llama.cpp model configured under Prompt refine."
                : "Set the llama.cpp folder and model under Prompt refine above — titles use the same setup."
            }
          >
            <AgwPill tone={refinePathsReady ? "success" : "warning"}>
              {refinePathsReady ? "Ready" : "Needs setup"}
            </AgwPill>
          </SettingsRow>
        )}

        {titleMode === "cloud" && (
          <>
            <SettingsRow
              label="Base URL"
              hint="OpenAI-compatible endpoint root, e.g. https://api.openai.com/v1 or your local server."
            >
              <AgwTextInput
                value={titleBaseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(e) => setTitleMaker({ baseUrl: e.target.value })}
                style={{ width: 280 }}
              />
            </SettingsRow>

            <SettingsRow
              label="Model ID"
              hint="The model to title with — exactly as the endpoint expects it (e.g. gpt-4o-mini)."
            >
              <AgwTextInput
                value={titleModel}
                placeholder="gpt-4o-mini"
                onChange={(e) => setTitleMaker({ model: e.target.value })}
                style={{ width: 280 }}
              />
            </SettingsRow>

            <SettingsRow
              last
              label="API key"
              hint="Optional — leave blank for a local server that needs no key. Stored locally with your settings."
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <AgwTextInput
                  type={showTitleKey ? "text" : "password"}
                  value={titleApiKey}
                  placeholder="sk-…"
                  onChange={(e) => setTitleMaker({ apiKey: e.target.value })}
                  style={{ width: 244 }}
                />
                <AgwButton
                  icon={showTitleKey ? "inspect" : "browser"}
                  onClick={() => setShowTitleKey((v) => !v)}
                >
                  {showTitleKey ? "Hide" : "Show"}
                </AgwButton>
              </div>
            </SettingsRow>
          </>
        )}
      </SettingsSection>

      <SettingsSection
        icon="chat"
        title="Chat status & cues"
        description="How the window keeps you in the loop while the agent works — useful when you start a chat, then move on to another one."
      >
        <SettingsRow
          label="Live status in the title"
          hint="While a chat is replying, show what the agent is doing right now in the header — “Editing LeftRail.tsx”, “Running pnpm test”, “Searching…”. The chat's real title returns as soon as it finishes."
        >
          <AgwSwitch
            checked={showActivityInTitle}
            onChange={setShowActivityInTitle}
            ariaLabel="Show live activity in the header title while streaming"
          />
        </SettingsRow>

        <SettingsRow
          last
          label="Notify when a turn finishes"
          hint="When a chat finishes replying, flash its name in the header and mark it in the sidebar. Handy for background chats you've navigated away from. Off silences both."
        >
          <AgwSwitch
            checked={notifyOnTurnComplete}
            onChange={setNotifyOnTurnComplete}
            ariaLabel="Notify when a chat's turn finishes"
          />
        </SettingsRow>
      </SettingsSection>
    </div>
  );
};
