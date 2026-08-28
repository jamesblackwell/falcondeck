import { describe, expect, it } from "vitest";

import { deriveConversationPresentation } from "./conversation";
import {
  projectHarnessUserItems,
  projectHarnessUserText,
} from "./harness-user-text";
import { normalizePreferences } from "./normalization";
import type { ConversationItem } from "./types";

const createdAt = "2026-08-26T10:00:00Z";

describe("projectHarnessUserText", () => {
  it("unwraps the typed Grok prompt from surrounding context blocks", () => {
    expect(
      projectHarnessUserText(
        "<user_info>OS: macos</user_info>\n<user_query>\nwhy does steering fail?\n</user_query>\n<system-reminder>be nice</system-reminder>",
      ),
    ).toEqual({ kind: "prompt", text: "why does steering fail?" });
  });

  it("projects a shutdown resume as a quiet receipt", () => {
    expect(
      projectHarnessUserText(
        "<system-reminder>\nFalconDeck resume: The previous turn was interrupted because FalconDeck closed. Continue the work from where you left off.\n</system-reminder>",
      ),
    ).toEqual({
      kind: "service",
      level: "info",
      message: "Resumed after FalconDeck closed",
    });
  });

  it("hides skill catalogues and MCP connection plumbing", () => {
    expect(
      projectHarnessUserText(
        "<system-reminder>\nThe following skills are available for use:\n- ntfy\n</system-reminder>",
      ),
    ).toEqual({ kind: "hidden" });
    expect(
      projectHarnessUserText(
        "<system-reminder>\nMCP servers connected:\n- tasks (9 tools)\n</system-reminder>",
      ),
    ).toEqual({ kind: "hidden" });
  });

  it("turns a background-task reminder into a quiet receipt", () => {
    expect(
      projectHarnessUserText(
        `<system-reminder>
Background task "01a03c98-db41-7653-8dc8-6e7766d06c2b" completed (exit code: 1).
Command: python3 -m http.server 8765 --bind 127.0.0.1 | Duration: 0.4s
Use get_command_or_subagent_output("01a03c98-db41-7653-8dc8-6e7766d06c2b") to see the full output.
</system-reminder>`,
      ),
    ).toEqual({
      kind: "service",
      level: "warning",
      message:
        "Background command failed (exit 1) · python3 -m http.server 8765 --bind 127.0.0.1 · 0.4s",
    });
    expect(
      projectHarnessUserText(
        '<system-reminder>Background task "abc" completed (exit code: 0).\nCommand: sleep 1</system-reminder>',
      ),
    ).toEqual({
      kind: "service",
      level: "info",
      message: "Background command finished · sleep 1",
    });
  });

  it("keeps ordinary prompts and Claude interrupt bookkeeping out of the bubble", () => {
    expect(projectHarnessUserText("fix the login bug")).toEqual({
      kind: "prompt",
      text: "fix the login bug",
    });
    expect(
      projectHarnessUserText(
        "<command-name>/clear</command-name>\n<command-message>clear</command-message>",
      ),
    ).toEqual({ kind: "hidden" });
    expect(
      projectHarnessUserText("[Request interrupted by user]"),
    ).toEqual({ kind: "hidden" });
  });

  it("waits for a complete injected tag before projecting", () => {
    expect(
      projectHarnessUserText("<system-reminder>Background task still arriving"),
    ).toEqual({ kind: "incomplete" });
  });

  it("unwraps FalconDeck skill file-reference wrappers to the typed prompt", () => {
    const preamble =
      "Use the FalconDeck skill defined at /Users/James/www/sites/falcondeck/.agents/skills/tldr/SKILL.md. Follow it as the governing skill for this request.";
    expect(projectHarnessUserText(`${preamble}\n\n/tldr`)).toEqual({
      kind: "prompt",
      text: "/tldr",
    });
    expect(
      projectHarnessUserText(`${preamble}\n\n/tldr summarise the last turn`),
    ).toEqual({
      kind: "prompt",
      text: "/tldr summarise the last turn",
    });
    expect(projectHarnessUserText(preamble)).toEqual({ kind: "hidden" });
    expect(
      projectHarnessUserText(
        "Use the FalconDeck skill defined at /tmp/tldr/SKILL.md. Follow it as the governing skill",
      ),
    ).toEqual({ kind: "incomplete" });
  });

  it("unwraps named and stacked skill preambles", () => {
    expect(
      projectHarnessUserText(
        "Apply the FalconDeck skill named 'Review' to this request.\n\nplease review",
      ),
    ).toEqual({ kind: "prompt", text: "please review" });
    expect(
      projectHarnessUserText(
        "Use the FalconDeck skill defined at /tmp/review/SKILL.md. Follow it as the governing skill for this request.\nApply the FalconDeck skill named 'Review' to this request.\n\n/review",
      ),
    ).toEqual({ kind: "prompt", text: "/review" });
  });
});

