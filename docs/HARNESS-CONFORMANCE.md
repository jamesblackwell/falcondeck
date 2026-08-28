# Harness conformance

FalconDeck drives five harnesses across three protocols, each shipped by
someone else and updated without warning. These probes check that the
assumptions FalconDeck makes about them still hold.

| Harness | Protocol | Probe |
| --- | --- | --- |
| Claude | `claude` CLI, stream-json | `--example harness_conformance` |
| Codex | `codex app-server` JSON-RPC | `--example harness_conformance` |
| Antigravity | `agy` CLI, stream-json | `--example harness_conformance` |
| OpenCode (native) | HTTP session API | `--example harness_conformance` (also `--example opencode_conformance`) |
| OpenCode / Grok / pi / Cursor (ACP) | ACP over stdio | `--example harness_conformance` (also `--example acp_conformance --all`) |

Gemini CLI is deprecated; Antigravity (`agy`) replaced it.

## Running them

The suite is the thing to run. It probes every first-party harness, native
OpenCode, and every ACP provider in `providers.json`. Missing binaries are
skipped, so a machine that only has Claude still produces a useful report.

```sh
make harness-conformance
cargo run -p falcondeck-daemon --example harness_conformance
```

Cost-free by default. Token-spending checks stay behind an explicit flag and
use current cheap-tier models, not retired mini/haiku-3/nano ids: Claude
`haiku` (4.5), Codex/OpenCode GPT-5.6 Luna or DeepSeek V4 Flash, Grok 4.6,
AGY Gemini 3.7 Flash-low. Native OpenCode only picks models its runner can
actually execute:

```sh
make harness-conformance LIVE=1
make harness-conformance LIVE=1 ALL_MODELS=1   # every curated Claude id
make harness-conformance LIVE=1 RESTART=1      # ACP process restart/reload
make harness-conformance HARNESS_CONFORMANCE_JSON=1
```

`--require-installed` fails instead of skipping a missing binary. Individual
examples still exist for a single protocol:

```sh
cargo run -p falcondeck-daemon --example opencode_conformance
cargo run -p falcondeck-daemon --example acp_conformance -- --all
```

Run them on harness upgrades rather than on every commit: they need the real
binaries, real credentials, and go red for reasons that are not always ours.

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

Claude has no model-list command, so the contract is the command line, the
stream-json event stream, and extras in `~/.claude.json`.

- **turn flags advertised** — every flag in `claude::REQUIRED_CLI_FLAGS` still
  appears in `claude --help`. A CLI that silently ignores an unknown
  `--effort` stops applying the user's reasoning choice without failing.
- **control-plane flags** — `--fork-session` (native fork). Missing is a
  warning until that spawn path lands, not a turn-spawn failure.
- **help model aliases** — quoted ids in the `--model` help paragraph
  (`sonnet`, `opus`, …). Help examples are not exhaustive (`haiku` is omitted
  but still runs).
- **picker catalog** — curated aliases plus `additionalModelOptionsCache`.
  Empty discovery must not blank the picker.
- **curated models resolve** (`--live`, cheap default `haiku`; `--all-models`
  for the rest) — a model the CLI has dropped stays in the picker and fails
  only when a user picks it. The CLI reports this as `model_not_found`
  *inside an otherwise successful stream*, which is why it is checked
  explicitly rather than inferred from an exit code.
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
- **cheap live turn** (`--live`) — `thread/start` plus `turn/start` on a
  mini/nano-class model still produces assistant text.

### Antigravity

Antigravity is print-mode stream-json, like Claude, with its own event names.
The daemon falls back to a curated model table when `agy models` is empty,
which is the quiet failure this probe exists to catch.

- **turn flags advertised** — every flag in `agy::REQUIRED_CLI_FLAGS` still
  appears in `agy --help`.
- **model catalog** — `agy models` parsed with `agy::parse_models_table` is
  non-empty. An empty table would leave the picker looking populated from
  the fallback list.
- **stream-json turn** (`--live`) — a cheap `*-flash-low` turn still emits
  `init`, `step_update`/`result`, and assistant text through FalconDeck's
  own parser. A missing `conversation_id` fails, because resume is then a
  guess.
- **conversation resume** (`--live`) — a second turn with `--conversation`
  still completes. Do not pass `-p` together with `--input-format stream-json`.

## The rule

Assert on counts, not on parses. Assert with FalconDeck's own parser, not the
probe's reading of the wire — a probe that reimplements what it checks can only
confirm itself. And treat "it returned nothing" as a result that needs
explaining, never as a verdict.
