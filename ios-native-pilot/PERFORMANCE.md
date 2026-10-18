# Native performance pass — 18 October 2026

The standalone client now avoids repeated transcript projection, whole-prefix
UTF-16 copies and redundant relay snapshots. Expo, the daemon, production relay,
OTA and TestFlight were not changed.

## Measurements

Repeatable local CPU workloads in `PerformanceTests`, Debug on the same iPad
simulator. Times cover each complete workload, not a single token or frame.
These are indicative microbenchmarks, not end-to-end network/startup timings or
an FPS claim. Device/host load affects absolute times.

| Workload | Before | After |
| --- | ---: | ---: |
| 600 Unicode deltas, 1,000 earlier messages and a growing long response | 185.6 ms | 3.1 ms |
| Decode five snapshots, 1,500 task summaries each | 179.8 ms | 26.9 ms |
| Derive actions + blocks ten times for 1,200 settled messages | 705.9 ms | 60.9 ms |
| Apply 200 summary updates among 3,000 tasks | 26.0 ms | 24.4 ms |

A cached presentation survives draft edits and scroll geometry changes: 1,000
reads of the 1,200-row presentation took 0.15 ms total. The summary benchmark did
not justify replacing the task store; its batching and ordering were retained.

Focused tests also passed on the physical iPhone over Wi-Fi, using synthetic
content and an isolated test host. Debug results: 600 Unicode deltas 1.6 ms;
five snapshot decodes 24.3 ms; 2,400 updates across twelve conversations plus 200
selected-conversation presentation rebuilds 78.8 ms total. These device numbers
have no same-device pre-change baseline.

## Changes

- Cache harness prompt projection with each message; invalidate on source text
  or kind changes. Preserve sequence-dependent skill deduplication, service
  messages and attachment-only prompts. Build grouping/actions from one shared
  projection and retain one presentation per chat, invalidated by transcript
  mutation/replacement, running state or conversation preferences.
- Index transcript message positions and cache UTF-16 field lengths. Ordered
  appends avoid copying the whole text prefix. Overlap, replay, gap detection,
  authoritative replacements, Unicode offsets and truncated tools retain their
  validation/recovery behavior.
- Use Foundation's JSON parser at the wire boundary instead of repeatedly
  throwing through Codable type probes. Codable persistence remains compatible;
  booleans, numbers, null, nested values and fragments have regression coverage.
- Perform Keychain/session loading once for startup off the UI actor. Move
  cache/draft filesystem setup and history prompt projection off that actor.
  Guard each asynchronous recovery stage by connection generation. A corrupt
  navigation file cannot prevent healthy input recovery or future draft saves.
- Send `compact_index=true`, matching Expo's existing relay contract. Compact
  clients receive invalidation markers rather than downloading/decrypting full
  snapshots they discard. Legacy clients retain their existing relay behavior.
- Refresh only on readiness transitions, coalesce invalidations (one-second
  debounce, ten-second minimum interval), and retain invalidations received
  during a fetch for a trailing refresh. Manual refresh/reconnect stay immediate;
  the healthy-link safety refresh is five minutes. Ping/liveness checks remain.
- Upload with the shared clients' sixteen-chunk window, preserving ordered
  11 KiB chunks and one bulk transfer at a time. Control frames can still pass.
  Wait for every ACK; bound progress and total time, cancel timers and release
  waiters on disconnect, task cancellation or write failure. Cancel completed
  RPC deadline tasks instead of retaining them for 35–120 seconds.
- Build folder membership once per expanded folder; collapsed folders skip child
  filtering. Bind sidebar source arrays once per render and index project order.
  Compile code-highlighting regexes once and isolate highlighting from Copy
  state changes; palette changes invalidate the highlighted view.

The existing encrypted disk-cache budgets remain: 200 summaries, five recent
history tails, 150 items / 64 KiB per tail, and bounded model catalogs. The
in-memory presentation cache retains only the latest result per chat. No new
conversation database, durable replay cursor or sync-token cache was added.

## Validation

- Full native unit suite: 236 tests passed, including transcript replay/recovery,
  drafts, cached history, queues, model settings and new performance regressions.
- Physical iPhone: 17 focused performance/recovery/transport tests and three UI
  scenarios passed. Local UI exercised twelve streams, a 200-row history and
  1,000 sidebar tasks; typing, switching chats, thinking labels, reading position
  and final Markdown placement passed. No live harness turns were started.
- iPhone and iPad simulators: five focused scenarios each passed, including the
  same heavy workload, stable reading/streaming, cached refresh and folder taps.
  Screenshots were inspected in dark phone and light iPad appearances.
- Existing Rust chunks-v1 transport contract suite: 12 tests passed, including
  latency-window behavior and control traffic during large transfers.
- Optimized (`-O`) simulator build: all 236 unit tests and three phone UI
  scenarios passed. Scrolling fixtures now suspend for queued work instead of
  assuming five Task.yield calls are a completion barrier. The additional
  optimized-device run reached the lock screen and was stopped; the earlier
  physical-device checks above completed.
- Repository Autoreview: the first pass found two startup-recovery bugs; both
  were fixed with focused regressions. The native-only rerun with adjacent sync,
  transport and cache contracts was clean at P0–P2. The development installer now
  applies the tested optimization flags by default.

