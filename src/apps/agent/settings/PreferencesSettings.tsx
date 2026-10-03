/**
 * Agent Window — Settings · Preferences (view).
 *
 * Personal, window-level UX preferences — the small "how the window behaves for
 * me" toggles that aren't about the agent's capabilities or the model. New cues
 * of this kind (notifications, status, motion) land here as they're built, so
 * they have one predictable home instead of scattering across other pages.
 *
 * All toggles read/write the shared `useAgentSettingsStore` so they persist and stay
 * in lockstep with the IDE.
 *
 * Divided into categories the way Appearance is, and for the same reason: the
 * page had grown to ten blocks on one scroll, so the thing you came to change
 * was somewhere below the fold behind four things you did not. The tab bar,
 * the persisted selection, the arrow-key movement and the search behaviour all
 * mirror `AppearanceSettings` exactly — two settings pages that look divided
 * the same way but behave differently would be worse than one long scroll.
 */

import React, { useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { useAgentSettingsStore, type TitleMakerMode } from "@/apps/agent/store/settings/useAgentSettingsStore";
import {
  useAgentThemeStore,
  type TranscriptReasoning,
  type TranscriptTextPace,
} from "@/apps/agent/store/ui/useAgentThemeStore";
import { useAgentTypingStore } from "@/apps/agent/store/composer/useAgentTypingStore";
import {
  refineConfigured,
  refinePathsConfigured,
  replySuggestModelReady,
  useAgentRefineStore,
  type RefineDevice,
} from "@/apps/agent/store/composer/useAgentRefineStore";
import { useModelOptions } from "./useModelOptions";

/** The default row of the reply-suggestion picker: the local model. */
const LOCAL_SUGGEST_MODEL = {
  value: "",
  label: "Local model",
  meta: "Prompt refine",
};
import {
  asChatFormat,
  CHAT_FORMAT_LABELS,
  validateRefine,
  type ChatFormat,
  type RefineValidation,
} from "../adapters/prompt-refine";
import {
  formatCommandShortcut,
  shortcutFromKeyboardEvent,
} from "@/apps/agent/lib/command/command-shortcut";
import {
  DEFAULT_LAUNCH_SURFACE,
  getLaunchSurface,
  setLaunchSurface,
  type LaunchSurface,
} from "../adapters/launch-surface";
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
} from "./primitives";
import { useSettingsQuery } from "./settings-search";
import { AgentIcon, type AgentIconName } from "@/apps/agent/shared/AgentIcon";
import { useAgentUiStore, type PreferencesTab } from "@/apps/agent/store/ui/useAgentUiStore";
import { SpeechSettings } from "./SpeechSettings";
import { SystemIntegrationSettings } from "./SystemIntegrationSettings";

/**
 * The chat-format dropdown's options, built from the one list the backend
 * shares, so a new format shows up in both places by existing.
 */
const CHAT_FORMAT_OPTIONS = (Object.keys(CHAT_FORMAT_LABELS) as ChatFormat[]).map((value) => ({
  value,
  label: CHAT_FORMAT_LABELS[value],
}));

/** Said the same way under Prompt refine and under Chat titles. */
const CHAT_FORMAT_HINT =
  "How your message is handed to the model. Auto reads it from the model file and is right for almost every model — change it only if replies come back as run-together words, or the model fails to answer at all.";

// ── Tabs ────────────────────────────────────────────────────────────────────

/**
 * Three categories, split by what you are actually changing:
 *
 * - **General** — the app around the window: what opens on launch, how you
 *   reach the command center.
 * - **Composer** — every way words get into the message box, typed or spoken,
 *   and the local model that helps with them.
 * - **Chat** — the conversation itself: how it is named, how it tells you it
 *   is done, how a reply is laid out.
 *
 * The order is the order of use: you launch, you write, you read.
 */
const TABS: { id: PreferencesTab; label: string; icon: AgentIconName }[] = [
  { id: "general", label: "General", icon: "settings" },
  { id: "composer", label: "Composer", icon: "send" },
  { id: "chat", label: "Chat", icon: "chat" },
];