describe("projectHarnessUserItems", () => {
  it("returns the same array when no user item needs rewriting", () => {
    const items: ConversationItem[] = [
      {
        kind: "user_message",
        id: "user-1",
        text: "hello",
        attachments: [],
        created_at: createdAt,
      },
    ];
    expect(projectHarnessUserItems(items)).toBe(items);
  });

  it("rewrites FalconDeck skill file-reference wrappers before grouping", () => {
    const items: ConversationItem[] = [
      {
        kind: "user_message",
        id: "user-typed",
        text: "/tldr",
        attachments: [],
        created_at: createdAt,
      },
      {
        kind: "user_message",
        id: "user-echo",
        text: "Use the FalconDeck skill defined at /tmp/tldr/SKILL.md. Follow it as the governing skill for this request.\n\n/tldr",
        attachments: [],
        created_at: createdAt,
      },
    ];
    expect(projectHarnessUserItems(items)).toEqual([items[0]]);
  });

  it("drops a skill-preamble echo that arrives after thoughts", () => {
    const items: ConversationItem[] = [
      {
        kind: "user_message",
        id: "user-typed",
        text: "/tldr",
        attachments: [],
        created_at: createdAt,
      },
      {
        kind: "reasoning",
        id: "thought-1",
        summary: null,
        content: "I'll summarise.",
        lifecycle: "streaming",
        created_at: createdAt,
      },
      {
        kind: "user_message",
        id: "user-echo",
        text: "Use the FalconDeck skill defined at /tmp/tldr/SKILL.md. Follow it as the governing skill for this request.\n\n/tldr",
        attachments: [],
        created_at: createdAt,
      },
    ];
    expect(projectHarnessUserItems(items)).toEqual([items[0], items[1]]);
  });

  it("keeps a skill-wrapped prompt when it is the only copy", () => {
    const items: ConversationItem[] = [
      {
        kind: "user_message",
        id: "user-echo",
        text: "Use the FalconDeck skill defined at /tmp/tldr/SKILL.md. Follow it as the governing skill for this request.\n\n/tldr",
        attachments: [],
        created_at: createdAt,
      },
    ];
    expect(projectHarnessUserItems(items)).toEqual([
      {
        ...items[0],
        text: "/tldr",
      },
    ]);
  });

  it("keeps an image-only user message instead of dropping it as hidden", () => {
    const items: ConversationItem[] = [
      {
        kind: "user_message",
        id: "user-image",
        text: "",
        attachments: [
          {
            type: "image",
            id: "img-1",
            name: "shot.png",
            mime_type: "image/png",
            url: "data:image/png;base64,aGVsbG8=",
            local_path: null,
          },
        ],
        created_at: createdAt,
      },
    ];
    expect(projectHarnessUserItems(items)).toEqual([
      {
        ...items[0],
        text: "",
      },
    ]);
  });

  it("rewrites injected user items before conversation grouping", () => {
    const items: ConversationItem[] = [
      {
        kind: "user_message",
        id: "user-query",
        text: "<user_query>ship it</user_query>",
        attachments: [],
        created_at: createdAt,
      },
      {
        kind: "user_message",
        id: "user-task",
        text: '<system-reminder>Background task "x" completed (exit code: 1).\nCommand: python3 -m http.server 8765 --bind 127.0.0.1 | Duration: 0.4s</system-reminder>',
        attachments: [],
        created_at: createdAt,
      },
      {
        kind: "user_message",
        id: "user-skills",
        text: "<system-reminder>The following skills are available for use:</system-reminder>",
        attachments: [],
        created_at: createdAt,
      },
    ];
    const presentation = deriveConversationPresentation(
      items,
      normalizePreferences(null),
    );
    expect(
      presentation.history_blocks.map((block) =>
        block.kind === "item" ? block.item : block,
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "user_message",
        id: "user-query",
        text: "ship it",
      }),
      expect.objectContaining({
        kind: "service",
        id: "user-task",
        level: "warning",
        message:
          "Background command failed (exit 1) · python3 -m http.server 8765 --bind 127.0.0.1 · 0.4s",
      }),
    ]);
  });
});
