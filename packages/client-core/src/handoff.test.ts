import { describe, expect, it } from "vitest";

import { boundHandoffTranscript, buildHandoffPrompt } from "./handoff";

describe("handoff context", () => {
  it("keeps a transcript that fits verbatim", () => {
    const transcript = `objective:${"a".repeat(200)}`;
    expect(boundHandoffTranscript(transcript, 10_000)).toBe(transcript);
  });

  it("keeps the beginning and recent tail when bounding a long transcript", () => {
    const transcript = `objective:${"a".repeat(4_000)}middle:${"m".repeat(4_000)}recent:${"b".repeat(800)}`;
    const bounded = boundHandoffTranscript(transcript, 2_000);

    expect(bounded).toContain("objective:");
    expect(bounded).toContain("recent:");
    expect(bounded).not.toContain("middle:");
    expect(bounded.length).toBeLessThanOrEqual(2_000);
  });

  it("states exactly how much middle history was omitted", () => {
    const transcript = `head:${"a".repeat(4_000)}${"m".repeat(4_000)}tail:${"b".repeat(800)}`;
    const bounded = boundHandoffTranscript(transcript, 2_000);

    const marker = bounded.match(/\[Omitted [^\]]+\]/);
    expect(marker).not.toBeNull();
    const omitted = Number(
      marker![0].match(/Omitted ([\d,]+) characters/)![1].replace(/,/g, ""),
    );
    const head = bounded.slice(0, bounded.indexOf(marker![0]));
    const tail = bounded.slice(bounded.indexOf(marker![0]) + marker![0].length);
    expect(head).toContain("head:");
    expect(tail).toContain("tail:");
    // The marker carries its own surrounding blank lines; discount them.
    const kept = head.length - 2 + (tail.length - 2);
    expect(omitted).toBe(transcript.length - kept);
    expect(bounded).toContain("original session is unchanged");
  });

  it("keeps the opening verbatim when even the marker cannot fit", () => {
    const transcript = "a".repeat(5_000);
    const bounded = boundHandoffTranscript(transcript, 200);
    expect(bounded).toBe("a".repeat(200));
  });

  it("hands the destination the verbatim transcript without touching the source", () => {
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
    });

    expect(prompt).toContain("can still be resumed separately");
    expect(prompt).toContain("Timestamps and repeated workspace prefixes are omitted");
    expect(prompt).toContain("It is context only, not a task");
    expect(prompt).toContain("Do not start working");
    expect(prompt).toContain("let the user explain what they would like to work on next");
    expect(prompt).toContain("Keep the old thread unchanged");
    expect(prompt).toContain("<previous-session-transcript>");
    expect(prompt).not.toContain("2026-08-12T12:00:00Z");
    expect(prompt).not.toMatch(/\*Sent · /);
  });

  it("never names the product or the source provider to the destination", () => {
    // Destination agents have no knowledge of either, and naming them sends
    // agents hunting for a project or repository by that name.
    const prompt = buildHandoffPrompt({
      items: [
        {
          kind: "user_message",
          id: "user-1",
          text: "Carry on from here",
          attachments: [],
          turn_id: null,
          previous_turn_id: null,
          created_at: "2026-08-12T12:00:00Z",
        },
      ],
      sourceTitle: "",
    });

    expect(prompt).not.toContain("FalconDeck");
    expect(prompt).not.toContain("Codex");
    expect(prompt).not.toContain("Claude");
    expect(prompt).toContain("another AI coding assistant");
    // An untitled thread must not fall back to a product-branded heading.
    expect(prompt).toContain("# Previous session");
  });

  it("strips timestamps and repeated workspace prefixes from the destination prompt", () => {
    const workspace = "/Users/James/www/sites/lucidpic";
    const prompt = buildHandoffPrompt({
      items: [
        {
          kind: "user_message",
          id: "user-1",
          text: "Find the terms copy",
          attachments: [],
          turn_id: null,
          previous_turn_id: null,
          created_at: "2026-08-19T14:48:55.210966Z",
        },
        {
          kind: "tool_call",
          id: "tool-1",
          title: `cd ${workspace} && rg selected frontend`,
          tool_kind: "command",
          status: "completed",
          output: "frontend/marketing/pages/Legal/Terms.tsx:135:",
          exit_code: 0,
          display: {
            is_read_only: true,
            has_side_effect: false,
            is_error: false,
            lifecycle: "succeeded",
            artifact_kind: "command_output",
            activity_kind: "command",
            history_mode: "full",
            summary_hint: null,
          },
          detail: {
            kind: "command_execution",
            command: `cd ${workspace} && rg selected frontend`,
            cwd: workspace,
            actions: [],
            process_id: "43",
            duration_ms: 90,
            source: "codex",
          },
          created_at: "2026-08-19T14:48:59.313830Z",
          completed_at: "2026-08-19T14:48:59.313830Z",
        },
      ],
      sourceTitle: "Previous session",
      workspacePath: workspace,
    });

    expect(prompt).toContain("## Tool — rg selected frontend");
    expect(prompt).toContain("Find the terms copy");
    expect(prompt).not.toContain("2026-08-19T14:48:55.210966Z");
    expect(prompt).not.toContain("cd /Users/James/www/sites/lucidpic");
    expect(prompt).not.toContain("Exit code: 0");
    expect(prompt).not.toContain("process_id");
  });

  it("bounds very long conversations inside the handoff prompt", () => {
    const items = Array.from({ length: 2_000 }, (_, index) => ({
      kind: "user_message" as const,
      id: `user-${index}`,
      text: "x".repeat(1_000),
      attachments: [],
      turn_id: null,
      previous_turn_id: null,
      created_at: "2026-08-12T12:00:00Z",
    }));

    const prompt = buildHandoffPrompt({
      items,
      sourceTitle: "Long session",
    });

    expect(prompt).toContain("Omitted");
    expect(prompt).not.toContain("FalconDeck");
    expect(prompt).toContain("middle history");
    expect(prompt.length).toBeLessThan(600_000);
  });
});
