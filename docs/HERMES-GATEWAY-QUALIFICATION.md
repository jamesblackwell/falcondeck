# Hermes native gateway qualification

Verified on 2026-10-06 against the [ACP qualification baseline](HERMES-ACP-QUALIFICATION.md). This is the qualification increment of Phase 5, not a native FalconDeck adapter. Hermes continues to use ACP in `ProviderRuntime` and existing threads retain their ACP handles.

## Source and installation

The installed executable remains Hermes `0.14.0`, source `5a3317693c6ddd84834c4684eb6929ade20f0962`. Its checkout was clean before testing. Its TUI gateway starts, but `gateway.capabilities`, `client.capabilities`, and `ping` each return `-32601` (unknown method). The installed source cannot satisfy the proposed native request-negotiation contract. No installed upgrade was performed.

The candidate source is the same pinned revision used for ACP acceptance: [`1d6b2786e2b2de70a967c66b6a14e2b83bab30e7`](https://github.com/NousResearch/hermes-agent/tree/1d6b2786e2b2de70a967c66b6a14e2b83bab30e7). Its supported launch surface is its dependency environment's Python interpreter running `-m tui_gateway.entry`. This is distinct from the messaging service launched by `hermes gateway run`. [Entry implementation](https://github.com/NousResearch/hermes-agent/blob/1d6b2786e2b2de70a967c66b6a14e2b83bab30e7/tui_gateway/entry.py).

The checkout, test homes and workspaces were disposable. The probe copied only `.env` and `auth.json` for explicit live tests, created a separate minimal configuration, and did not copy native history, memory or skills. It checked the original credential files remained byte-identical and removed the copies on exit. Existing Hermes configuration and FalconDeck provider configuration remained unchanged.

An installed upgrade would be necessary before using this negotiated native protocol on this Mac. It would not resolve the rollout blockers below by itself. Keep the qualified ACP integration available; classify installation ownership and explain the chosen revision and compatibility changes before any later upgrade.

## Reusable probe

[The conformance script](../scripts/hermes/gateway_conformance.py) uses Python's standard library and creates an owner-only home and workspace under `/tmp`. It never installs or upgrades Hermes. Supply the interpreter that belongs to the source being tested; do not resolve a virtual-environment Python symlink to the base interpreter.

```sh
python3 scripts/hermes/gateway_conformance.py \
  --source /path/to/hermes-source \
  --python /path/to/hermes-dependency-environment/bin/python \
  --model gpt-5.6-luna --provider openai-codex --restart
```

For live checks, add `--live --credentials-home /path/to/selected-hermes-home`. Live mode spends model tokens, runs a controlled `sleep 8` command, and asks test clarification questions. It uses the explicit session model and a fresh test configuration; it does not reproduce custom provider endpoints from the user's configuration.

Add `--transport-checks` to test native-to-ACP history handoff and the connector boundary. With `--live`, it also tests an ACP-origin conversation round trip through the gateway. Blocked boundaries produce a nonzero exit even when the gateway interaction checks pass. Reports contain revision and check outcomes, not wire frames, stderr, transcripts or credential values.

Focused checks:

```sh
python3 -m unittest discover -s scripts/hermes -p 'test_*.py' -v
python3 -m py_compile scripts/hermes/gateway_conformance.py \
  scripts/hermes/test_gateway_conformance.py
```

## Results

The installed baseline fails capability negotiation as expected. The pinned candidate passes the cost-free discovery/restart probe and the live interaction/restart probe with `openai-codex:gpt-5.6-luna`.

| Check | Pinned candidate result |
| --- | --- |
| Capability negotiation | Exclusive submit, server requests, clarification, approvals and ping negotiated |
| Session creation | Distinct live and stored IDs; retry with the same idempotency key reused both |
| Streaming | Nonempty text deltas and explicit successful terminal outcome |
| Clarification | Original request ID and question IDs answered; turn completed |
| Open-request recovery | Same unanswered clarification present in `session.events.since` and `session.activate` |
| Native steering | Accepted during a running terminal call; the same turn completed with the correction |
| Cancellation | Pending clarification withdrawn by matching `request.cancel`; interrupted outcome, no open request, next turn usable |
| Gateway restart | Stored identity, seeded and live interaction history restored; continuation completed |
| ACP-origin history round trip | Original ACP handle and gateway continuation replayed through ACP; compression was not exercised |
| Native-origin history through ACP | Blocked: ACP load returned no proven history |
| Per-thread MCP injection | Blocked: candidate session injection fields rejected with `4000`; supported MCP add persisted profile configuration |

Two protocol details are covered by regressions. A cold resume uses `session_key` for stored identity while create uses `stored_session_id`; the live ID is neither. `message.complete` precedes release of the running claim, so another prompt must wait for an authoritative non-running session snapshot. A successful terminal outcome must explicitly report `status: complete`; text alone cannot establish success.

The probe also checks bounded frames, queues and deadlines, exact server-request correlation, isolation and cleanup, split ACP text chunks, and omission of sensitive upstream error messages. Sudo, secret, vault and unsupported renderer requests receive `-32601`; they are never answered through a chat prompt. This verifies refusal, not a working sensitive-input UI.

## Native rollout blockers

The current gateway contract does not expose session-scoped MCP definitions. Its typed `session.create` parameters reject the candidate `mcpServers` and `mcp_servers` fields. The supported `mcp.servers.add` method writes the selected profile's `config.yaml`, and `reload.mcp` reloads servers across live sessions. The probe verified the rejected fields did not register or launch its sentinel server, then demonstrated the profile write in its disposable home. [Session contract](https://github.com/NousResearch/hermes-agent/blob/1d6b2786e2b2de70a967c66b6a14e2b83bab30e7/tui_gateway/contracts/sessions.py), [MCP contract and implementation](https://github.com/NousResearch/hermes-agent/blob/1d6b2786e2b2de70a967c66b6a14e2b83bab30e7/tui_gateway/methods_tools.py).

FalconDeck's built-in and extension MCP bridges carry calling-thread identity. Replacing that with profile-wide writes would violate the connector isolation qualified in Phase 3. A native adapter needs a supported ephemeral connector overlay or equivalent session-scoped API while keeping native home/storage at the selected profile. Creating another persistent Hermes profile or moving its session database is not a substitute.

Native-created rows also do not establish reversible ACP loading. The ACP manager restores rows whose source is `acp`; an unknown load can return an empty successful RPC result. The boundary probe therefore requires actual replay evidence under the requested handle. Native-origin loading did not provide it. [ACP restore implementation](https://github.com/NousResearch/hermes-agent/blob/1d6b2786e2b2de70a967c66b6a14e2b83bab30e7/acp_adapter/session.py).

Do not change existing thread mappings or add automatic ACP-to-gateway fallback. Before a runtime rollout, qualify explicit transport pinning, ACP-origin continuation through compression, provider/model restoration, simultaneous sessions and connector isolation. Gateway replay here is an in-process request snapshot test; it is not acceptance of daemon restart, relay pruning, or a new request UI on paired clients.

## Next implementation increment

1. Agree and qualify a session-scoped connector contract with the Hermes gateway owner, retaining the selected native home and ordinary configuration.
2. Define the explicit native opt-in and history boundary. Existing ACP threads remain pinned; no silent session conversion or fallback.
3. Implement `HermesRuntime` behind `ProviderRuntime`, normalize negotiated clarification/approval requests, and add sensitive request types in Rust and TypeScript together if that UI is in scope.
4. Qualify process retirement, compression/restart, paired-client request recovery and model/mode changes through the real daemon path. Cron, messaging and background-agent control remain separate product scope.

The gateway probe is useful groundwork, but Phase 5's production runtime and client work remain unimplemented until these boundaries are resolved.
