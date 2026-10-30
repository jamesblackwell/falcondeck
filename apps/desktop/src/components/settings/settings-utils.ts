import type {
  RemoteStatusResponse,
  ThinkingDisplay,
  ToolDetailsMode,
  TrustedDevice,
} from "@falcondeck/client-core";
import {
  Archive,
  Bell,
  Blocks,
  Bot,
  ChartColumn,
  KeyRound,
  Keyboard,
  MessagesSquare,
  Mic,
  Monitor,
  Palette,
  Plug,
  Server,
  Settings,
  ShieldCheck,
  Terminal,
  Wifi,
} from "lucide-react";

import type { AppUpdaterState } from "../../hooks/useAppUpdater";

export type SettingsSectionId =
  | "general"
  | "appearance"
  | "notifications"
  | "conversations"
  | "keyboard"
  | "extensions"
  | "agents"
  | "harnesses"
  | "connectors"
  | "agent-control"
  | "computer-use"
  | "speech"
  | "models"
  | "remote"
  | "servers"
  | "analytics"
  | "backup";

/** DOM id of the settings search field, so ⌘F can focus it from the app. */
export const SETTINGS_SEARCH_INPUT_ID = "settings-search";

export type SettingsNavItem = {
  id: SettingsSectionId;
  label: string;
  description: string;
  icon: typeof Settings;
  /** Setting titles on the page, so search can land on the right one. Keep
   * them identical to the on-page titles: search scrolls to the exact text. */
  settings: string[];
  /** Extra words people might type that do not appear as a title. */
  keywords?: string[];
};

export type SettingsNavGroup = {
  label: string;
  items: SettingsNavItem[];
};

