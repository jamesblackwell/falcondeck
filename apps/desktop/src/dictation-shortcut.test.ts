import { describe, expect, it } from "vitest";

import {
  dictationShortcutFromEvent,
  dictationShortcutLabel,
  dictationShortcutValidation,
  isDictationHotkey,
  isModifierOnlyDictationShortcut,
  normalizeDictationShortcut,
} from "./dictation-shortcut";

describe("dictation shortcuts", () => {
  it("keeps the shipped modifier keys and accepts recorded chords", () => {
    expect(normalizeDictationShortcut("right_command")).toBe("right_command");
    expect(normalizeDictationShortcut("left_function")).toBe("left_function");
    expect(normalizeDictationShortcut("Mod+Shift+D")).toBe("Mod+Shift+D");
    expect(normalizeDictationShortcut("F13")).toBe("F13");
    expect(isDictationHotkey("caps_lock")).toBe(true);
    expect(isDictationHotkey("Mod+D")).toBe(true);
    expect(isModifierOnlyDictationShortcut("right_command")).toBe(true);
    expect(isModifierOnlyDictationShortcut("Mod+D")).toBe(false);
  });

  it("rejects empty, escape, and bare typing keys", () => {
    expect(normalizeDictationShortcut("")).toBeNull();
    expect(normalizeDictationShortcut("not-a-key")).toBe("not-a-key");
    expect(dictationShortcutValidation("Escape")).toMatch(/Escape/);
    expect(dictationShortcutValidation("D")).toMatch(/Command, Control, or Option/);
    expect(dictationShortcutValidation("Space")).toMatch(/Command, Control, or Option/);
    expect(isDictationHotkey("not-a-key")).toBe(true);
    expect(isDictationHotkey("Escape")).toBe(false);
    expect(isDictationHotkey("D")).toBe(false);
  });

  it("records right Command, fn, and chords from keyboard events", () => {
    expect(
      dictationShortcutFromEvent({
        key: "Meta",
        location: 2,
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        code: "MetaRight",
      }),
    ).toBe("right_command");
    expect(
      dictationShortcutFromEvent({
        key: "Meta",
        location: 1,
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        code: "MetaLeft",
      }),
    ).toBe("left_command");
    expect(
      dictationShortcutFromEvent({
        key: "Fn",
        location: 1,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        code: "Fn",
      }),
    ).toBe("left_function");
    expect(
      dictationShortcutFromEvent({
        key: "d",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
        code: "KeyD",
      }),
    ).toBe("Mod+Shift+D");
  });

  it("labels suggested keys in words and chords as keycaps", () => {
    expect(dictationShortcutLabel("right_command")).toBe("Right Command");
    expect(dictationShortcutLabel("Mod+Shift+D")).toBe("⌘⇧D");
  });
});
