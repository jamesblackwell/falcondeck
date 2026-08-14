import { describe, expect, it } from "vitest";

import {
  boundHandoffTranscript,
  buildHandoffPrompt,
  buildHandoffSeedPrompt,
  buildHandoffTranscript,
} from "./handoff";

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

  it("seeds the destination with the brief instead of the transcript", () => {
    const prompt = buildHandoffSeedPrompt({
      brief: "## Objective\nShip the handoff brief.",
      sourceProvider: "codex",
      sourceProviderLabel: "Codex",
    });

    expect(prompt).toContain("Ship the handoff brief.");
    expect(prompt).toContain("<handoff-brief>");
    // The brief is machine-written context, not a user instruction, and the
    // destination must not act on it before the user speaks.
    expect(prompt).toContain("not by the user");
    expect(prompt).toContain("Do not start editing files");
    expect(prompt).not.toContain("Some middle history was dropped");
  });

  it("warns the destination when compaction dropped middle history", () => {
    const prompt = buildHandoffSeedPrompt({
      brief: "## Objective\nShip it.",
      sourceProvider: "claude",
      sourceProviderLabel: "Claude Code",
      truncated: true,
    });

    expect(prompt).toContain("Some middle history was dropped");
  });

  it("hands the summarizer a far larger transcript than a turn could hold", () => {
    const items = Array.from({ length: 400 }, (_, index) => ({
      kind: "user_message" as const,
      id: `user-${index}`,
      text: "x".repeat(1_000),
      attachments: [],
      turn_id: null,
      previous_turn_id: null,
      created_at: "2026-08-12T12:00:00Z",
    }));

    const transcript = buildHandoffTranscript({
      items,
      sourceTitle: "Long session",
    });

    expect(transcript.length).toBeGreaterThan(300_000);
    expect(transcript).not.toContain("middle history omitted");
  });
});
