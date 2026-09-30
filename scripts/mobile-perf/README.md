# Mobile CPU hill climbing

Use a dedicated iOS simulator and bundled-JS Release builds. The opt-in
`EXPO_PUBLIC_PERF_QA=1` route renders production components with synthetic data.
It is disabled in ordinary builds. This does not pair with, restart, or change
the desktop daemon.

```sh
xcrun simctl create 'FalconDeck CPU Lab' com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-26-5
# Copy the returned UUID into task_sim.
task_sim='<UUID>'
xcrun simctl boot "$task_sim"
bash scripts/mobile-perf/build.sh "$task_sim"
python3 scripts/mobile-perf/run.py --udid "$task_sim" --label baseline \
  --app var/mobile-perf/DerivedData/Build/Products/Release-iphonesimulator/FalconDeck.app \
  --output var/mobile-perf/baseline.json
```

For each iteration:

1. Capture a profile (`sample <app-pid> 5 1 -file <path>`) and state one cause.
2. Change one cause. Run its regression checks.
3. Rebuild with `build.sh`; use its third argument `--bundle-only` for JS-only
   changes. Native changes require a full incremental build.
4. Repeat the identical workload with a new `--label` and `--output`.
5. Compare the median of three process CPU means and physical-footprint
   medians. Keep a change when its target improves consistently beyond noise,
   other workloads do not materially regress, and behavior remains correct.
   If differences are small, alternate baseline/candidate runs before deciding.
6. Commit the accepted change and record the metrics. Stop when the next
   measured candidate no longer improves the target or needs a different
   workload. Never claim a win from a code inspection alone.

`run.py` relaunches for each trial, verifies the workload through AXe, warms up
for eight seconds, then samples for twenty seconds. CPU is the delta of Darwin
process user+system time, as a percentage of one core. Memory is physical
footprint, with RSS also recorded. It samples outside the app, so measurements
do not require the app's performance overlay. JSON records the bundle hash and
every sample; incomplete runs retain only completed trials.

Workloads: `idle`, `diamond` (one activity marker), `diamonds` (20 markers),
`hidden` (20 mounted, covered markers), `streaming` (a long answer growing at
10 updates/second), and `sampling` (diagnostic native calls at 100/second to
amplify resource leaks). Use `--scenarios`, `--seconds`, and `--repeats` to
select a bounded experiment. Synthetic workloads isolate costs; follow them
with normal navigation, scrolling, pairing, and real relay traffic checks.

Simulator CPU/memory trends are useful; battery consumption and thermal
behavior require physical-device verification. Release-mode profiling is also
recommended by [React Native](https://reactnative.dev/docs/profiling).

When finished, shut down and delete only the dedicated simulator:
`xcrun simctl shutdown "$task_sim"` then `xcrun simctl delete "$task_sim"`.
