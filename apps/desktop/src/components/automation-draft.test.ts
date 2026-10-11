import { describe, expect, it } from "vitest";

import {
  automationDraftArguments,
  draftIsSubmittable,
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

describe("draftIsSubmittable", () => {
  const ready = {
    ...emptyAutomationDraft(null, "/tmp/project"),
    name: "Inbox",
    instruction: "Review it",
  };

  it("rejects interval text that is not a whole number of seconds", () => {
    const message = "Intervals must be a whole number of at least 60 seconds.";
    for (const everySeconds of ["not-a-number", "30", "60.5", "Infinity", "1e21"]) {
      const draft = { ...ready, scheduleKind: "interval" as const, everySeconds };
      expect(draftIsSubmittable(draft)).toBe(message);
      expect(() => automationDraftArguments(draft)).toThrow(message);
    }
  });

  it("sends an exact integer interval, including other spellings of one", () => {
    for (const [everySeconds, every_seconds] of [
      [" 3600 ", 3600],
      ["60.0", 60],
      ["1e3", 1000],
    ] as const) {
      const draft = {
        ...ready,
        scheduleKind: "interval" as const,
        everySeconds,
        anchorAt: "2026-08-20T08:00:00Z",
      };
      expect(draftIsSubmittable(draft)).toBeNull();
      expect(automationDraftArguments(draft)).toMatchObject({
        trigger: { kind: "interval", every_seconds, anchor_at: "2026-08-20T08:00:00Z" },
      });
    }
  });

  it("requires a cron timezone and an existing thread id", () => {
    expect(draftIsSubmittable({ ...ready, timezone: " " })).toBe("A timezone is required.");
    expect(
      draftIsSubmittable({ ...ready, threadKind: "existing", threadId: " " }),
    ).toBe("An existing thread id is required.");
  });
});
