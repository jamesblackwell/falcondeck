# Mobile reliability lab

The controller runs a separate real daemon, a real relay backed by disposable
Postgres, two TCP fault proxies, and an isolated iOS simulator. It never restarts
the working desktop. The Codex app-server executable is replaced at its existing
`--codex-bin` boundary by a deterministic native-history fixture. No model calls
or user conversation data are needed.

## Run

Requires macOS, Xcode/simulator runtime, AXe, Docker with Compose, Node, Python3,
Rust, and installed monorepo dependencies. The default simulator is iPhone 17 Pro
on iOS 26.3; pass `simulator --runtime <identifier>` for another installed runtime.

```sh
make reliability-up
make reliability-simulator
make reliability-pair
make reliability-smoke
make reliability-run SCENARIO=mobile-blackhole OUTAGE=55
make reliability-run SCENARIO=background OUTAGE=90
make reliability-run SCENARIO=ui-send
make reliability-run SCENARIO=draft-relaunch
make reliability-run SCENARIO=model-picker
make reliability-run SCENARIO=packet-loss SEED=12
make reliability-run SCENARIO=bulk
make reliability-soak CYCLES=100 SEED=7
make reliability-replay RUN=var/reliability/runs/<run>/report.json
make reliability-campaign SUITE=all SEEDS=19
make reliability-down
```

Setup defaults to 30 threads and a 5 MiB single-message fixture. For the large
index fixture use `python3 scripts/reliability/lab.py up --workspaces 40 --threads
50`. Setup supports `--lines`, `--bulk-bytes`, and `--ttl` (four hours by default).
`seed --bulk-bytes N` resets synthetic history and restarts only the lab daemon.
Do not reseed during a scenario. The scenario runner refuses overlapping runs.
The simulator uses an optimized bundled-JS Release build with simulator signing;
it disables production OTA only in the disposable build product. Build caching
uses Xcode's DerivedData. The app bundle hash is recorded in each report.

Supported scenarios: healthy, constrained, severe, packet-loss, blackhole,
downstream-blackhole, upstream-blackhole, daemon-blackhole, bulk,
send-reply-loss, restart-daemon, flapping, background, mobile-blackhole,
ui-send, ui-send-reply-loss, concurrent-reads, urgent-during-sync, draft-relaunch, and model-picker. Scenarios are executable independently;
`smoke` is intentionally a small fast subset. UI scenarios require a paired
simulator with a conversation selected; initial pairing currently selects one
through the normal app startup flow. They fail explicitly if prerequisites are
missing. They do not silently pass or fall back to demo mode.

## Autonomous bug discovery

`make reliability-campaign` runs a bounded matrix on the existing lab. Use
`SUITE=protocol` for twelve encrypted-RPC cases, `SUITE=mobile` for seven simulator
cases, or `SUITE=all`. `SEEDS=19,37` repeats the matrix with recorded fault seeds;
the current packet-loss case uses these seeds, while deterministic cases repeat
to sample scheduling differences. At most five seeds are accepted.

The campaign continues after scenario failures and retries each failed case once
by default (`RETRIES=0`, `1`, or `2`). Its exit code remains nonzero when any
attempt failed, including a failure followed by a pass. An interrupted campaign
stays marked interrupted. It saves an incremental `campaign.json` and linked
`summary.md` under `var/reliability/campaigns/`. Individual reports can be replayed
with the existing replay command. Fault cleanup runs after every attempt.

The initial discovery plan is:

1. Establish a healthy baseline and compare constrained, severe, and packet-loss
   reads. Queue twelve concurrent index requests to check dispatch and consistency, including prompt overload rejection and a
   subsequent successful read. Send a message during the burst to test reserved
   urgent capacity and a five-second acknowledgement bound.
2. Interrupt each direction and the daemon leg; restart the daemon; verify recovery.
3. Lose a send reply after native execution, both through the encrypted probe and
   the actual mobile Send button. Test both a short interruption and 40 seconds,
   beyond the client's 35-second delivery deadline. Verify one execution and a
   visible recovered reply.
4. Exercise draft persistence, model selection, a silent connection, and a
   90-second background outage on the simulator.
