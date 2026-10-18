#!/bin/bash
# Local Apple Development build only; no archive, upload, Expo, OTA or TestFlight.
set -euo pipefail
cd "$(dirname "$0")/.."
pilot_device="${1:-}"
pilot_team="${DEVELOPMENT_TEAM:-YLQ57H32A4}"
if [ -z "$pilot_device" ]; then
  echo 'Usage: ./scripts/install-device.sh <paired device identifier>' >&2
  xcrun devicectl list devices
  exit 1
fi
xcodegen generate
# Keep development signing/sandbox push, with normal Swift runtime optimization.
xcodebuild -project FalconDeckNative.xcodeproj -scheme FalconDeckNative \
  -configuration Debug -destination 'generic/platform=iOS' -derivedDataPath build-device \
  SWIFT_OPTIMIZATION_LEVEL=-O SWIFT_COMPILATION_MODE=wholemodule \
  DEVELOPMENT_TEAM="$pilot_team" -allowProvisioningUpdates build > build-device.log 2>&1 \
  || { tail -60 build-device.log; exit 1; }
xcrun devicectl device install app --device "$pilot_device" \
  build-device/Build/Products/Debug-iphoneos/FalconDeckNative.app
xcrun devicectl device process launch --device "$pilot_device" com.falcondeck.pilot.native
