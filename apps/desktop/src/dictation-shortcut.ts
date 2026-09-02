import {
  normalizeShortcut,
  shortcutFromEvent,
  shortcutTokens,
  type ShortcutKeyEvent,
} from "./shortcuts";

/** Side-specific modifiers the native tap can hold without typing a character. */
export const MODIFIER_ONLY_SHORTCUTS = [
  "right_command",
  "left_command",
  "left_function",
  "right_option",
  "left_option",
  "right_control",
  "left_control",
  "caps_lock",
] as const;

export type ModifierOnlyShortcut = (typeof MODIFIER_ONLY_SHORTCUTS)[number];

export type DictationHotkey = string;

export type DictationShortcutSuggestion = {
  id: ModifierOnlyShortcut;
  label: string;
};

export const DICTATION_SHORTCUT_SUGGESTIONS: readonly DictationShortcutSuggestion[] =
  [
    { id: "right_command", label: "Right Command" },
    { id: "left_function", label: "Left Function (fn)" },
  ];

export const REWRITE_SHORTCUT_SUGGESTIONS: readonly DictationShortcutSuggestion[] =
  [
    { id: "right_option", label: "Right Option" },
    { id: "right_command", label: "Right Command" },
    { id: "left_function", label: "Left Function (fn)" },
  ];

const MODIFIER_ONLY_SET = new Set<string>(MODIFIER_ONLY_SHORTCUTS);

const MODIFIER_ONLY_LABELS: Record<ModifierOnlyShortcut, string> = {
  right_command: "Right Command",
  left_command: "Left Command",
  left_function: "Left Function (fn)",
  right_option: "Right Option",
  left_option: "Left Option",
  right_control: "Right Control",
  left_control: "Left Control",
  caps_lock: "Caps Lock",
};

const MODIFIER_ONLY_TOKENS: Record<ModifierOnlyShortcut, string[]> = {
  right_command: ["Right", "⌘"],
  left_command: ["Left", "⌘"],
  left_function: ["fn"],
  right_option: ["Right", "⌥"],
  left_option: ["Left", "⌥"],
  right_control: ["Right", "⌃"],
  left_control: ["Left", "⌃"],
  caps_lock: ["Caps Lock"],
};

const LOCATION_RIGHT = 2;
const LOCATION_LEFT = 1;

export function isModifierOnlyDictationShortcut(
  value: string,
): value is ModifierOnlyShortcut {
  return MODIFIER_ONLY_SET.has(value);
}

export function dictationShortcutLabel(shortcut: string): string {
  if (isModifierOnlyDictationShortcut(shortcut)) {
    return MODIFIER_ONLY_LABELS[shortcut];
  }
  return dictationShortcutTokens(shortcut).join("");
}

export function dictationShortcutTokens(shortcut: string): string[] {
  if (isModifierOnlyDictationShortcut(shortcut)) {
    return MODIFIER_ONLY_TOKENS[shortcut];
  }
  return shortcutTokens(shortcut);
}

function isModifierKey(key: string): boolean {
  return (
    key === "Meta" ||
    key === "Control" ||
    key === "Alt" ||
    key === "Shift" ||
    key === "Fn" ||
    key === "CapsLock"
  );
}

function modifierOnlyFromEvent(
  event: ShortcutKeyEvent & { location?: number; code?: string },
): ModifierOnlyShortcut | null {
  const extraMeta =
    event.key !== "Meta" && Boolean(event.metaKey);
  const extraCtrl =
    event.key !== "Control" && Boolean(event.ctrlKey);
  const extraAlt = event.key !== "Alt" && Boolean(event.altKey);
  const extraShift = event.key !== "Shift" && Boolean(event.shiftKey);
  if (extraMeta || extraCtrl || extraAlt || extraShift) return null;

  const location = event.location ?? 0;
  const code = event.code ?? "";
  if (event.key === "Meta" || code === "MetaRight" || code === "MetaLeft") {
    return location === LOCATION_LEFT || code === "MetaLeft"
      ? "left_command"
      : "right_command";
  }
  if (event.key === "Alt" || code === "AltRight" || code === "AltLeft") {
    return location === LOCATION_LEFT || code === "AltLeft"
      ? "left_option"
      : "right_option";
  }
  if (
    event.key === "Control" ||
    code === "ControlRight" ||
    code === "ControlLeft"
  ) {
    return location === LOCATION_RIGHT || code === "ControlRight"
      ? "right_control"
      : "left_control";
  }
  if (event.key === "Fn" || code === "Fn" || code === "FnLeft") {
    return "left_function";
  }
  if (event.key === "CapsLock" || code === "CapsLock") {
    return "caps_lock";
  }
  return null;
}

export function dictationShortcutFromEvent(
  event: ShortcutKeyEvent & { location?: number; code?: string },
): string | null {
  if (isModifierKey(event.key) || event.key === "Fn") {
    return modifierOnlyFromEvent(event);
  }
  return shortcutFromEvent(event);
}

export function dictationShortcutValidation(shortcut: string): string | null {
  const normalized = normalizeDictationShortcut(shortcut);
  if (!normalized) {
    return "Press a shortcut, or pick Right Command or fn.";
  }
  const parts = normalized.split("+");
  const key = parts.at(-1) ?? "";
  if (key === "Escape" || normalized === "Escape") {
    return "Escape cancels dictation, so it cannot be the shortcut.";
  }
  if (isModifierOnlyDictationShortcut(normalized)) return null;
  if (!key || ["Mod", "Ctrl", "Alt", "Shift"].includes(key)) {
    return "Press a non-modifier key, or a single modifier such as Right Command.";
  }
  if (
    ((key.length === 1 && /[a-z0-9]/i.test(key)) || key === "Space") &&
    !parts.some((part) => part === "Mod" || part === "Ctrl" || part === "Alt")
  ) {
    return "Letter, number, and space shortcuts need Command, Control, or Option.";
  }
  return null;
}

export function normalizeDictationShortcut(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isModifierOnlyDictationShortcut(trimmed)) return trimmed;
  const normalized = normalizeShortcut(trimmed);
  if (!normalized) return null;
  if (isModifierOnlyDictationShortcut(normalized)) return normalized;
  const parts = normalized.split("+");
  const key = parts.at(-1) ?? "";
  if (!key || ["Mod", "Ctrl", "Alt", "Shift"].includes(key)) return null;
  return normalized;
}

export function isDictationHotkey(value: unknown): value is string {
  return (
    normalizeDictationShortcut(value) != null &&
    dictationShortcutValidation(String(value)) == null
  );
}
