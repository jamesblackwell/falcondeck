import { describe, expect, it } from "vitest";

import {
  draftWithProvider,
  emptyAutomationDraft,
} from "./automation-draft";

describe("draftWithProvider", () => {
  it("clears a managed thread id when the provider changes", () => {
    const draft = {
      ...emptyAutomationDraft(null),
      provider: "grok",
      threadKind: "managed" as const,
      threadId: "grok-thread-abc",
    };
    expect(draftWithProvider(draft, "codex")).toMatchObject({
      provider: "codex",
      threadId: "",
    });
    expect(draftWithProvider(draft, "grok").threadId).toBe("grok-thread-abc");
  });

  it("keeps an explicitly selected existing thread", () => {
    const draft = {
      ...emptyAutomationDraft(null),
      provider: "grok",
      threadKind: "existing" as const,
      threadId: "grok-thread-abc",
    };
    expect(draftWithProvider(draft, "claude").threadId).toBe("grok-thread-abc");
  });
});
