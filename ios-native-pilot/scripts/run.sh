#!/bin/bash
# Local simulator only. Uses ad-hoc simulator signing so Keychain is available.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v xcodegen >/dev/null; then
  echo "Install XcodeGen first: brew install xcodegen" >&2
  exit 1
fi
pilot_udid="${SIMULATOR_UDID:-}"
if [ -z "$pilot_udid" ]; then
  pilot_udid="$(xcrun simctl list devices available --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next((v["udid"] for vs in d["devices"].values() for v in vs if v["name"]=="FalconDeck Native Pilot"),""))')"
fi
if [ -z "$pilot_udid" ]; then
  pilot_runtime="$(xcrun simctl list runtimes --json | python3 -c 'import json,sys; print(next(v["identifier"] for v in reversed(json.load(sys.stdin)["runtimes"]) if v.get("isAvailable") and "iOS" in v["identifier"]))')"
  pilot_udid="$(xcrun simctl create 'FalconDeck Native Pilot' com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro "$pilot_runtime")"
fi
pilot_state="$(xcrun simctl list devices --json | PILOT_UDID="$pilot_udid" python3 -c 'import json,os,sys; print(next(v["state"] for vs in json.load(sys.stdin)["devices"].values() for v in vs if v["udid"]==os.environ["PILOT_UDID"]))')"
if [ "$pilot_state" != "Booted" ]; then xcrun simctl boot "$pilot_udid"; fi
xcrun simctl bootstatus "$pilot_udid" -b
xcodegen generate
xcodebuild -project FalconDeckNative.xcodeproj -scheme FalconDeckNative \
  -configuration Debug -sdk iphonesimulator -destination "id=$pilot_udid" \
  -derivedDataPath build build > build.log 2>&1 || { tail -60 build.log; exit 1; }
xcrun simctl terminate "$pilot_udid" com.falcondeck.pilot.native >/dev/null 2>&1 || true
xcrun simctl install "$pilot_udid" build/Build/Products/Debug-iphonesimulator/FalconDeckNative.app
xcrun simctl launch "$pilot_udid" com.falcondeck.pilot.native "$@"
echo "Running on FalconDeck Native Pilot ($pilot_udid). Select it in Simulator to try the app."
