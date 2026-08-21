# Follow-up suggestions

Bundled official extension, enabled by default.

It publishes one agent tool — `suggest-follow-ups` — through the built-in
`falcondeck-extensions` MCP bridge. An agent may call it near the end of a turn
to offer the user between one and five short next actions. FalconDeck renders
them as a single compact pill above the composer, and only once that turn has
gone idle.

## Why it is shaped this way

- **The tool never blocks.** It returns as soon as the offer is stored, so an
  agent that calls it does not stall waiting for a human. Suggestions the user
  ignores simply disappear on the next turn.
- **The daemon owns the bounds.** Labels are capped at 30 characters, prompts
  at 512, and a set holds 1–5 actions. A set outside those bounds is rejected
  at the daemon boundary rather than degrading in three renderers.
- **Offers are thread-scoped and disposable.** FalconDeck retires a thread's
  offers as soon as its next turn starts, whatever harness that turn runs on,
  so a stale set is never shown next to newer work. The extension therefore
  keeps no state of its own.
- **Context comes from the daemon.** The thread and workspace a call belongs to
  are supplied by the harness spawn, not chosen by the agent, so an agent
  cannot aim an offer at another conversation.

## Permissions

`agent-tools:register` — required to publish tools to agent harnesses. Granted
by default for this bundled package; revoking it removes the tool from the
bridge's catalogue and makes any in-flight call fail immediately.

## Disabling it

Settings → Extensions → Follow-up suggestions. Disabling removes the tool from
the next harness spawn's catalogue, and any call from a harness that cached the
old list fails without running extension code.
