# Remote Hosts — running agents on servers

Status: proposed design, 2026-08-07. Motivated by replicating the ChatGPT
app's "Connections → SSH" workflow (agents running on e.g. quizgecko-ops-N).

## The question

ChatGPT's desktop app runs agents on remote servers by holding an SSH
connection from the Mac and driving the CLI over it. What is FalconDeck's
equivalent?

## The answer: a remote daemon, not a remote shell

FalconDeck already has the right bones. Today's topology:

```
iPhone ──(relay, E2E)──► Mac daemon ──► agent CLIs on the Mac
desktop ──(localhost)──► Mac daemon
```

The proposal is that a server is just **another machine running
`falcondeck-daemon`**, enrolled through the same relay the iPhone already
uses:

```
desktop/mobile ──(relay, E2E)──► ops-1 daemon ──► agent CLIs on ops-1
              └─(localhost)────► Mac daemon  ──► agent CLIs on the Mac
```

Why this beats ChatGPT's live-SSH model:

1. **Turns survive your laptop.** With SSH-from-the-Mac, the Mac is in the
   data path: laptop sleeps → turn dies (hence their "Keep this Mac awake"
   toggle). With a server-side daemon, a goal-driven Codex run keeps going
   after you close the lid; you reattach from desktop or phone and replay
   what you missed.
2. **The infrastructure exists.** The relay already does device pairing,
   E2E-encrypted sessions, presence, and push-attention — that is exactly
   host enrollment. The daemon is already a standalone Linux-capable binary
   (the relay build proves the toolchain on the target server).
3. **Same trust model as mobile.** A server enrolls exactly like the iPhone
   did: pairing code, per-device keys, revocable from Settings. No inbound
   ports on the server; the daemon dials out to the relay.
4. **bb validates the shape.** bb's server/host-daemon split (enrolled hosts,
   project sources pinned to hosts) is this same design, shipped.

SSH still has a role — **provisioning, not runtime**. "Add server" in
Settings can take `user@host`, SSH in once, install/update the daemon,
write its enrollment token, and start the systemd unit. After that SSH is
never in the hot path. (An advanced "SSH-only mode" could exist later for
servers where installing anything is unacceptable, but it inherits all the
liveness problems above and shouldn't be the default.)

## What has to change

Roughly in order:

1. **Daemon headless/enrolled mode.** `falcondeck-daemon --enroll <token>`
   connects out to the relay as a *host* (today only the Mac daemon speaks
   relay, and only as the single "machine"). Needs: host identity keys,
   reconnect/backoff (exists for remote bridge), no-keychain secret storage
   fallback on Linux (keyring crate supports secret-service; fall back to
   file with 0600).
2. **Relay: multiple hosts per account.** Today the relay brokers
   device↔one-machine. Generalize sessions to (device, host) pairs, host
   list + presence on the account, host names. The E2E model is unchanged —
   the relay still can't read anything.
3. **Clients: host affinity.** A workspace already has a path; it gains a
   host. The sidebar groups by host ("This Mac", "ops-1"); thread state,
   models, and provider capabilities all already flow per-workspace, so most
   UI needs no change beyond labeling and the add-project flow asking
   "where?". Desktop talks to remote daemons through the relay client-core
   transport that mobile already uses (code reuse, not new protocol).
4. **Settings → Connections page.** Mirror the ChatGPT layout we like:
   - *This Mac*: devices allowed to control it (exists today), keep-awake
     toggle (exists via caffeinate? add).
   - *Servers*: enrolled hosts, presence, restart/update daemon, remove.
   - Add-server flow: SSH bootstrap installer or copy-paste one-liner
     (`curl … | sh -s -- --enroll <token>`).
5. **Agent CLIs on the server.** The daemon resolves `codex`/`claude`/ACP
   binaries per host (per-host bin config), and auth happens on the host
   (`codex login`/`claude` OAuth over the bootstrap SSH session, or the
   provider's headless auth). Surface per-host account status in the
   existing agent account UI.

## Sequencing note

Do this before plugins (see BB-ANALYSIS.md §4b status). Steps 1–2 are
daemon/relay work with no UI risk; step 3 is where the client abstraction
(one daemon → N daemons) lands and should be done carefully behind the
existing snapshot/event model rather than a parallel code path.
