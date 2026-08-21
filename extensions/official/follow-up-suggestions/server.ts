import {
  defineExtension,
  validateComposerSuggestions,
  type ComposerSuggestion,
} from "@falcondeck/extension-sdk";

const SUGGESTIONS_VIEW = "follow-ups";

type SuggestInput = {
  actions?: unknown;
  preferredActionId?: unknown;
};

function parseActions(input: SuggestInput): ComposerSuggestion[] {
  if (!Array.isArray(input.actions)) {
    throw new Error("actions must be an array of 1-5 next actions");
  }
  return input.actions.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`action ${index} must be an object`);
    }
    const action = candidate as Record<string, unknown>;
    if (
      typeof action.id !== "string" ||
      typeof action.label !== "string" ||
      typeof action.prompt !== "string"
    ) {
      throw new Error(`action ${index} needs string id, label, and prompt`);
    }
    return {
      id: action.id.trim(),
      label: action.label.trim(),
      prompt: action.prompt.trim(),
      ...(typeof action.description === "string" && action.description.trim()
        ? { description: action.description.trim() }
        : {}),
    };
  });
}

export default defineExtension({
  activate(context) {
    context.tools.register("suggest-follow-ups", async (invocation) => {
      const { threadId } = invocation;
      if (!threadId) {
        // Automations and one-off agent runs have no conversation to attach an
        // offer to. Say so plainly rather than failing the agent's turn.
        return {
          published: false,
          reason: "this turn is not attached to a thread, so nothing was shown",
        };
      }
      const input = (invocation.input ?? {}) as SuggestInput;
      const actions = parseActions(input);
      const preferredActionId =
        typeof input.preferredActionId === "string" && input.preferredActionId.trim()
          ? input.preferredActionId.trim()
          : undefined;
      const violation = validateComposerSuggestions({ actions, preferredActionId });
      if (violation) throw new Error(violation);

      // Publishing is the whole side effect. FalconDeck retires a thread's
      // offers when its next turn starts, so this extension keeps no state of
      // its own and never has to reason about staleness.
      await context.composer.publish({
        viewId: SUGGESTIONS_VIEW,
        threadId,
        actions,
        preferredActionId,
      });

      // Returning immediately is the point: the agent keeps working and the
      // user sees the offer only once the turn goes idle.
      return { published: true, count: actions.length };
    });
  },
});