export const PreferencesSettings: React.FC = () => {
  const notifyOnTurnComplete = useAgentSettingsStore((s) => s.notifyOnTurnComplete);
  const setNotifyOnTurnComplete = useAgentSettingsStore((s) => s.setNotifyOnTurnComplete);

  const showActivityInTitle = useAgentSettingsStore((s) => s.showActivityInTitle);
  const setShowActivityInTitle = useAgentSettingsStore((s) => s.setShowActivityInTitle);

  // Transcript layout. The two live in different stores on purpose: the spine is
  // appearance (and so resets with the rest of it), while chapters change the
  // agent's instructions and tool roster and must not be swept away by a
  // "reset appearance".
  const transcriptSpine = useAgentThemeStore((s) => s.transcriptSpine);
  const setTranscriptSpine = useAgentThemeStore((s) => s.setTranscriptSpine);
  const transcriptStickyUser = useAgentThemeStore((s) => s.transcriptStickyUser);
  const setTranscriptStickyUser = useAgentThemeStore((s) => s.setTranscriptStickyUser);
  const transcriptReasoning = useAgentThemeStore((s) => s.transcriptReasoning);
  const setTranscriptReasoning = useAgentThemeStore((s) => s.setTranscriptReasoning);
  const transcriptToolRunsOpen = useAgentThemeStore((s) => s.transcriptToolRunsOpen);
  const setTranscriptToolRunsOpen = useAgentThemeStore((s) => s.setTranscriptToolRunsOpen);
  const transcriptActionsVisible = useAgentThemeStore((s) => s.transcriptActionsVisible);
  const setTranscriptActionsVisible = useAgentThemeStore((s) => s.setTranscriptActionsVisible);
  const transcriptTimestamps = useAgentThemeStore((s) => s.transcriptTimestamps);
  const setTranscriptTimestamps = useAgentThemeStore((s) => s.setTranscriptTimestamps);
  const transcriptSmoothTools = useAgentThemeStore((s) => s.transcriptSmoothTools);
  const setTranscriptSmoothTools = useAgentThemeStore((s) => s.setTranscriptSmoothTools);
  const transcriptTextPace = useAgentThemeStore((s) => s.transcriptTextPace);
  const setTranscriptTextPace = useAgentThemeStore((s) => s.setTranscriptTextPace);
  const transcriptTurnSummary = useAgentThemeStore((s) => s.transcriptTurnSummary);
  const setTranscriptTurnSummary = useAgentThemeStore((s) => s.setTranscriptTurnSummary);
  const reduceMotion = useAgentThemeStore((s) => s.reduceMotion);
  const transcriptChapters = useAgentSettingsStore((s) => s.transcriptChapters);
  const setTranscriptChapters = useAgentSettingsStore((s) => s.setTranscriptChapters);

  // Startup surface. Not a store: it lives in a boot-config FILE that Rust must
  // read before the database exists, so it is loaded once on mount and written
  // straight through (see adapters/launch-surface.ts).
  const [launchSurface, setLaunchSurfaceState] =
    React.useState<LaunchSurface>(DEFAULT_LAUNCH_SURFACE);
  const [launchSurfaceError, setLaunchSurfaceError] = React.useState<string | null>(
    null,
  );

  React.useEffect(() => {
    let cancelled = false;
    void getLaunchSurface().then((surface) => {
      if (!cancelled) setLaunchSurfaceState(surface);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Optimistic, then reverted if the write fails. A startup preference that
  // shows the new value while the next launch still does the old thing is worse
  // than one that visibly refuses.
  const changeLaunchSurface = (next: LaunchSurface) => {
    const previous = launchSurface;
    setLaunchSurfaceState(next);
    setLaunchSurfaceError(null);
    void setLaunchSurface(next).catch((err: unknown) => {
      setLaunchSurfaceState(previous);
      setLaunchSurfaceError(
        `Couldn't save this. ${String((err as Error)?.message ?? err)}`,
      );
    });
  };

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
  const refineChatFormat = useAgentRefineStore((s) => s.chatFormat);
  const setRefineChatFormat = useAgentRefineStore((s) => s.setChatFormat);
  const refineDevice = useAgentRefineStore((s) => s.device);
  const setRefineDevice = useAgentRefineStore((s) => s.setDevice);
  const refineReady = useAgentRefineStore(refineConfigured);

  const refinePathsReady = useAgentRefineStore(refinePathsConfigured);
  const dictationCleanupEnabled = useAgentRefineStore((s) => s.dictationCleanupEnabled);
  const setDictationCleanupEnabled = useAgentRefineStore((s) => s.setDictationCleanupEnabled);
  const replySuggestionsEnabled = useAgentRefineStore((s) => s.replySuggestionsEnabled);
  const setReplySuggestionsEnabled = useAgentRefineStore((s) => s.setReplySuggestionsEnabled);
  const replySuggestModel = useAgentRefineStore((s) => s.replySuggestModel);
  const setReplySuggestModel = useAgentRefineStore((s) => s.setReplySuggestModel);
  const replySuggestReady = useAgentRefineStore(replySuggestModelReady);
  const replySuggestOptions = useModelOptions(LOCAL_SUGGEST_MODEL);

  // Chat titles (shared store — the runtime reads these on a chat's first message).
  const titleMode = useAgentSettingsStore((s) => s.titleMakerMode);
  const titleBaseUrl = useAgentSettingsStore((s) => s.titleMakerBaseUrl);
  const titleApiKey = useAgentSettingsStore((s) => s.titleMakerApiKey);
  const titleModel = useAgentSettingsStore((s) => s.titleMakerModel);
  const titleLocalModel = useAgentSettingsStore((s) => s.titleMakerLocalModel);
  const titleLocalChatFormat = useAgentSettingsStore((s) => s.titleMakerLocalChatFormat);
  const setTitleMaker = useAgentSettingsStore((s) => s.setTitleMaker);
  const [showTitleKey, setShowTitleKey] = React.useState(false);

  // Whether titles use their OWN model. Stored as "a path, or empty" — one
  // field, so it can never disagree with itself. This mirrors it into local
  // state only so the "different model" choice survives an empty path field
  // while you are still typing it.
  const [titleOwnModel, setTitleOwnModel] = React.useState(() => titleLocalModel.trim() !== "");
  React.useEffect(() => {
    // Settings can hydrate from the database after this mounts. Only ever
    // turns the choice ON — switching it off clears the path, which would
    // otherwise make this fight the user.
    if (titleLocalModel.trim()) setTitleOwnModel(true);
  }, [titleLocalModel]);

  /** The llama.cpp runtime is shared; only the model can differ. */
  const titleLocalReady =
    llamaDir.trim() !== "" &&
    (titleOwnModel ? titleLocalModel.trim() !== "" : modelPath.trim() !== "");

  const [refineCheck, setRefineCheck] = React.useState<RefineValidation | null>(null);
  const [refineChecking, setRefineChecking] = React.useState(false);

  const runRefineCheck = React.useCallback(async () => {
    setRefineChecking(true);
    try {
      setRefineCheck(
        await validateRefine({
          llamaDir,
          modelPath,
          device: refineDevice,
          chatFormat: refineChatFormat,
        }),
      );
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
  }, [llamaDir, modelPath, refineDevice, refineChatFormat]);

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

  const pickTitleModel = async () => {
    const sel = await open({
      multiple: false,
      filters: [{ name: "GGUF model", extensions: ["gguf"] }],
      title: "Select a GGUF model for chat titles",
    });
    if (typeof sel === "string") setTitleMaker({ localModel: sel });
  };

  // Persisted, so reopening Preferences returns to the category last worked in
  // rather than to the top of the page.
  const storedTab = useAgentUiStore((s) => s.preferencesTab);
  const setTab = useAgentUiStore((s) => s.setPreferencesTab);
  // A persisted value survives a rename or removal of the tab it names, and an
  // id no section answers to renders a page with nothing on it. Fall back
  // rather than show an empty Preferences.
  const tab = TABS.some((t) => t.id === storedTab) ? storedTab : "general";

  // A query turns the tabs off entirely rather than filtering within one: the
  // sections hide themselves when they do not match, so rendering all of them
  // is what lets a search for "chapters" find a switch two tabs away.
  const searching = useSettingsQuery().length > 0;
  const shows = (id: PreferencesTab) => searching || tab === id;

  const tabsRef = useRef<HTMLDivElement>(null);

  /**
   * Switch category and return to the top of the page.
   *
   * Without the scroll, leaving a long tab part-way down lands the next one at
   * whatever offset the last one was at — a category that opens half-read, with
   * its heading already off screen.
   */
  const selectTab = (next: PreferencesTab) => {
    setTab(next);
    tabsRef.current?.closest(".agw-settings-content")?.scrollTo({ top: 0 });
  };

  const onTabKeys = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const index = TABS.findIndex((t) => t.id === tab);
    if (index < 0) return;
    const step = e.key === "ArrowRight" ? 1 : TABS.length - 1;
    selectTab(TABS[(index + step) % TABS.length].id);
    e.preventDefault();
  };

  return (
    <div className="agw-set-wide">
      {/* Category tabs. Hidden while searching — see `searching` above. */}
      {!searching && (
        <div
          ref={tabsRef}
          className="agw-set-tabs"
          role="tablist"
          aria-label="Preferences categories"
          onKeyDown={onTabKeys}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`agw-pref-tab-${t.id}`}
              aria-selected={t.id === tab}
              aria-controls={`agw-pref-panel-${t.id}`}
              // Only the selected tab is in the tab order; the arrow keys move
              // between them, which is what a tablist is expected to do.
              tabIndex={t.id === tab ? 0 : -1}
              className="agw-set-tab"
              data-selected={t.id === tab || undefined}
              onClick={() => selectTab(t.id)}
            >
              <AgentIcon name={t.icon} size={14} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      )}

      <div
        // Carries the column gap `.agw-set-wide` would have applied directly to
        // the sections, which this wrapper now sits between.
        className="agw-set-tabpanel"
        // One panel wrapper per rendered tab so the relationship the tabs
        // announce actually exists in the a11y tree. While searching there is
        // no selected tab, so the panel is a plain container.
        {...(searching
          ? {}
          : {
              role: "tabpanel",
              id: `agw-pref-panel-${tab}`,
              "aria-labelledby": `agw-pref-tab-${tab}`,
            })}
      >
      {shows("general") && (
      <SettingsSection
        icon="external"
        title="Startup"
        description="Which window opens when you launch Aurora."
      >
        <SettingsRow
          last
          label="Open on launch"
          // Required help, so it is stated inline rather than in a tooltip: the
          // preference deliberately does NOT apply to launches that name a
          // path, and a user who set "Agent window" would otherwise read the
          // Explorer menu still opening the editor as the setting being broken.
          hint={
            launchSurfaceError ??
            "Applies to the app icon only. Opening a folder or file — from the CLI, the Explorer menu, or a file association — always opens the editor."
          }
        >
          <AgwSegmented<LaunchSurface>
            value={launchSurface}
            ariaLabel="Window to open on launch"
            options={[
              { value: "ide", label: "Editor" },
              { value: "agent", label: "Agent window" },
            ]}
            onChange={changeLaunchSurface}
          />
        </SettingsRow>
      </SettingsSection>
      )}

      {/* Beside Startup on purpose: "which window opens" and "how you open it
          from outside" are the same question. Moved here from the IDE window's
          General tab, which is two windows away from everything it launches. */}
      {shows("general") && <SystemIntegrationSettings />}

      {shows("general") && (
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
      )}

      {shows("composer") && (
      <SettingsSection
        icon="send"
        // Not "Composer": this sits inside the Composer tab, and a section
        // sharing its tab's name reads as the whole tab rather than as the one
        // thing in it — where the controls sit.
        title="Controls"
        // Names the composer, so a search for it still lands here now that the
        // section itself is no longer called that.
        description="How the composer's controls are arranged. Agent / Plan mode now lives inside the model picker."
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
      )}

      {shows("composer") && (
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
      )}

      {/* Voice sits next to typing: both are ways of getting words into the
          composer, which is also why they share a tab. The dictation-polish
          toggle that consumes it lives further down under "Composer assists",
          with the other refine-model options. */}
      {shows("composer") && <SpeechSettings />}

      {shows("composer") && (
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

            <SettingsRow label="Chat format" hint={CHAT_FORMAT_HINT}>
              <AgwSelect
                value={refineChatFormat}
                options={CHAT_FORMAT_OPTIONS}
                ariaLabel="Chat format for the prompt-refine model"
                onChange={(v) => setRefineChatFormat(asChatFormat(v))}
                width={220}
              />
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
      )}

      {shows("composer") && (
      <SettingsSection
        icon="refine"
        title="Composer assists"
        description={
          refinePathsReady
            ? "Writing help that runs on the model configured under Prompt refine, on this computer. Quick replies can use one of your configured models instead."
            : "Writing help that runs on a local model. Set the llama.cpp folder and model under Prompt refine to turn these on. Quick replies can use one of your configured models instead."
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
          label="Suggest quick replies"
          hint="After each response, show a few tappable replies. Tapping one fills the message box; press Enter to send."
        >
          <AgwSwitch
            checked={replySuggestionsEnabled}
            onChange={setReplySuggestionsEnabled}
            disabled={!replySuggestReady}
            ariaLabel="Suggest quick replies after each response"
          />
        </SettingsRow>

        <SettingsRow
          last
          label="Quick reply model"
          hint={
            replySuggestModel
              ? "Runs on this model after every response, so each set of replies is a small paid request to its provider. Your message and the reply are sent to it."
              : refinePathsReady
                ? "Runs on the local model set under Prompt refine. Nothing leaves this computer."
                : "Set up the local model under Prompt refine, or pick one of your configured models."
          }
        >
          <AgwSelect
            value={replySuggestModel}
            options={replySuggestOptions}
            onChange={setReplySuggestModel}
            ariaLabel="Model that writes quick replies"
          />
        </SettingsRow>
      </SettingsSection>
      )}

      {shows("chat") && (
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
          <>
            <SettingsRow
              label="Model"
              hint="Titles always run through the llama.cpp folder set under Prompt refine — there is only one on this computer. The model can differ, though: a small model made for naming things does this job faster."
            >
              <AgwSegmented<"shared" | "own">
                value={titleOwnModel ? "own" : "shared"}
                ariaLabel="Which local model writes chat titles"
                options={[
                  { value: "shared", label: "Prompt refine" },
                  { value: "own", label: "Another model" },
                ]}
                onChange={(choice) => {
                  const own = choice === "own";
                  setTitleOwnModel(own);
                  // Empty IS "use the refine model" in storage, so switching
                  // back clears the path rather than leaving a second source
                  // of truth behind it.
                  if (!own) setTitleMaker({ localModel: "" });
                }}
              />
            </SettingsRow>

            {titleOwnModel && (
              <>
                <SettingsRow
                  label="Title model (.gguf)"
                  hint="A tiny model trained to name things is enough here, and finishes in well under a second."
                  alignTop
                >
                  <div className="agw-set-field-row">
                    <AgwTextInput
                      value={titleLocalModel}
                      placeholder="…\\LFM2.5-230M-Title-Generator-bf16.gguf"
                      onChange={(e) => setTitleMaker({ localModel: e.target.value })}
                    />
                    <AgwButton icon="folder" onClick={() => void pickTitleModel()}>
                      Browse
                    </AgwButton>
                  </div>
                </SettingsRow>

                <SettingsRow label="Chat format" hint={CHAT_FORMAT_HINT}>
                  <AgwSelect
                    value={asChatFormat(titleLocalChatFormat)}
                    options={CHAT_FORMAT_OPTIONS}
                    ariaLabel="Chat format for the title model"
                    onChange={(v) => setTitleMaker({ localChatFormat: asChatFormat(v) })}
                    width={220}
                  />
                </SettingsRow>
              </>
            )}

            <SettingsRow
              last
              label="Status"
              hint={
                titleLocalReady
                  ? "Nothing leaves this computer — titles are written here."
                  : llamaDir.trim() === ""
                    ? "Set the llama.cpp folder under Prompt refine above. Titles share it."
                    : titleOwnModel
                      ? "Choose the .gguf file to write titles with."
                      : "Set a model under Prompt refine above, or pick a different one here."
              }
            >
              <AgwPill tone={titleLocalReady ? "success" : "warning"}>
                {titleLocalReady ? "Ready" : "Needs setup"}
              </AgwPill>
            </SettingsRow>
          </>
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
                  icon={showTitleKey ? "eye-off" : "eye"}
                  onClick={() => setShowTitleKey((v) => !v)}
                >
                  {showTitleKey ? "Hide" : "Show"}
                </AgwButton>
              </div>
            </SettingsRow>
          </>
        )}
      </SettingsSection>
      )}

      {shows("chat") && (
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
      )}

      {shows("chat") && (
      <SettingsSection
        icon="message"
        title="Transcript"
        description="How a reply is laid out as you read it. Everything here starts at the layout you have today."
      >
        <SettingsRow
          label="Timeline spine"
          hint="Draw one continuous line down the reply, with a marker beside each step, so a long turn reads as a single thread instead of a stack of separate cards."
        >
          <AgwSwitch
            checked={transcriptSpine}
            onChange={setTranscriptSpine}
            ariaLabel="Draw a timeline spine down the transcript"
          />
        </SettingsRow>

        <SettingsRow
          label="Keep the question on screen"
          hint="Pin your message to the top of the reply while the answer scrolls underneath it, so you can still see what you asked at the bottom of a long turn. The next question takes its place."
        >
          <AgwSwitch
            checked={transcriptStickyUser}
            onChange={setTranscriptStickyUser}
            ariaLabel="Pin the user message to the top while its reply scrolls"
          />
        </SettingsRow>

        <SettingsRow
          label="Reasoning"
          hint={
            transcriptReasoning === "hidden"
              ? "The model's reasoning isn't drawn. It still reasons, and the reply still shows it's working while it does."
              : transcriptReasoning === "folded"
                ? "Reasoning stays folded to its “Thought 12s” line, even while the model is thinking. Click the line to read it."
                : "Reasoning opens while the model is thinking and folds once it moves on. Click to open or fold it yourself."
          }
        >
          <AgwSegmented<TranscriptReasoning>
            value={transcriptReasoning}
            ariaLabel="How the model's reasoning is shown"
            options={[
              { value: "live", label: "Auto" },
              { value: "folded", label: "Folded" },
              { value: "hidden", label: "Hidden" },
            ]}
            onChange={setTranscriptReasoning}
          />
        </SettingsRow>

        <SettingsRow
          label="Smooth tool arrival"
          hint={
            reduceMotion
              ? "New tool calls appear without the fade because Reduce motion is on. A finished run still stays open for a moment before it folds."
              : "New tool calls fade in one after another instead of all landing at once, and a finished run stays open for a moment before it folds. Helps most with fast models that call several tools together."
          }
        >
          <AgwSwitch
            checked={transcriptSmoothTools}
            onChange={setTranscriptSmoothTools}
            ariaLabel="Fade tool calls in one after another"
          />
        </SettingsRow>

        <SettingsRow
          label="Text streaming"
          hint={
            transcriptTextPace === "steady"
              ? "Text moves at the speed the model writes it, evenly, a fifth of a second behind. A burst is spread out instead of jumping in."
              : transcriptTextPace === "instant"
                ? "Every piece of text appears the moment it arrives, with no smoothing."
                : "Text eases in: each burst rushes in, then slows as it catches up."
          }
        >
          <AgwSegmented<TranscriptTextPace>
            value={transcriptTextPace}
            ariaLabel="How streamed text is revealed"
            options={[
              { value: "eased", label: "Eased" },
              { value: "steady", label: "Steady" },
              { value: "instant", label: "Instant" },
            ]}
            onChange={setTranscriptTextPace}
          />
        </SettingsRow>

        <SettingsRow
          label="Keep tool runs open"
          hint="A run of three or more tool calls stays expanded after it finishes, instead of folding to its “5 calls · 5 done” line. Long runs scroll inside their own box, so the reply doesn't grow."
        >
          <AgwSwitch
            checked={transcriptToolRunsOpen}
            onChange={setTranscriptToolRunsOpen}
            ariaLabel="Keep finished tool runs expanded"
          />
        </SettingsRow>

        <SettingsRow
          label="Always show message actions"
          hint="Show Copy and Retry under each message at full strength. Off, they stay dimmed until you point at the message."
        >
          <AgwSwitch
            checked={transcriptActionsVisible}
            onChange={setTranscriptActionsVisible}
            ariaLabel="Always show Copy and Retry at full strength"
          />
        </SettingsRow>

        <SettingsRow
          label="Show reply times"
          hint="Show when each reply started, next to how long it took: “2:14 PM · Worked 4m”. Replies from earlier days include the date."
        >
          <AgwSwitch
            checked={transcriptTimestamps}
            onChange={setTranscriptTimestamps}
            ariaLabel="Show the time each reply started"
          />
        </SettingsRow>

        <SettingsRow
          label="Turn summary"
          hint="On the right of a finished reply's footer, across from Copy and Retry, say what the reply did: “3 files changed +148 −11 · 3 commands · 1,503 tokens generated”. Only replies that used tools, and only calls that succeeded, are counted."
        >
          <AgwSwitch
            checked={transcriptTurnSummary}
            onChange={setTranscriptTurnSummary}
            ariaLabel="Show a summary line under each finished reply"
          />
        </SettingsRow>

        <SettingsRow
          last
          alignTop
          label="Chapters"
          // Stated plainly, not hidden in a tooltip: this one asks something of
          // the agent, and a switch that quietly edits the agent's instructions
          // is a switch the user can't reason about.
          hint="Ask the agent to plan a long turn as named chapters — “Read the render path”, “Fix the join”, “Run the tests” — and announce each one as it starts. This adds two lines to the agent's instructions and gives it a tool to mark them, so it changes what the agent does, not just how it looks. Turns already in flight are unaffected."
        >
          <AgwSwitch
            checked={transcriptChapters}
            onChange={setTranscriptChapters}
            ariaLabel="Let the agent split long turns into chapters"
          />
        </SettingsRow>
      </SettingsSection>
      )}
      </div>
    </div>
  );
};
