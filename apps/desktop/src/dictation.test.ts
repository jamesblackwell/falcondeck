import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DICTATION_SETTINGS,
  nextRequiredDictationPermission,
  normalizeDictationSettings,
  readDictationSettings,
  useDictationSettings,
  writeDictationSettings,
} from "./dictation";

describe("dictation settings", () => {
  afterEach(() => window.localStorage.clear());

  it("falls back field-by-field when stored settings are invalid", () => {
    expect(
      normalizeDictationSettings({
        enabled: true,
        shortcut: "caps_lock",
        activation: "toggle",
        provider: "system",
        inputDeviceId: 42,
        model: "",
      }),
    ).toEqual({
      ...DEFAULT_DICTATION_SETTINGS,
      enabled: true,
      activation: "toggle",
    });
  });

  it("persists normalized settings", () => {
    writeDictationSettings({
      ...DEFAULT_DICTATION_SETTINGS,
      enabled: true,
      shortcut: "left_function",
      inputDeviceId: "studio-display-microphone",
    });
    expect(readDictationSettings()).toEqual({
      ...DEFAULT_DICTATION_SETTINGS,
      enabled: true,
      shortcut: "left_function",
      inputDeviceId: "studio-display-microphone",
    });
  });

  it("upgrades old default models found under the v1 storage key", () => {
    window.localStorage.setItem(
      "falcondeck.desktop.dictation.v1",
      JSON.stringify({
        ...DEFAULT_DICTATION_SETTINGS,
        model: "openai/whisper-large-v3-turbo",
        shortcut: "left_function",
      }),
    );
    const migrated = readDictationSettings();
    expect(migrated.model).toBe(DEFAULT_DICTATION_SETTINGS.model);
    // Other choices survive the migration untouched.
    expect(migrated.shortcut).toBe("left_function");
  });

  it("keeps a model picked explicitly under the v2 storage key", () => {
    writeDictationSettings({
      ...DEFAULT_DICTATION_SETTINGS,
      model: "openai/whisper-large-v3-turbo",
    });
    expect(readDictationSettings().model).toBe(
      "openai/whisper-large-v3-turbo",
    );
  });

  it("preserves a deliberately chosen v1 model through the migration", () => {
    window.localStorage.setItem(
      "falcondeck.desktop.dictation.v1",
      JSON.stringify({
        ...DEFAULT_DICTATION_SETTINGS,
        model: "mistralai/voxtral-mini-transcribe",
      }),
    );
    expect(readDictationSettings().model).toBe(
      "mistralai/voxtral-mini-transcribe",
    );
  });

  it("enables the transcript re-paste shortcut for settings saved before it existed", () => {
    expect(
      normalizeDictationSettings({ enabled: true }).repasteShortcutEnabled,
    ).toBe(true);
    expect(
      normalizeDictationSettings({
        ...DEFAULT_DICTATION_SETTINGS,
        repasteShortcutEnabled: false,
      }).repasteShortcutEnabled,
    ).toBe(false);
  });

  it("updates subscribers in the same window", () => {
    const { result } = renderHook(() => useDictationSettings());
    act(() => {
      writeDictationSettings({
        ...DEFAULT_DICTATION_SETTINGS,
        enabled: true,
      });
    });
    expect(result.current.enabled).toBe(true);
  });

  it("requests dictation permissions one at a time in setup order", () => {
    const initial = {
      microphone: "not_requested" as const,
      speechRecognition: "not_requested" as const,
      accessibility: false,
      supported: true,
    };
    expect(nextRequiredDictationPermission(initial, "system")).toBe(
      "microphone",
    );
    expect(
      nextRequiredDictationPermission(
        { ...initial, microphone: "granted" },
        "system",
      ),
    ).toBe("speech_recognition");
    expect(
      nextRequiredDictationPermission(
        {
          ...initial,
          microphone: "granted",
          speechRecognition: "granted",
        },
        "system",
      ),
    ).toBe("accessibility");
    expect(
      nextRequiredDictationPermission(
        { ...initial, microphone: "granted", accessibility: true },
        "open_router",
      ),
    ).toBeNull();
  });
});
