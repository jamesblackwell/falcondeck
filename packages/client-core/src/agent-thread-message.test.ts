import { describe, expect, it } from "vitest";

import { parseAgentThreadMessage } from "./agent-thread-message";

describe("parseAgentThreadMessage", () => {
  it("extracts the sender and retains the complete body", () => {
    const text = "Phase 3 accepted.\n\n- Trace the critical path.\n- Fix the largest delays.";
    expect(parseAgentThreadMessage(
      `Message from FalconDeck thread task-1 (Quizgecko (frontend)):\n\n${text}`,
    )).toEqual({ threadId: "task-1", threadTitle: "Quizgecko (frontend)", text });
  });

  it("accepts CRLF and an untitled sender", () => {
    expect(parseAgentThreadMessage(
      "Message from FalconDeck thread task-1 ():\r\n\r\nReady.\r\nNext step.",
    )).toEqual({ threadId: "task-1", threadTitle: "", text: "Ready.\r\nNext step." });
  });

  it.each([
    "Please check Quizgecko",
    "Quoted: Message from FalconDeck thread task-1 (Quizgecko):\n\nReady.",
    "Message from FalconDeck thread task-1 (Quizgecko):\nReady.",
    "Message from FalconDeck thread task-1 (Quizgecko):\n\n  ",
    "Message from FalconDeck thread task-1 (Quizgecko)",
  ])("leaves ordinary messages and incomplete envelopes alone: %s", (text) => {
    expect(parseAgentThreadMessage(text)).toBeNull();
  });
});
