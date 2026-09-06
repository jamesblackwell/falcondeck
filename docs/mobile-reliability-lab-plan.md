# Autonomous mobile reliability lab

## Outcome and scope

Build a repeatable, agent-operated environment that discovers, reproduces, and
verifies fixes for mobile sync, request delivery, and UI responsiveness under
bad connectivity. No phone interaction, log collection, pairing, or routine
test execution is required from James. Setup and test-environment deployment
are authorized. This document is the implementation plan, not a claim that the
lab already exists or its acceptance targets have passed.

Use a dedicated simulator, test credentials, synthetic workspaces, separate
daemon data directories and ports, and an isolated relay with Postgres. Do not
restart the working Mac app or apply network shaping to its network interface.
Start locally; deploy the same stack to an isolated Linux test host if local
virtualization cannot provide the required network namespaces. All resources
need an owner/run ID and a teardown command; remote runs need automatic expiry.

## Existing foundations

- `make mobile-dev` and the build instructions in `docs/14-mobile-app.md`.
- AXe is installed; simulator runtimes and Docker CLI are present. Verify the
  container runtime and Linux traffic-control capabilities during setup.
- Mobile relay hook integration tests and shared transport tests already exist.
- `relay_transport.rs` has a 512 kbit/s, 150 ms acknowledgement-delay benchmark.
- `docs/remote-sync-qa.md` lists replay, registration, and recovery invariants.
- Commits `52b9275` and `ad67267` provide compact sync and silent-socket recovery.

## 1. Reproducible topology

Dedicated iOS simulator -> phone fault proxy -> test relay/Postgres
Test daemon -> daemon fault proxy -> same test relay
Test controller -> proxies, fixture harness, simulator, trace collector

Use the real application, pairing flow, encryption, relay, daemon RPC handlers,
and state application. Automate pairing with a short-lived code produced by the
test daemon and entered through the UI. Avoid shortcuts that bypass the paths
being tested. Use a deterministic test harness at the agent subprocess boundary
to generate streams, accept turns, and expose an execution ledger without
paid model calls or real user conversations. This is a test oracle, not a new
product conversation store. Run a smaller real-harness smoke test separately.

Create an isolated simulator device rather than reusing currently booted ones.
Build an optimized simulator app with bundled JavaScript for timing tests; keep
a cached development build for rapid debugging. Neither requires TestFlight.
Record all binary/JS commits, build modes, protocol capabilities, OS versions,
fixture versions, and fault configuration in each run manifest.

## 2. Network fault controller

Use Toxiproxy for independently controlled upstream/downstream latency, jitter,
bandwidth limits, connection resets, blackholes, and cuts after a byte boundary.
Route both HTTP onboarding/ticket requests and WebSocket traffic through it.
Exercise DNS/connection refusal and HTTP 5xx at the appropriate endpoint layer.

Use Linux network namespaces and `tc netem` for packet-level loss, burst loss,
reordering, and queue pressure. Do not equate discarding application stream
chunks in a TCP proxy with packet loss and TCP retransmission. Calibrate the
actual path with a probe before every suite, including direction and units.
Inject latency once per intended leg; report measured RTT rather than merely
summing configuration labels. Keep controller traffic outside the fault path.

Initial synthetic profiles (stress conditions, not claims about typical 4G):

| Profile | Measured RTT target | Down / up | Additional fault |
| --- | --- | --- | --- |
| Healthy | 30–60 ms | 20 / 5 Mbit/s | None |
| Constrained mobile | 150–300 ms | 1 / 0.25 Mbit/s | Jitter, 1% packet loss |
| Severe mobile | 500–1,000 ms | 0.25 / 0.064 Mbit/s | Bursts averaging 5% loss |
| Coverage loss | N/A | No traffic | 5, 30, 90 seconds; then restore |
| Silent half-open | N/A | One or both directions blocked | No FIN/RST |
| Handoff | Variable | Healthy -> outage -> constrained | Replace connections |
| Flapping | Variable | Repeated availability changes | Seeded outage schedule |

Proxy controls model the connectivity consequences of dropped 4G and handoffs.
They do not emulate a cellular modem, carrier routing, or actual radio roaming.

## 3. Instrumentation and evidence

Extend existing request IDs with run ID, logical operation ID, attempt ID,
connection/key generation, and replay cursor. Trace enqueue, serialization,
encryption, transfer start/end, relay routing, daemon admission/handler duration,
response receipt/decryption, state application, and first usable UI state.
Use monotonic durations within each process; correlate IDs across hosts without
assuming synchronized wall clocks. Distinguish transport acceptance, daemon
acceptance, and completed execution.

Capture payload/chunk sizes, queued bytes, queue wait, pending requests, retry
reason, full/index/page request counts, event backlog, JS task delays, input
latency, memory, and foreground transitions. Never record plaintext prompts,
tokens, or encryption keys. Keep trace buffers bounded; measure instrumentation
overhead and compare timed runs with tracing reduced.

Every failed run automatically saves a manifest, fault schedule, structured
trace, simulator logs, screenshot, accessibility tree, and a replay command.
Keep rolling video optional to avoid distorting baseline timing. A controller
watchdog detects UI stalls even when the app's own JS diagnostics stop running.

## 4. Workloads and fault placement

Fixtures: small workspace; 40 projects/2,000 threads; long conversations; large
individual tool outputs; long streams; pending approvals; empty/delayed model
catalogs; archived threads; mixed legacy and compact clients.

