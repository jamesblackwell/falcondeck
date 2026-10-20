#!/bin/bash
set -euo pipefail
test_dir="$(cd "$(dirname "$0")" && pwd)"
project_dir="$(cd "$test_dir/../.." && pwd)"
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/falcondeck-controller-build.XXXXXX")"
trap 'rm -rf "$build_dir"' EXIT
swiftc -swift-version 5 -parse-as-library -emit-module -emit-object -module-name NativeSpeechBridge \
    "$test_dir/NativeSpeechBridge.swift" -emit-module-path "$build_dir/NativeSpeechBridge.swiftmodule" -o "$build_dir/bridge.o"
swiftc -swift-version 5 -parse-as-library -I "$build_dir" \
    "$project_dir/Sources/FalconDeckMac/Wire.swift" \
    "$project_dir/Sources/FalconDeckMac/Speech/NativeVoiceModels.swift" \
    "$project_dir/Sources/FalconDeckMac/Speech/NativeSpeechController.swift" \
    "$test_dir/Fixtures.swift" "$test_dir/main.swift" "$build_dir/bridge.o" -o "$build_dir/controller-tests"
"$build_dir/controller-tests"