export const SETTINGS_GROUPS: SettingsNavGroup[] = [
  {
    label: "App",
    items: [
      {
        id: "general",
        label: "General",
        description: "Startup, updates, and onboarding",
        icon: Settings,
        settings: [
          "Automatically continue stopped sessions",
          "Updates",
          "First-run onboarding",
        ],
        keywords: ["version", "release", "resume", "restart", "welcome"],
      },
      {
        id: "appearance",
        label: "Appearance",
        description: "Theme, fonts, and text size",
        icon: Palette,
        settings: ["Theme and type"],
        keywords: ["dark", "light", "font", "palette", "colour", "color", "text size"],
      },
      {
        id: "notifications",
        label: "Notifications",
        description: "Alerts and sounds",
        icon: Bell,
        settings: [
          "Agent attention notifications",
          "Completed turns",
          "Approvals and questions",
          "Failed turns",
          "Only push when away from desktop",
          "Play a sound when a turn finishes",
        ],
        keywords: ["push", "phone", "chime", "alert", "sound"],
      },
      {
        id: "conversations",
        label: "Conversations",
        description: "Follow-ups, tool detail, and thinking",
        icon: MessagesSquare,
        settings: [
          "Running follow-ups",
          "Tool detail",
          "Thinking",
          "Group read-only tool bursts",
          "Collapse long messages you send",
          "Show expand/collapse all controls",
          "Auto-open approvals",
          "Auto-open errors",
          "Auto-open failed tests",
          "Auto-open the first diff",
        ],
        keywords: ["queue", "steer", "density", "reasoning", "transcript", "expand"],
      },
      {
        id: "keyboard",
        label: "Keyboard shortcuts",
        description: "Customize every command",
        icon: Keyboard,
        settings: [],
        keywords: ["hotkey", "keybinding", "shortcut"],
      },
      {
        id: "extensions",
        label: "Extensions",
        description: "Add capabilities to FalconDeck",
        icon: Blocks,
        settings: [],
        keywords: ["plugins", "notes", "tags"],
      },
    ],
  },
  {
    label: "Agents",
    items: [
      {
        id: "agents",
        label: "Agents",
        description: "Status, built-in, and custom ACP agents",
        icon: Bot,
        settings: ["Status on this computer", "Built in", "Recommended"],
        keywords: ["acp", "claude", "codex", "opencode", "grok", "cursor", "provider"],
      },
      {
        id: "harnesses",
        label: "Harnesses",
        description: "CLI installs, versions, and upgrades",
        icon: Terminal,
        settings: [],
        keywords: ["cli", "upgrade", "install", "version"],
      },
      {
        id: "connectors",
        label: "Connectors",
        description: "MCP servers and agent tools",
        icon: Plug,
        settings: ["MCP servers"],
        keywords: ["mcp", "tools"],
      },
      {
        id: "agent-control",
        label: "Agent control",
        description: "What agents may do in FalconDeck",
        icon: ShieldCheck,
        settings: [
          "Agent control enabled",
          "Inject FalconDeck agent context",
          "Scheduling defaults",
          "Allow elevated automations",
          "Confirmation preferences",
          "Recent control changes",
        ],
        keywords: ["automations", "schedule", "permissions", "mcp"],
      },
      {
        id: "computer-use",
        label: "Computer use",
        description: "Let agents operate apps on this Mac",
        icon: Monitor,
        settings: [
          "Allow agents to use this Mac",
          "Show the agent cursor",
          "Agent browser",
          "Allow agents to use my personal Chrome profile",
        ],
        keywords: ["cua", "browser", "chrome", "sign in", "login", "accessibility", "screen recording"],
      },
    ],
  },
  {
    label: "Voice & AI",
    items: [
      {
        id: "speech",
        label: "Voice",
        description: "Dictation, transcription, and rewrite",
        icon: Mic,
        settings: [
          "Desktop dictation",
          "System-wide dictation",
          "Re-paste last transcript with ⌘⇧V",
          "Correction dictionary",
          "Transcription",
          "Automatically clean up transcriptions",
          "Voice rewrite",
          "Recording history",
        ],
        keywords: ["speech", "microphone", "parakeet", "apple speech", "openrouter", "cleanup", "dictate"],
      },
      {
        id: "models",
        label: "Models & keys",
        description: "OpenRouter key and thread titles",
        icon: KeyRound,
        settings: ["OpenRouter", "Title style", "Suggest title", "Automatic titles"],
        keywords: ["api key", "rename", "title prompt", "utility model", "background model"],
      },
    ],
  },
  {
    label: "Devices & data",
    items: [
      {
        id: "remote",
        label: "Remote access",
        description: "Pairing, devices, and relay status",
        icon: Wifi,
        settings: ["Pair a new device", "Trusted devices", "Connection status"],
        keywords: ["mobile", "iphone", "phone", "relay", "qr"],
      },
      {
        id: "servers",
        label: "Servers",
        description: "Run agents on remote machines",
        icon: Server,
        settings: [],
        keywords: ["ssh", "remote host", "daemon"],
      },
      {
        id: "analytics",
        label: "Analytics",
        description: "Agent communication and your message history",
        icon: ChartColumn,
        settings: [
          "Overview",
          "Who drives the work",
          "Waiting on you",
          "Agent communication",
          "Your messages",
          "Files agents write",
          "Turns by bot",
          "Scheduled tasks",
          "Recording",
          "Record activity",
          "Keep your messages",
          "Keep activity for",
          "Storage",
        ],
        keywords: ["stats", "metrics", "prompts", "history", "log", "chatter", "tokens", "files"],
      },
      {
        id: "backup",
        label: "Backup & data",
        description: "Export, import, and reset app state",
        icon: Archive,
        settings: ["Export backup", "Import backup", "Clean slate for testing"],
        keywords: ["restore", "archive", "reset"],
      },
    ],
  },
];

export const SETTINGS_NAV: SettingsNavItem[] = SETTINGS_GROUPS.flatMap(
  (group) => group.items,
);

export type SettingsSearchResult = {
  item: SettingsNavItem;
  /** On-page setting titles that matched; empty when only the page matched. */
  matches: string[];
};

/** Every query word must start a word in the page's text or a setting, so
 * "clean up" finds cleanup settings without matching "backup". */
