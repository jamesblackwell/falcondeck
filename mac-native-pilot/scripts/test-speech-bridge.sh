#!/bin/sh
set -eu
pilot_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
xcrun clang -fobjc-arc -fblocks -Wno-deprecated-declarations \
  -I "$pilot_root/Sources/NativeSpeechBridge/include" \
  "$pilot_root/Tests/NativeSpeechBridgeTests/NativeSpeechBridgeTests.m" \
  -framework AppKit -framework ApplicationServices -framework AVFoundation \
  -framework Speech -framework Carbon -framework IOKit -framework CoreMedia \
  -o "$test_dir/native-speech-bridge-tests"
"$test_dir/native-speech-bridge-tests"
