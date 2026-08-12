import { describe, expect, it } from "vitest";

import { boundHandoffTranscript, buildHandoffPrompt } from "./handoff";

describe("handoff context", () => {
  it("keeps the beginning and recent tail when bounding a long transcript", () => {
    const transcript = `objective:${"a".repeat(200)}recent:${"b".repeat(40)}`;
    const bounded = boundHandoffTranscript(transcript, 180);

    expect(bounded).toContain("objective:");
    expect(bounded).toContain("recent:");
    expect(bounded).toContain("middle history omitted");
    expect(bounded.length).toBeLessThanOrEqual(180);
  });

  it("asks the destination harness to compact without touching the source", () => {
    const prompt = buildHandoffPrompt({
      items: [
        {
          kind: "user_message",
          id: "user-1",
          text: "Keep the old thread unchanged",
          attachments: [],
          turn_id: null,
          previous_turn_id: null,
          created_at: "2026-08-12T12:00:00Z",
        },
      ],
      sourceTitle: "Session handoff",
      sourceProvider: "codex",
      sourceProviderLabel: "Codex",
    });

    expect(prompt).toContain("original thread remains unchanged");
    expect(prompt).toContain("Do not invoke tools or modify files");
    expect(prompt).toContain("Keep the old thread unchanged");
  });
});
