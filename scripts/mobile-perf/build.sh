#!/bin/bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/../.." && pwd)"
task_udid="${1:?Pass the dedicated simulator UDID}"
task_derived="${2:-$task_root/var/mobile-perf/DerivedData}"
mkdir -p "$task_derived"
task_derived="$(cd "$task_derived" && pwd)"
task_app="$task_derived/Build/Products/Release-iphonesimulator/FalconDeck.app"
cd "$task_root"
if [ "${3:-}" = "--bundle-only" ]; then
  test -d "$task_app"
  cd apps/mobile
  EXPO_PUBLIC_PERF_QA=1 npx expo export:embed --platform ios --dev false --bytecode \
    --entry-file src/entry.ts --bundle-output "$task_app/main.jsbundle" --assets-dest "$task_app"
else
  EXPO_PUBLIC_PERF_QA=1 xcodebuild -workspace apps/mobile/ios/FalconDeck.xcworkspace \
    -scheme FalconDeck -configuration Release -sdk iphonesimulator -destination "id=$task_udid" \
    -derivedDataPath "$task_derived" CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- \
    CODE_SIGNING_REQUIRED=NO IPHONEOS_DEPLOYMENT_TARGET=16.4 ONLY_ACTIVE_ARCH=YES
fi
# Change only the disposable product; OTA must not replace the measured bundle.
/usr/libexec/PlistBuddy -c 'Set :EXUpdatesEnabled false' "$task_app/Expo.plist"
codesign --force --sign - --preserve-metadata=entitlements "$task_app"
xcrun simctl terminate "$task_udid" com.falcondeck.mobile >/dev/null 2>&1 || true
xcrun simctl install "$task_udid" "$task_app"
printf 'Installed performance build: %s\n' "$task_app"
