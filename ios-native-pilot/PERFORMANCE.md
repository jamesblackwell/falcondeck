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

## Conversation presentation — 18 October 2026

Cached chats reuse their existing session in the opening frame. Loaded messages
always remain visible and interactive, independently of UIKit row realization
or scroll position. A previous end-row readiness gate could remain unset after
navigation or resume and leave real content invisible; that gate and its queued
publication have been removed. Row-layout callbacks still align the bottom
before display. History/token revisions suppress native insertion animations;
explicit disclosure and press animations remain.

The detail NavigationStack keeps its controller identity across sidebar selections;
only the destination and explicit nested navigation path reset. Settings,
connection logs and extension panels use that path. A stable root container also
owns the root title so a disappearing destination cannot clear its replacement's
navigation title. Rebuilding the stack while the compact column opened
could deliver onDisappear to the newly visible transcript, cancel scrolling and
read acknowledgement, and strand the old visibility gate. Repeated navigation and
resume checks cover this sequence; nested Settings navigation also resets when
switching destinations.

Refreshes preserve the visible reading message and its relative position. When
List recycles that cell, restoration resolves its stable ID against the current
collection's row count and realized cell identities before using an index. Stale
metadata and disappearing cells are rejected. Gestures, explicit jumps and
navigation cancel restoration. No fixed loading delay, permanent frame timer or
new data store is used in production; the slow history fixture is local QA only.

Validation: all 260 optimized unit tests passed, including ordinary-row following
without an end marker, reactivation, and real UICollectionView recycled-cell/index
regressions. Focused iPhone/iPad simulator checks cover cached/full-history
replacement, reading during refresh, three reopen/background/foreground cycles,
visible chat titles, and switching out of nested Settings. Settings navigation,
connection diagnostics, streaming/reading and image recovery checks also passed
during this fix. On the physical iPhone the final signed build passed three
reopen/resume cycles with visible messages and title using local content; earlier
checks also covered nested navigation. Screenshots were visually inspected.
Native-only Autoreview (`.agents/skills/autoreview/scripts/autoreview --mode local
--max-priority P2 --prompt-file blank-review-context.md` in an isolated worktree)
finished clean. The optimized development build passed strict signature
verification, was installed over Wi-Fi, and was relaunched without QA arguments
for its normal paired session. QA did not start any turns on the paired relay. Expo,
production, OTA and TestFlight were unchanged.


## Model catalog recovery — 18 October 2026

The picker keeps waiting through a connecting workspace placeholder, even when
that replacement briefly resets `models_loading` to false. This was incorrectly
shown as a terminal “Codex reconnecting” error before the real catalog arrived.
Nonempty live catalogs now clear old picker errors immediately, and returning
connections make visible composers eligible to retry. Model and reasoning
selections and the existing scoped encrypted catalog cache remain intact.

Explicit retry requests both the existing compact refresh and provider hydration.
A coalesced refresh can return before its snapshot is delivered, so it is not a
completion barrier or a reason to skip hydration. Concurrent picker callers
still share one request; terminal empty results, authentication/error labels,
connection-generation guards and the bounded loading deadline remain.

Validation: all 266 optimized unit tests passed. New regressions cover reconnect
placeholders, late catalog recovery, observable updates, reconnect retry, and
concurrent forced retries with delayed snapshot delivery. Seven iPhone and three
iPad simulator cases passed across Codex, Claude and OpenCode, including new and
existing tasks, reasoning persistence, model search and retry. The final retry
and reconnect UI cases passed again after review. Physical iPhone QA read the
actual paired Codex catalog and reasoning without sending a turn or changing a
selection. Native-only Autoreview (`.agents/skills/autoreview/scripts/autoreview
--mode local --max-priority P2 --prompt-file models-review-context.md` in an
isolated worktree) finished clean after fixing its refresh-ordering finding.
The signed development build was installed over Wi-Fi. No Expo, daemon, relay,
production, OTA or TestFlight code or deployments changed.

## Desktop renames and pinned project icons — 18 October 2026

The daemon's text coalescer advances a merged delta's sequence while preserving
its original queue slot. A following thread summary can therefore arrive with a
lower sequence. The native global sequence high-water mark silently discarded
that summary, including desktop renames. Delivery deduplication now uses a
bounded set of 8,192 recent sequences instead. Unseen lower sequences apply;
duplicate text still applies only once. Connection resets clear the set, and
existing timestamp guards continue to reject stale summaries and history reads.

Globally pinned tasks show their project's existing favicon or fallback glyph.
Row height, touch targets and activity indicators remain intact. Project headings
and pins share pending icon reads and a pairing-scoped memory cache of at most
64 decoded thumbnails, each at most 128 pixels. Reconnects retain those images;
new etags fetch fresh ones. Changing the pairing cancels pending reads and clears
the cache. Decoding runs off the UI actor; failed image reads remain retryable.

Validation: the new rename regression failed before the fix for both batched and
separate deliveries. All 272 optimized unit tests passed on the final source.
Five iPhone simulator UI checks passed, including the new rename scenario and
existing loading, reading-position, background/reopen and navigation regressions.
The rename scenario also passed on iPad and the physical iPhone using only local
test content. It verifies the open header, the pinned row and a delayed history
response that must not restore the old name. Phone/tablet screenshots were
visually inspected. Native-only Autoreview (`.agents/skills/autoreview/scripts/autoreview
--mode local --max-priority P2 --prompt-file rename-review-context.md` in an
isolated worktree) finished clean. The signed standalone development build was
installed over Wi-Fi and launched normally afterward. No real agent turns were
started; Expo, production, OTA and TestFlight were unchanged.

## Composer interaction polish — 18 October 2026

Composer controls retain their existing order and 48pt frames. Token-based
surfaces, fine edge highlights, spring compression and pointer feedback give
the buttons more depth. The model control stays flat at rest so it does not
become a wide empty chip on iPad. Recording controls retain their full painted
size and the existing Canvas waveform.

A local Metal touch response adds a soft ring and short highlight on a press or
when Send becomes ready. SwiftUI keyframes finish in 0.55 seconds with transparent
endpoints. No idle timeline, whole-composer shader, transcript movement or glass
opacity animation is added. Inactive scenes, Reduce Motion and Low Power Mode
disable the shader; ordinary low-power press feedback remains available.

Native sensory feedback covers composer presses, explicit model/reasoning and
agent-setting choices, project/folder disclosures, navigation and options,
jump-to-latest, goal opening/live completion and transcription success/failure.
Feedback is scene-active and does not follow streaming tokens or automatic
catalog reconciliation. Existing goal identity and recording-ownership guards
also govern their completion/error feedback. Hardware and system preferences
decide which haptics play.

Validation: all 272 optimized unit tests passed. Seven iPhone and three iPad
simulator UI cases passed for control order/size, stop/queue/send, recording
states and draft retention, goal geometry, folder races, Reduce Motion and Low
Power Mode. Two tablet cases passed again after the final visual refinement.
Dark and light screenshots were inspected; an AXe held-press capture and video
verified the shader response and settings-sheet opening. Native-only Autoreview
(`.agents/skills/autoreview/scripts/autoreview --mode local --max-priority P2
--prompt-file controls-review-context.md` in an isolated worktree) finished clean;
the subsequent model-chip paint adjustment was isolated styling.

The final signed development build passed strict signature verification and was
installed over Wi-Fi. Physical iPhone UI automation did not initialize because
device authorization was canceled; no on-device interaction or physical haptic
validation is claimed. The app was relaunched normally into its paired session.
No real agent turns were started. Expo, production, OTA and TestFlight were
unchanged.