export function searchSettings(query: string): SettingsSearchResult[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map(
      (word) =>
        new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u"),
    );
  if (words.length === 0) return [];
  const hits = (text: string) =>
    words.every((word) => word.test(text.toLowerCase()));
  return SETTINGS_NAV.flatMap((item) => {
    const matches = item.settings.filter(hits);
    const pageText = [
      item.label,
      item.description,
      ...(item.keywords ?? []),
      ...item.settings,
    ].join(" ");
    return matches.length > 0 || hits(pageText) ? [{ item, matches }] : [];
  });
}

export const TOOL_DETAIL_OPTIONS: Array<{
  value: ToolDetailsMode;
  label: string;
  description: string;
}> = [
  {
    value: "collapsed",
    label: "Hidden",
    description:
      'Fold tool activity behind a single "Worked for…" line, expandable on click. The default.',
  },
  {
    value: "auto",
    label: "Auto",
    description:
      "Collapse repeated read-only tool chatter, but auto-open diffs, approvals, and failures.",
  },
  {
    value: "expanded",
    label: "Expanded",
    description:
      "Keep tool output open by default for dense debugging sessions.",
  },
  {
    value: "compact",
    label: "Compact",
    description:
      "Prefer grouped summaries for read-only work while keeping artifacts visible.",
  },
  {
    value: "hide_read_only_details",
    label: "Hide read-only details",
    description:
      "Show grouped summaries for read-only inspection without rendering their raw output.",
  },
];

export const THINKING_DISPLAY_OPTIONS: Array<{
  value: ThinkingDisplay;
  label: string;
  description: string;
}> = [
  {
    value: "auto",
    label: "Auto",
    description:
      "Expand the thought while it streams, then collapse it when it ends — unless you opened it yourself. The default.",
  },
  {
    value: "preview",
    label: "Preview",
    description:
      "Keep a few faded lines of every thought visible; click to read the rest.",
  },
  {
    value: "always_expanded",
    label: "Always expanded",
    description:
      "Show reasoning in full, for following exactly how the agent got there.",
  },
  {
    value: "always_collapsed",
    label: "Always collapsed",
    description: "Keep every thought behind its own line until you ask for it.",
  },
];

export function statusVariant(
  status: RemoteStatusResponse["status"] | TrustedDevice["status"],
) {
  switch (status) {
    case "connected":
    case "device_trusted":
    case "active":
      return "success";
    case "pairing_pending":
    case "connecting":
    case "degraded":
    case "offline":
      return "warning";
    case "revoked":
      return "danger";
    default:
      return "default";
  }
}

export function statusLabel(
  status: RemoteStatusResponse["status"] | TrustedDevice["status"],
) {
  switch (status) {
    case "pairing_pending":
      return "Waiting for device";
    case "device_trusted":
      return "Trusted";
    case "connecting":
      return "Connecting";
    case "connected":
      return "Connected";
    case "degraded":
      return "Reconnecting";
    case "offline":
      return "Offline";
    case "revoked":
      return "Revoked";
    case "active":
      return "Active";
    case "error":
      return "Error";
    case "inactive":
    default:
      return "Inactive";
  }
}

export function formatDateTime(value: string | null) {
  if (!value) return "Never";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export function formatRelative(value: string | null) {
  if (!value) return "Never";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return formatDateTime(value);

  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const absSeconds = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  if (absSeconds < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  return formatter.format(days, "day");
}

export function isMobileDeviceLabel(label: string | null) {
  const normalized = label?.toLowerCase() ?? "";
  return (
    normalized.includes("iphone") ||
    normalized.includes("ipad") ||
    normalized.includes("android")
  );
}

export function updateBadgeVariant(status: AppUpdaterState["status"]) {
  switch (status) {
    case "available":
    case "downloaded":
      return "warning";
    case "upToDate":
      return "success";
    case "error":
      return "danger";
    default:
      return "default";
  }
}

export function updateStatusLabel(status: AppUpdaterState["status"]) {
  switch (status) {
    case "checking":
      return "Checking";
    case "available":
      return "Update available";
    case "downloading":
      return "Downloading";
    case "downloaded":
      return "Ready to restart";
    case "upToDate":
      return "Up to date";
    case "error":
      return "Needs attention";
    case "unsupported":
      return "Unavailable";
    default:
      return "Idle";
  }
}
