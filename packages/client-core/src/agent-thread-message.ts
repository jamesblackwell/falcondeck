export type AgentThreadMessage = {
  threadId: string;
  threadTitle: string;
  text: string;
};

/** Recognizes the persisted envelope from falcondeck_message_thread for display.
 * This does not change the underlying user-role message or establish trust. */
export function parseAgentThreadMessage(text: string): AgentThreadMessage | null {
  const match = text.match(
    /^Message from FalconDeck thread ([^\s()]+) \(([^\r\n]*)\):\r?\n\r?\n([\s\S]+)$/,
  );
  if (!match || !match[3].trim()) return null;
  return {
    threadId: match[1],
    threadTitle: match[2].trim(),
    text: match[3],
  };
}
