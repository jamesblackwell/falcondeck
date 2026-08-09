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
- session-update kinds not handled by FalconDeck's current ACP projection.

Process death and restart remain explicitly skipped in the pilot. A useful
second iteration would split the protocol client into a testable library, kill
the adapter mid-turn, restart it, and verify restoration through the same
daemon-owned thread state used in production.

## Pilot results (2026-08-09)

Pi (`pi-acp` 0.0.33), OpenCode 1.18.14, and Grok 1.0.0 all passed protocol
initialization, session creation, streaming text, tool lifecycle, cancellation,
and session loading locally.

The probe immediately exposed meaningful compatibility differences:

| Adapter | Images | Modes | Resume replay | Session updates FalconDeck does not project |
|---|---:|---:|---:|---|
| Pi | yes | 6 | 9 updates | `available_commands_update`, `session_info_update`, `user_message_chunk` |
| OpenCode | yes | 0 | 11 updates | `available_commands_update`, `usage_update`, `user_message_chunk` |
| Grok | no | 0 | 9 updates | `available_commands_update`, `user_message_chunk` |

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
- Process restart, malformed messages, slow partial lines, and protocol-version
  incompatibility need deterministic fake-adapter tests before this becomes a
  release gate.
- The handled-event list currently mirrors `acp.rs` manually. It should be
  derived from a shared classifier before long-term use.

The pilot is useful precisely because it separates three questions: whether an
adapter speaks ACP, whether its live behavior matches FalconDeck's assumptions,
and which useful provider events FalconDeck currently leaves on the floor.
