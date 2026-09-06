# Relay connection diagnostics

The default `falcondeck_relay=info` level records connection lifecycle and slow
RPC replies. No extra collector, database, or per-heartbeat logging is needed.

- `relay peer opened`: session, peer, role (`Client` or `Daemon`), chunk transport,
  and compact-index support. A peer ID identifies one connection, not a device.
- `relay peer closed`: reason, numeric WebSocket close code (zero means none
  observed), connection duration, idle duration, received logical message count
  and bytes, queued outbound message count, parse/handler error counts, and the
  longest message-handler duration. These counters use constant memory and emit
  once per connection. A failed initial Ready write has a shorter close record.
- `relay slow rpc response`: replies taking at least two seconds from relay
  admission to daemon response, including any reconnect parking time. Fields
  include the client request ID, requester and responder peer IDs, method,
  elapsed time, success flag, and base64 ciphertext length. This is capped at
  ten lines per minute per requester connection. `suppressed` on the next
  emitted slow-reply record counts skipped records; if no further slow reply
  arrives before disconnect, no suppression summary is emitted.
- Existing timeout warnings include the requester peer and relay deadline.
  They mean the relay did not receive a daemon reply in time, not that the
  daemon did not execute the operation.

Successful fast RPCs remain debug-only. Heartbeats, replay chunks, and message
contents do not get new per-message logs. New diagnostics contain no pairing
codes, tickets, tokens, keys, ciphertext contents, or peer-supplied close reasons.
Connection churn still produces lifecycle records; existing error warnings are
not changed into a sampled stream.

## Investigate an incident

```sh
journalctl -u falcondeck-relay --since '15 minutes ago' -o cat
journalctl -u falcondeck-relay --since '15 minutes ago' -o cat | rg -F 'SESSION_ID'
```

Use the time from the phone, then follow the session and peer IDs:

1. Check whether the client or daemon closed first. `idle_timeout` means the
   relay observed no complete inbound message for its idle interval;
   `transport_receive_error` is deliberately a category, not a guessed WiFi cause.
2. Compare slow-RPC time with `max_handler_ms`. The former includes the daemon
   hop/work; the latter measures work in the relay's own message handler.
3. Correlate `request_id` with the phone. Daemon-side request IDs are namespaced
   by the requester peer, so use that peer ID as well when finding daemon logs.
4. A response prepared for the requester queue is not proof of socket delivery
   or application by the phone. Likewise, `queued_messages` counts transport
   queue admissions, not acknowledgements. Byte counts are logical reassembled
   messages and base64 lengths, not physical network traffic measurements.

For a short controlled reproduction, use `RUST_LOG=falcondeck_relay=debug` to
include individual RPC receipt and response records, then return to `info`.
The reliability lab already captures relay logs alongside its fault reports:
`make reliability-run SCENARIO=daemon-blackhole OUTAGE=5` exercises reconnects;
`make reliability-run SCENARIO=severe CYCLES=3` exercises slow replies.

Deployment requires the updated relay binary. Mobile and desktop rebuilds are
not required for these diagnostics. Log storage/retention stays with the host's
existing journal policy; this change adds no persistent diagnostic store.