Automate cold launch, pairing, warm reconnect, open thread, scroll/type, model
selection, send/steer/interrupt, approve, switch projects, and load more history.
Compare resulting IDs, ordering, cursor coverage, and execution counts against
the fixture oracle after recovery. For messages, drop the path before dispatch,
after daemon acceptance, after execution, and during reply delivery. A lost
acknowledgement must never cause an automatic duplicate mutation.

First deterministic scenarios:

1. Blackhole an OPEN socket; restore without restarting the app.
2. Background for 5/30/90 seconds and several minutes; resume during connecting,
   encryption, bulk transfer, and an outstanding request.
3. Send and approve while a multi-megabyte sync occupies each direction.
4. Disconnect mid-upload, after execution but before reply, and during replay.
5. Restart relay or daemon, expire a sync token, and prune replay while offline.
6. Deliver delayed old responses after a new connection/key generation.
7. Repeated invalidations during sync; verify convergence without snapshot loops.
8. Empty, late, and failed model catalogs; preserve a usable picker.
9. Kill/relaunch during draft persistence and cursor checkpointing.
10. Repeat network transitions while streaming and rapidly changing threads.

Use lifecycle UI actions plus explicit process suspension where supported;
record which mechanism was used. Neither is evidence of exact physical-iOS
background scheduling. Use state-triggered fault barriers for exact request
boundaries in test builds; compile them out of production builds. For external
network faults, record timing and observed transport boundaries. Seeded schedules
are reproducible inputs, not a promise of identical OS scheduling.

## 5. Measurable pass/fail criteria

Correctness is strict: no lost drafts, duplicate execution, missing applied
events, stale response replacement, cursor advance past unapplied data, or
unbounded queue growth. A send of unknown outcome stays explicitly uncertain
until reconciled; it must not be labelled failed and blindly resubmitted.

Initial performance targets, to validate against healthy baselines:

- Silent foreground connection detected within 45 seconds plus 5 seconds of
  scheduling tolerance; stale socket replaced promptly on resume.
- After a healthy path is restored, control requests work within 10 seconds
  when daemon service is ready. Initial/history catch-up is measured separately.
- On constrained mobile, small RPC p95 <=2 seconds during a 5 MiB bulk transfer,
  measured from user request including queueing. Bulk must also make progress.
- Simulator input feedback p95 <=100 ms, with no >=1 second UI stall during
  fault recovery. Report event-loop delays and native UI responsiveness separately.
- Warm reconnect with retained replay and valid cached state requests zero full
  snapshots; truncation triggers bounded compact recovery, not repeated full loads.
- At most one active bootstrap/index fetch per connection; retries are bounded
  by backoff and make progress after service restoration.
- Pending requests and transfer queues drain after quiescence; enforce existing
  byte caps. Memory returns to a stable post-warmup band over 100 reconnects,
  investigated if it grows >20% across comparable settled samples.

Report success/failure counts and p50/p95/max per profile. Include timed-out and
aborted operations in failure rates; do not calculate attractive latency numbers
by silently omitting them. Severe profiles still require correctness and usable
offline UI, but cannot share healthy-network completion deadlines.

## 6. Fast autonomous iteration

Proposed commands (to implement under `scripts/reliability/` and Make targets):

- `make reliability-up`: start isolated services, seed fixture, build/install/pair.
- `make reliability-smoke`: healthy baseline and the four highest-value faults.
- `make reliability-run SCENARIO=... SEED=...`: one fully captured run.
- `make reliability-soak`: bounded randomized workload/fault combinations.
- `make reliability-replay RUN=...`: restore manifest and rerun failing schedule.
- `make reliability-down`: remove only lab-owned resources.

Cache binaries and simulator installation by content hash. Reset application
state and fixture data between independent tests; retain state only in scenarios
that explicitly test recovery. Wait for observable conditions rather than fixed
sleeps. Start with sequential runs; isolate resources before adding concurrency.

Iteration loop: reproduce -> locate stalled boundary -> minimize sequence -> add
regression -> fix owner -> rerun focused case and adjacent failure modes -> run
repo-required autoreview -> commit scoped change -> repeat original suite.
Review ordinary reliability failures as well as P0 defects; P0-only clean output
does not establish these acceptance criteria. Preserve unrelated agent edits.

Deliver in usable increments:

1. Local isolated topology, trace manifest, automated pairing, healthy smoke,
   blackhole/resume regression, and automatic failure artifacts.
2. Two-link fault matrix, packet shaping, message execution oracle, and bulk-load
   tests. Fix the first verified failures before adding more permutations.
3. UI timing, long-thread fixtures, seeded 100-cycle soak, sequence minimization,
   and a concise result dashboard/artifact report.
4. Run fast protocol checks on relevant changes and a bounded simulator suite
   on the Mac runner. Add unattended scheduled soaks once runtime and artifacts
   are stable. Release changes only after the appropriate scenario suite passes.

No routine step needs James. Simulator results establish repeatable software
behaviour under injected faults, not physical battery, thermal, radio, or device
performance certification. Those limitations are recorded without making manual
phone testing a dependency of this lab.

## References

- [Toxiproxy controls](https://github.com/Shopify/toxiproxy/blob/main/README.md)
- [Linux netem](https://man7.org/linux/man-pages/man8/tc-netem.8.html)
- `docs/remote-sync-qa.md`
- `docs/mobile-sync-responsiveness-plan.md`
- `.agents/skills/axe-ios-simulator/SKILL.md`
