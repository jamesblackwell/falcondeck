# ACP conformance pilot

FalconDeck includes a small adapter probe for checking the behavior that its
generic ACP runtime depends on. The pilot is intentionally separate from the
daemon: it is an engineering diagnostic, not yet a release gate or user-facing
health check.

## Running it

Handshake only (no model call):

```sh
cargo run -p falcondeck-daemon --example acp_conformance -- -- pi-acp
cargo run -p falcondeck-daemon --example acp_conformance -- -- opencode acp
cargo run -p falcondeck-daemon --example acp_conformance -- -- grok agent stdio
```

Live conformance checks:

```sh
cargo run -p falcondeck-daemon --example acp_conformance -- \
  --live --timeout-seconds 90 -- pi-acp
```

Include an adapter process restart and session reload with:

```sh
cargo run -p falcondeck-daemon --example acp_conformance -- \
  --live --restart --timeout-seconds 90 -- pi-acp
```

Use `--json` for machine-readable output and `--cwd PATH` to select the
workspace presented to the adapter.

`--live` makes model calls. It creates one temporary fixture file in the chosen
working directory, asks the agent to read it, runs `sleep 20` to test
cancellation, and removes the fixture on exit. If the adapter asks permission
for those controlled tool calls, the probe selects an `allow_once` option. Run
it only in a workspace and with credentials for which that activity is safe.

## Checks

The handshake checks process launch, protocol negotiation, advertised image
support, MCP transports, and authentication methods. Live mode additionally
checks:

- session creation and advertised modes;
- streamed assistant text;
- paired tool start/update events and post-tool assistant output;
- `session/cancel` behavior;
- `session/load` and replay behavior when advertised;
- adapter termination, a fresh process, and cross-process session loading when
  `--restart` is selected;
- session-update kinds not handled by FalconDeck's current ACP projection.

The protocol engine is exported as `falcondeck_daemon::acp_conformance`, so
tests and future settings/API surfaces consume structured `Report` values
instead of scraping the command-line display.

This is not a routine end-user test. FalconDeck owns certification and release
qualification for built-in and recommended agents. A future product surface
should expose only a lightweight **Verify setup** action while someone is
adding or troubleshooting a custom ACP command; token-spending live and restart
checks remain developer diagnostics.

## Deterministic coverage

`tests/fixtures/acp_conformance_agent.mjs` is a zero-model ACP adapter used by
the Rust integration suite. It makes the conformance runner exercise real
stdio framing and process ownership while keeping the responses deterministic.
The suite covers:

- the complete live success path;
- selecting an ACP `allow_once` permission option;
- cancellation and its stop reason;
- session replay and cross-process restart/reload;
- unhandled session-update classification and stderr capture;
- protocol-version mismatch;
- malformed JSON output;
- an adapter exiting during initialization;
- a structured ACP request error;
- a request timeout;
- handshake-only mode making no live session requests.

Run it with:

```sh
cargo test -p falcondeck-daemon --test acp_conformance
```

The path-scoped `ACP conformance` GitHub Actions workflow runs this deterministic
suite for daemon/protocol changes. It does not use model credentials or contact
external harnesses.

## Shared event classification

Production ACP ingestion and the conformance report both classify
`session/update` values through `acp_protocol::AcpSessionUpdateKind`. Every
observed kind has one disposition:

- **projected** — becomes a client-visible conversation event;
- **consumed** — updates daemon state or is deliberately suppressed;
- **known unhandled** — recognized but not represented by FalconDeck yet;
- **unknown** — not known to this build and therefore potential protocol drift.

The runtime logs known-unhandled and unknown discriminants at most once per
adapter process, preventing streaming-event log floods. The compatibility
report lists known product gaps separately from genuinely unknown protocol
values. Adding or changing production handling therefore changes the shared
classifier and fails the same deterministic tests that power diagnostics,
instead of requiring a second manually mirrored allowlist.

## Pilot results (2026-08-09)

Pi (`pi-acp` 0.0.33), OpenCode 1.18.14, and Grok 1.0.0 all passed protocol
initialization, session creation, streaming text, tool lifecycle, cancellation,
session loading, and cross-process restart/reload locally.

The probe immediately exposed meaningful compatibility differences:

| Adapter | Images | Modes | Resume / restart replay | Session updates FalconDeck does not project |
|---|---:|---:|---:|---|
| Pi | yes | 6 | 9 / 9 updates | `available_commands_update`, `session_info_update`, `user_message_chunk` |
| OpenCode | yes | 0 | 10 / 10 updates | `available_commands_update`, `usage_update`, `user_message_chunk` |
| Grok | no | 0 | 10 / 11 updates | `available_commands_update`, `user_message_chunk` |

Grok also reported local configuration, plugin-collision, and unavailable MCP
server warnings on stderr while still completing the ACP checks. That validates
capturing adapter stderr as part of a compatibility report: protocol success
alone does not mean the harness is healthy.

These counts are observations, not golden values. Session history and adapter
versions can change them. The durable assertions are successful replay and the
shape of the emitted event kinds.

## What the pilot does not prove

- Image content is advertised but not sent to a model.
- MCP configuration is reported but no MCP server is exercised.
- Authentication methods are reported but interactive login is not driven.
- Permission denial and persistent permission choices are not tested.
- Mid-turn process death and daemon-owned recovery are not yet tested; the
  restart check currently occurs after a completed/cancelled turn.
- Slow partial lines and oversized messages need deterministic fixture cases.

The pilot is useful precisely because it separates three questions: whether an
adapter speaks ACP, whether its live behavior matches FalconDeck's assumptions,
and which useful provider events FalconDeck currently leaves on the floor.
