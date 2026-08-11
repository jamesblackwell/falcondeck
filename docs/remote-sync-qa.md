# Remote Sync QA

This is the repeatable acceptance checklist for the relay, daemon bridge,
remote web client, mobile client, and shared host client.

## Correctness gates

Run the focused client suites:

```sh
npm --workspace @falcondeck/client-core test
npm --workspace falcondeck-remote-web test
npm --workspace @falcondeck/mobile test
```

Run relay and daemon protocol tests:

```sh
cargo test -p falcondeck-relay --lib
cargo test -p falcondeck-relay --test relay_api
cargo test -p falcondeck-daemon --lib remote_bridge
```

The pruning scenarios must verify both cases:

- a cursor before retained history reports truncation and requires a fresh
  snapshot;
- the next sequence remains monotonic after pruning and never reuses a prior
  sequence number.

## Failure-mode scenarios

In a staging relay, exercise each client with:

1. process restart while a session checkpoint timer is pending;
2. socket loss while decrypting an update or live ephemeral event;
3. relay pruning while the client is offline;
4. a deliberately slow decrypt/apply loop until the bounded backlog reconnects;
5. two devices on the same session, one advertising event batching and one
   using the legacy single-event envelope;
6. duplicate replay frames after reconnect.
7. a snapshot response resolving while an encrypted update is still decrypting,
   followed by a replacement snapshot that checkpoints the held update cursor.

The expected result is either exactly-once visible state or harmless
idempotent reapplication; no cursor may advance beyond an unapplied update.

## Performance measurements

Run the parser benchmark in release-like mode:

```sh
npx vitest bench packages/client-core/src/remote-sync-performance.bench.ts
```

Record these staging metrics for cold connect, warm start, reconnect, and
pruned-history recovery:

- time to WebSocket open;
- time to encrypted/ready state;
- time to first usable snapshot;
- replay catch-up duration and update count;
- reconnect attempts and backoff delay;
- peak queued updates and process memory;
- duplicate-event count after reconnect.

Do not ship a performance change solely because a microbenchmark improves:
the staging run must show no regression in reconnect success, snapshot
correctness, or bounded memory under a slow consumer.