Reproduce CPU workloads with the normal native unit scheme and
`-only-testing:FalconDeckNativeTests/PerformanceTests`. For local visual load,
launch a Debug build with `--demo --performance-preview`. These fixtures use no
real conversations. The installed developer build uses Swift `-O` optimization
with development signing and sandbox push entitlements, without a debugger.

The optimized build was installed successfully on the paired iPhone over Wi-Fi.
A normal launch was attempted with no fixture arguments; iOS refused it because
the device was locked. Open Falcon Native after unlocking to use the new build.
The installed app's signature verifies and retains development APNs entitlements.


## Fresh code review — 18 October 2026

A separate reread and commit review of `61c5db40` found no additional Autoreview
findings. Manual regression tests exposed duplicate concurrent startup and stale
notification policy after out-of-order credential reads; both now have passing
regressions. Startup guards before its first suspension, and only the latest
push-sync request can configure notifications. Duplicate queued requests are
coalesced before reading credentials.

Incoming chunks now reject missing, negative, fractional and nonnumeric indexes;
transfer cancellation only affects the matching incoming transfer. Scrolling
requests return awaitable task handles, so tests await completion instead of
using a fixed delay. All 240 optimized unit tests and three optimized UI scenarios
each on iPhone/iPad simulators passed. The isolated native-only fix review used
`autoreview --mode local --max-priority P2` and returned no actionable findings.

## Native motion polish — 18 October 2026

Voice feedback now draws two bounded paths in a Canvas instead of laying out
one SwiftUI capsule per bar. TimelineView schedules three interpolation dates
per 100 ms audio sample and then stops; settled audio cannot leave a continuous
waveform clock running. Microphone sampling and transcription providers are
unchanged. The activity text shader only changes text ink toward the current
palette's foreground, so it cannot animate text placement or row height.

Button presses and disclosure chevrons share a short native animation. The
existing sidebar, prompt control order, hit areas and native sheets remain.
Goal completion emits ten small particles around the existing goal badge for
less than a second, only for the same visible, live goal changing from active
to complete. Cached completions and background updates do not trigger it.

A scene-level policy disables continuous effects for Reduce Motion, Low Power
Mode and inactive scenes. Hidden activity labels pause their timelines; native
loading symbols pause too. The waveform still displays actual samples with
motion disabled. Animation clocks remain inside leaf views, not AppModel.

Indicative process CPU measurements on the same optimized iPad simulator,
after two seconds of warmup and over eight seconds of sampling:

| Local fixture | Motion enabled | Low Power visual fallback |
| --- | ---: | ---: |
| Thinking | 6.37% | 0.00% |
| Recording and changing audio samples | 10.85% | 5.87% |

These are percentages of one host CPU core, not device energy, GPU utilization,
FPS, or a comparison with the previous app. Other simulator/host work can affect
them. Real iPhone energy/frame profiling remains pending because the paired
phone became unavailable. The Animation Hitches instrument does not support
this simulator target; no hitch-free claim is made from that failed trace.

Local fixtures: `--demo --motion-preview=recording`, `thinking`, or `goal`.
Append `--motion-reduce` or `--motion-low-power` for static feedback. They use no
microphone, agent turn or relay request. Screenshots and recorded frames were
checked in light and dark appearances. The particle-rendering regression
reproduced an initially empty scene failing to start; a persistent container
fixes it. Waveform and shader lifecycle handlers also use persistent containers.

Validation: all 247 optimized unit tests passed. Seven focused UI scenarios
passed on each phone/tablet simulator, including twelve concurrent local streams
and folder persistence latency. After the lifecycle fixes, six relevant phone
scenarios and three tablet motion scenarios passed again. The signed optimized
device build and strict code-signature verification passed; this motion build
was not installed because the phone was unavailable. Native-only Autoreview
(`.agents/skills/autoreview/scripts/autoreview --mode local --max-priority P2`
in an isolated review worktree) finished clean after both verified lifecycle
findings were fixed. Expo, production, OTA and TestFlight were untouched.

## Image recovery — 18 October 2026

Resolved images now have a separate per-pairing encrypted display cache, bounded
at 16 MiB in memory and 64 MiB / 128 files on disk, with seven-day expiry. The
cache retains original bytes for export and a prepared thumbnail for display.
Image loading observes foreground, connection generation/readiness, pairing scope
and cache availability. A cache arriving after the image displays still saves
that image. Cancelled or stale loads cannot replace another source or pairing.

Validation: 256 optimized native unit tests passed, including nine image/cache
regressions. The image recovery UI scenario passed on iPhone and iPad simulators:
relay readiness, Home/return, offline cold relaunch, preview and delayed cache
initialization. Phone and tablet screenshots were inspected. The same UI scenario
failed with the old image view, confirming the reconnect regression. Native-only
Autoreview (`.agents/skills/autoreview/scripts/autoreview --mode local
--max-priority P2 --prompt-file image-review-context.md` in an isolated worktree)
finished clean after two verified cache-initialization races were fixed. The
optimized development build passed strict signature verification and was installed
on the paired iPhone over Wi-Fi. Expo, production, OTA and TestFlight were unchanged.
