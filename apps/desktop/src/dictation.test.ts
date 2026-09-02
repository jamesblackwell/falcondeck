import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DICTATION_SETTINGS,
  DEFAULT_REWRITE_PROMPT,
  REWRITE_MODEL_CHOICES,
  nextRequiredDictationPermission,
  normalizeDictationSettings,
  normalizeRewritePrompt,
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
        shortcut: "Escape",
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

  it("persists a recorded chord as the dictation shortcut", () => {
    writeDictationSettings({
      ...DEFAULT_DICTATION_SETTINGS,
      shortcut: "Mod+Shift+D",
      rewriteShortcut: "F13",
    });
    expect(readDictationSettings().shortcut).toBe("Mod+Shift+D");
    expect(readDictationSettings().rewriteShortcut).toBe("F13");
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

  it("defaults voice rewrite off with Right Option and GPT-5.6 Luna", () => {
    const upgraded = normalizeDictationSettings({ enabled: true });
    expect(upgraded.rewriteEnabled).toBe(false);
    expect(upgraded.rewriteShortcut).toBe("right_option");
    expect(upgraded.rewriteModel).toBe("openai/gpt-5.6-luna");
    expect(
      normalizeDictationSettings({
        ...DEFAULT_DICTATION_SETTINGS,
        rewriteEnabled: true,
        rewriteShortcut: "right_command",
        rewriteModel: "openai/gpt-5.6-terra",
      }),
    ).toMatchObject({
      rewriteEnabled: true,
      rewriteShortcut: "right_command",
      rewriteModel: "openai/gpt-5.6-terra",
    });
    expect(upgraded.rewritePrompt).toBeNull();
  });

  it("treats the built-in rewrite prompt as unset", () => {
    expect(normalizeRewritePrompt(null)).toBeNull();
    expect(normalizeRewritePrompt("")).toBeNull();
    expect(normalizeRewritePrompt(`  ${DEFAULT_REWRITE_PROMPT}  `)).toBeNull();
    expect(normalizeRewritePrompt("Return only the rewritten text.")).toBe(
      "Return only the rewritten text.",
    );
    expect(DEFAULT_REWRITE_PROMPT).toContain("generic LLM prose");
    expect(DEFAULT_REWRITE_PROMPT).toContain(
      "Do not even the prose out into uniform polish",
    );
  });

  it("persists a custom rewrite prompt and restores the built-in one", () => {
    writeDictationSettings({
      ...DEFAULT_DICTATION_SETTINGS,
      rewritePrompt: "Return only the rewritten text.",
    });
    expect(readDictationSettings().rewritePrompt).toBe(
      "Return only the rewritten text.",
    );
    writeDictationSettings({
      ...readDictationSettings(),
      rewritePrompt: DEFAULT_REWRITE_PROMPT,
    });
    expect(readDictationSettings().rewritePrompt).toBeNull();
  });

  it("truncates an oversized rewrite prompt", () => {
    expect(normalizeRewritePrompt("a".repeat(8_001))?.length).toBe(8_000);
  });

  it("offers gpt-oss-120b among the fast rewrite models", () => {
    expect(REWRITE_MODEL_CHOICES.map((model) => model.id)).toEqual(
      expect.arrayContaining([
        "openai/gpt-5.6-luna",
        "openai/gpt-oss-120b",
        "openai/gpt-oss-20b",
        "google/gemma-4-31b-it",
        "inception/mercury-2",
        "google/gemini-3.5-flash-lite",
      ]),
    );
  });

  it("gives settings saved before history a fallback model and a retention window", () => {
    const upgraded = normalizeDictationSettings({ enabled: true });
    expect(upgraded.fallbackModel).toBe(
      DEFAULT_DICTATION_SETTINGS.fallbackModel,
    );
    expect(upgraded.historyRetentionHours).toBe(
      DEFAULT_DICTATION_SETTINGS.historyRetentionHours,
    );
  });

  it("defaults the fallback model to a different vendor from the primary one", () => {
    const vendor = (model: string | null) => model?.split("/")[0];
    expect(vendor(DEFAULT_DICTATION_SETTINGS.fallbackModel)).not.toBe(
      vendor(DEFAULT_DICTATION_SETTINGS.model),
    );
  });

  it("keeps an explicit choice of no fallback model", () => {
    expect(
      normalizeDictationSettings({
        ...DEFAULT_DICTATION_SETTINGS,
        fallbackModel: null,
      }).fallbackModel,
    ).toBeNull();
    // An unusable value is not a choice, so the default comes back.
    expect(
      normalizeDictationSettings({
        ...DEFAULT_DICTATION_SETTINGS,
        fallbackModel: "   ",
      }).fallbackModel,
    ).toBe(DEFAULT_DICTATION_SETTINGS.fallbackModel);
  });

  it("bounds how long recordings can be kept", () => {
    const retention = (value: unknown) =>
      normalizeDictationSettings({
        ...DEFAULT_DICTATION_SETTINGS,
        historyRetentionHours: value as number,
      }).historyRetentionHours;
    expect(retention(0)).toBe(0);
    expect(retention(24)).toBe(24);
    expect(retention(1000)).toBe(24);
    expect(retention(-5)).toBe(DEFAULT_DICTATION_SETTINGS.historyRetentionHours);
    expect(retention("6")).toBe(DEFAULT_DICTATION_SETTINGS.historyRetentionHours);
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