5. Retain the strict large-history test and its failures. Diagnose each candidate
   using correlated logs, reproduce it independently, fix the owning layer, then
   replay the same case and run the related tests and required code review.

Repeated failure is a triage signal, not an automatic product-bug classification.
Distinguish fixture/automation faults from runtime defects. Do not inflate timeouts
or retry mutations to make a test green. A campaign is deliberately sequential:
it owns shared proxies, daemon, and simulator state, so concurrent scenarios would
contaminate each other's measurements. The runner does not deploy production apps
or schedule itself; invoke it after relevant changes for the same repeatable loop.

## Fault semantics

`profiles.json` uses Toxiproxy 2.12.0. Latency is applied in both stream directions,
and bandwidth is **kilobytes per second**, not bits per second. Blackholes use
`timeout=0`; reset disables/re-enables a proxy. The mobile-blackhole scenario does
not force a reset at recovery, so it tests the application's own watchdog.

```sh
python3 scripts/reliability/lab.py profile downstream-blackhole --link phone
python3 scripts/reliability/lab.py profile healthy --link phone
python3 scripts/reliability/lab.py netem --loss 1 --delay 50 --seed 12
python3 scripts/reliability/lab.py netem
```

The `netem` sidecar shares only the proxy container's network namespace. Its
traffic-control filter shapes replies from port 8666 (or 8667 for `--link daemon`),
leaving the proxy API untouched. This tests actual packet loss/retransmission on
that leg, rather than deleting bytes from an application stream. The controller
records a small HTTP path calibration before and after applying timed profiles.
The profiles are synthetic stress settings, not certified replicas of a carrier.
Control-plane telemetry stays outside the injected fault path.

## Evidence and instrumentation

Each run writes `var/reliability/runs/<run>/report.json`, a metadata-only probe
trace, and failure artifacts. Reports include seed, scenario settings, fixture
size, Git revision/dirty state, binary hashes, bundle hash, request durations,
response sizes, and the explicit pass/fail result. Failed/aborted requests remain
failures; they are not excluded to improve latency statistics. Flapping records
settled daemon RSS samples. The fixture ledger records execution IDs so reply
loss can be checked against actual execution and recovered history.

Simulator builds opt in with `EXPO_PUBLIC_RELIABILITY_URL`, set by the controller.
The probe accepts only a loopback HTTP collector, exports no request parameters
or response contents, and has a bounded event buffer. It records RPC start/end,
wire request IDs, result receipt/application, sync state, and JS heartbeat delay.
The relay/daemon logs correlate RPC routing and handler/queue stages by request
ID. A daemon log saying a response was **prepared** is distinct from completing
its queue operation; neither claims delivery to the phone.

Failure capture includes the accessibility tree, screenshot, recent daemon/relay
logs, and recent mobile trace. The collector rotates at 32 MiB. The controller
uses a per-scenario deadline; its lab expiry process only removes the owner that
created it. Credentials stay in a mode-0600 ignored state file. Teardown preserves
reports and synthetic history for diagnosis while removing lab-owned processes,
containers, volumes, and simulator. Replaying a report requires matching fixture
settings and records the new build rather than pretending to run the old binary.

## Checks and limits

`make reliability-test` checks fault replacement, safe PID cleanup, and fixture
execution/history. Mobile tests cover trace redaction and heartbeat deadlines.
Use repo-required autoreview for runtime changes.

This lab does not emulate radio hardware, thermal throttling, or precise physical
iOS suspension. Home/terminate/relaunch test observable lifecycle recovery. AXe
command latency is not an input-to-render measurement; the JS heartbeat is a
separate coarse stall signal. It must not be reported as proof of a 100 ms input
latency target. Random seeds reproduce fault schedules, not OS thread scheduling.

The `bulk` case is deliberately strict: a 5 MiB single artifact may expose a
request timeout even when small control RPCs remain responsive. A failing report
is evidence for a product fix, not justification to silently increase timeouts
or weaken the fixture. Protocol-level replay-pruning/key-rotation tests remain
in `docs/remote-sync-qa.md`; the lab does not yet orchestrate every permutation
of those cases through the simulator. Physical-device certification, automatic
failure-sequence minimization, and CI scheduling are separate extensions.
