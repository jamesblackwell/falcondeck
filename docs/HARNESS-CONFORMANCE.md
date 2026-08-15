# Harness conformance

FalconDeck drives four harnesses across three protocols, each shipped by
someone else and updated without warning. These probes check that the
assumptions FalconDeck makes about them still hold.

| Harness | Protocol | Probe |
| --- | --- | --- |
| Claude | `claude` CLI, stream-json | `--example harness_conformance` |
| Codex | `codex app-server` JSON-RPC | `--example harness_conformance` |
| OpenCode (native) | HTTP session API | `--example opencode_conformance` |
| OpenCode / Grok / pi (ACP) | ACP over stdio | `--example acp_conformance --all` |

## Running them

```sh
cargo run -p falcondeck-daemon --example harness_conformance
cargo run -p falcondeck-daemon --example opencode_conformance
cargo run -p falcondeck-daemon --example acp_conformance -- --all
```

Each defaults to a cost-free run and takes `--live` to add the checks that
spend tokens, plus `--json` for machine-readable output. Run them on harness
upgrades rather than on every commit: they need the real binaries, real
credentials, and go red for reasons that are not always ours.

## What they check, and why those things

The probes do not aim to cover every method. They target the assumptions that
fail *quietly*.

A dropped route or a renamed field announces itself — the next request errors
and someone sees a stack trace. The dangerous case is the opposite: a harness
that keeps answering successfully while telling us less than it used to, or
saying nothing where it used to say something. Nothing errors, nothing logs,
and the product degrades into what looks like a loading state.

FalconDeck shipped that failure three times:

- an ACP discovery result whose empty catalog was left in place as if it were
  data, leaving the composer with a placeholder picker;
- a native OpenCode probe that read an absent event as proof the runner was
  broken, and disabled a working transport for weeks;
- a Codex `collaborationMode/list` failure that is deliberately swallowed, so
  an empty mode list is indistinguishable from a harness that has none.

All three passed their unit tests. Fixtures encode what we already believe, so
only a live run against the real binary can contradict us.

### Claude

Claude has no discovery protocol, so its contract is the command line and the
event stream.

- **turn flags advertised** — every flag in `claude::REQUIRED_CLI_FLAGS` still
  appears in `claude --help`. A CLI that silently ignores an unknown
  `--effort` stops applying the user's reasoning choice without failing.
- **curated models resolve** (`--live`) — FalconDeck advertises Claude models
  from a hardcoded list rather than discovering them, so a model the CLI has
  dropped stays in the picker and fails only when a user picks it. The CLI
  reports this as `model_not_found` *inside an otherwise successful stream*,
  which is why it is checked explicitly rather than inferred from an exit code.
- **stream-json turn** (`--live`) — a real turn still emits the event kinds and
  carries the fields the transcript builder reads.

### Codex

Codex publishes a catalog over its app-server control plane, so the probe
bootstraps a real session through `CodexSession::connect` and asks the same
questions the daemon asks at workspace attach.

- **model catalog** — non-empty. An empty catalog is not an error anywhere in
  the stack; it just renders as an empty picker.
- **service tiers (fast mode)** — fast mode is a per-model service tier. If
  Codex stops publishing tiers, the toggle silently stops doing anything.
- **collaboration modes** — the daemon swallows a `collaborationMode/list`
  failure by design, so this count is the only visible signal.

## The rule

Assert on counts, not on parses. Assert with FalconDeck's own parser, not the
probe's reading of the wire — a probe that reimplements what it checks can only
confirm itself. And treat "it returned nothing" as a result that needs
explaining, never as a verdict.
