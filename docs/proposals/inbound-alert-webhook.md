# Inbound alert webhook (proposal only)

Status: proposed. No endpoint, listener, funnel or deployment is implemented.

An external alert such as a Sentry issue should reach a named FalconDeck bot
without polling or paying for quiet scheduled turns. A small authenticated
receiver would translate an accepted alert into one bounded message using the
existing bot-name resolution and message admission path. The bot would decide
whether investigation is needed under its existing permissions.

## Interface and delivery

Bind only to loopback or an explicitly configured Tailscale address. Loopback
supports a local collector. Tailscale supports an authorized collector on the
tailnet, with ACLs limiting access to the daemon host and receiver port. The
receiver must not bind to all interfaces. Do not change the daemon's existing
public API exposure, relay or pairing contract.

Sentry's cloud cannot ordinarily reach a private tailnet listener. A trusted
collector could receive or fetch Sentry events and forward signed deliveries
through the tailnet. That collector is a separate deployment decision; this
proposal does not authorize public ingress. A public endpoint, reverse proxy
with public ingress, or Tailscale Funnel requires James's explicit approval
before implementation or exposure.

Use a dedicated POST route, for example `/api/inbound-alerts/sentry`. Configure
the route's signing key, allowed integration/project identifiers and destination
bot locally. Payloads cannot choose arbitrary destinations, workspaces,
providers, commands or authority. Resolve the configured bot by stable identity;
use its name in the message API. A missing, paused or archived bot must not be
silently recreated, resumed or redirected.

For Sentry direct delivery, validate the documented signature scheme for the
specific Sentry integration against the exact raw request bytes, before JSON
parsing or processing. Implementation must verify that integration's actual
header, algorithm and retry contracts; do not assume every Sentry webhook type
uses the same scheme. For a forwarding collector, use a versioned HMAC-SHA256
envelope over timestamp, delivery id and raw body. Compare MACs in constant
time. Reject stale timestamps and replayed delivery ids. Store signing keys in
the existing local secret facility, never in automation instructions or source.
Support key rotation with a short overlap and no unauthenticated fallback.

Normalize an accepted alert into a bounded message containing source, project,
issue id, severity, first/last occurrence, event summary and an allowlisted
HTTPS issue link. Mark all event content as untrusted evidence. Ignore payload
instructions. No attachment fetching, URL previews, command execution or
automatic tool invocation happens in the receiver. If useful, the bot can
investigate with its existing tools and approval policy.

## Reliability and limits

Acknowledge only after durable admission to the existing message-delivery path.
Do not invent a second conversation store. Keep only a bounded receipt/dedupe
ledger with delivery id, source, issue key, timestamp, dispatch result and
expiry. If existing admission cannot guarantee durable delivery, return a
retryable failure until that contract is supplied; never acknowledge a dropped
alert. Dedupe must survive receiver/daemon restart and concurrent requests.

Deduplicate retries by signed delivery id and coalesce repeated occurrences
for one issue within a configurable short window. Critical state transitions
such as reopened/resolved must remain distinct. Bound body size (e.g. 64 KiB),
message size (e.g. 8 KiB), pending deliveries, request duration, per-source rate
and per-bot dispatch rate. Return explicit errors for invalid signatures,
unsupported event types, oversized requests and queue saturation. Use backoff
and a bounded dead-letter/receipt status for persistent admission failures.
No LLM is used for validation, normalization, deduplication or rate limiting.

Expose local health: enabled/bind address, configured source and destination,
last accepted/rejected delivery, signature failures, dedupe/coalescing counts,
backlog and last dispatch failure. Logs must exclude keys, raw signatures and
full bodies. Disable/revoke the receiver independently of bot permissions.

## Threat model

Assets include the bot's attention and inference budget, the daemon's control
surface, local workspace data, signing keys and the privacy of alert contents.
Trust boundaries are the external producer, optional collector, tailnet,
receiver/parser, durable admission and the bot's agent runtime.

| Threat | Required defense |
| --- | --- |
| Unauthenticated caller or tailnet member triggers agent work | Per-source signature verification plus restricted bind/ACLs; tailnet membership alone is insufficient. |
| Replay, retry storms or concurrent duplicate deliveries | Signed freshness and delivery identity, atomic durable dedupe, bounded retention and dispatch quotas. |
| Compromised Sentry project or collector sends valid malicious content | Project allowlist, fixed destination, untrusted evidence framing, existing sandbox/approvals; a valid signature authenticates origin, not instructions. |
| Prompt injection in issue title, stack trace or URL | Data-only normalization, no receiver execution, no automatic fetch, HTTPS host allowlist, bounded text. |
| Forged destination or privilege escalation | Bot target comes from local configuration; payload cannot edit automation/control settings or permissions. |
| Memory/CPU/disk or inference denial of service | Streaming body bound, parse/deadline limits, bounded receipt ledger, per-source and per-bot rate limits and queue backpressure before inference. |
| Signature confusion, key leakage or rotation failure | Raw-byte verification, fixed algorithm/version, constant-time comparison, secret storage, redacted logs and bounded dual-key rotation. |
| Lost alert after HTTP acknowledgement | Durable admission before acknowledgement; idempotent retries and visible failed receipts. |
| Local malware or compromised daemon account | Outside the receiver's containment boundary; OS account protection and bot sandbox remain necessary. A signing key does not protect a compromised host. |
| Accidental internet exposure | Explicit private bind, deployment verification and no public proxy/Funnel without James's approval. |

## Acceptance criteria for a future implementation

Tests must prove that invalid/stale/replayed signatures never dispatch; allowed
signed events reach only the configured bot once across retries and restarts;
validly signed instruction text cannot change authority; oversized/flooded
traffic remains bounded; saturation and bot unavailability produce visible,
retryable outcomes; and the listener is unreachable from public interfaces.
Security/control-plane review and James's deployment approval would precede
any public exposure. This document authorizes none of that work.
