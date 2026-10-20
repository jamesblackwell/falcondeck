#!/bin/bash
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$PACKAGE_DIR/.." && pwd)"
BUILD_DIR="$PACKAGE_DIR/build"
APP_NAME="FalconDeck Native"
BUNDLE_ID="com.falcondeck.mac-native-pilot"
APP_PATH="$BUILD_DIR/$APP_NAME.app"
INSTALL_PATH="/Applications/$APP_NAME.app"
CONFIGURATION="release"
RUST_TARGET_DIR="${FALCONDECK_NATIVE_CARGO_TARGET_DIR:-/tmp/falcondeck-native-runtime-target}"
SIGNING_IDENTITY="${FALCONDECK_NATIVE_SIGNING_IDENTITY:--}"
INSTALL=false
LAUNCH=false

usage() {
    cat <<'USAGE'
Usage: build-app.sh [--debug] [--install] [--open]

Build the native Mac prototype as build/FalconDeck Native.app.
  --debug    Build without release optimizations.
  --install  Copy to /Applications/FalconDeck Native.app.
  --open     Open the built app (or installed app with --install).

Bundles the Rust daemon, extension runtime, computer-use driver and speech helper.
The app attaches to an existing FalconDeck daemon when one is running.
Set FALCONDECK_NATIVE_SIGNING_IDENTITY for Developer ID signing.
USAGE
}

for argument in "$@"; do
    case "$argument" in
        --debug) CONFIGURATION="debug" ;;
        --install) INSTALL=true ;;
        --open) LAUNCH=true ;;
        --help|-h) usage; exit 0 ;;
        *) printf 'Unknown option: %s\n' "$argument" >&2; usage >&2; exit 2 ;;
    esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
    printf 'This SwiftUI app requires macOS.\n' >&2
    exit 1
fi

node "$PACKAGE_DIR/Sources/FalconDeckMac/Workspaces/ExtensionHost/build.mjs"

RUST_PROFILE="dev"
if [[ "$CONFIGURATION" == "release" ]]; then RUST_PROFILE="release"; fi
CARGO_TARGET_DIR="$RUST_TARGET_DIR" cargo build --manifest-path "$REPO_DIR/Cargo.toml" --package falcondeck-native-host --locked --profile "$RUST_PROFILE"
RUST_HOST_LIBRARY="$RUST_TARGET_DIR/$CONFIGURATION/libfalcondeck_native_host.dylib"
RUST_TARGET_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
for sidecar in deno cua-driver falcondeck-parakeet; do
    candidate="$REPO_DIR/apps/desktop/src-tauri/binaries/$sidecar-$RUST_TARGET_TRIPLE"
    if [[ ! -x "$candidate" ]]; then
        printf 'Missing bundled %s for %s. Run the matching npm runtime:prepare command from the repository root.\n' "$sidecar" "$RUST_TARGET_TRIPLE" >&2
        exit 1
    fi
done

xcrun swift build --package-path "$PACKAGE_DIR" --configuration "$CONFIGURATION" --product FalconDeckMac
BIN_DIR="$(xcrun swift build --package-path "$PACKAGE_DIR" --configuration "$CONFIGURATION" --show-bin-path)"
mkdir -p "$BUILD_DIR"
STAGING_DIR="$(mktemp -d "$BUILD_DIR/.app.XXXXXX")"
trap 'rm -rf "$STAGING_DIR"' EXIT
STAGED_APP="$STAGING_DIR/$APP_NAME.app"
mkdir -p "$STAGED_APP/Contents/MacOS" "$STAGED_APP/Contents/Resources" "$STAGED_APP/Contents/Frameworks"
cp "$BIN_DIR/FalconDeckMac" "$STAGED_APP/Contents/MacOS/FalconDeckMac"
cp "$REPO_DIR/apps/desktop/src-tauri/icons/icon.icns" "$STAGED_APP/Contents/Resources/FalconDeck.icns"
cp "$RUST_HOST_LIBRARY" "$STAGED_APP/Contents/Frameworks/libfalcondeck_native_host.dylib"
install_name_tool -id '@rpath/libfalcondeck_native_host.dylib' "$STAGED_APP/Contents/Frameworks/libfalcondeck_native_host.dylib"
for sidecar in deno cua-driver falcondeck-parakeet; do
    cp "$REPO_DIR/apps/desktop/src-tauri/binaries/$sidecar-$RUST_TARGET_TRIPLE" "$STAGED_APP/Contents/MacOS/$sidecar"
done
if [[ -d "$REPO_DIR/apps/desktop/parakeet-runtime/licenses" ]]; then
    mkdir -p "$STAGED_APP/Contents/Resources/licenses"
    ditto "$REPO_DIR/apps/desktop/parakeet-runtime/licenses" "$STAGED_APP/Contents/Resources/licenses/parakeet"
fi
# SwiftPM keeps dynamic frameworks and resource bundles next to the executable.
# Preserve them in the layout expected by Bundle.module and @rpath loading.
shopt -s nullglob
for bundle in "$BIN_DIR"/*.bundle; do
    ditto "$bundle" "$STAGED_APP/Contents/Resources/$(basename "$bundle")"
done
for framework in "$BIN_DIR"/*.framework; do
    ditto "$framework" "$STAGED_APP/Contents/Frameworks/$(basename "$framework")"
done
if [[ -d "$BIN_DIR/Sparkle.framework" ]]; then
    install_name_tool -add_rpath '@executable_path/../Frameworks' "$STAGED_APP/Contents/MacOS/FalconDeckMac"
fi

cat > "$STAGED_APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key><string>en</string>
    <key>CFBundleDisplayName</key><string>$APP_NAME</string>
    <key>CFBundleExecutable</key><string>FalconDeckMac</string>
    <key>CFBundleIconFile</key><string>FalconDeck.icns</string>
    <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
    <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
    <key>CFBundleName</key><string>$APP_NAME</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.1.0</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSPrincipalClass</key><string>NSApplication</string>
    <key>NSMicrophoneUsageDescription</key><string>FalconDeck records your microphone when you start dictation or a voice conversation.</string>
    <key>NSSpeechRecognitionUsageDescription</key><string>FalconDeck transcribes your dictation when you choose Apple Speech.</string>
    <key>NSAppleEventsUsageDescription</key><string>FalconDeck controls applications when you enable computer use.</string>
</dict>
</plist>
PLIST

python3 - "$STAGED_APP/Contents/Info.plist" <<'PY'
import os
import plistlib
import sys
import base64
from urllib.parse import urlparse

feed = os.environ.get("FALCONDECK_NATIVE_UPDATE_FEED_URL", "").strip()
public_key = os.environ.get("FALCONDECK_NATIVE_UPDATE_PUBLIC_KEY", "").strip()
if bool(feed) != bool(public_key):
    raise SystemExit("Set both FALCONDECK_NATIVE_UPDATE_FEED_URL and FALCONDECK_NATIVE_UPDATE_PUBLIC_KEY to configure native updates.")
if feed:
    address = urlparse(feed)
    if address.scheme != "https" or not address.netloc or address.username or address.password or address.path.lower().endswith(".json"):
        raise SystemExit("The native update feed must be a public HTTPS address.")
    try:
        if len(base64.b64decode(public_key, validate=True)) != 32:
            raise ValueError("Invalid Ed25519 key length")
    except ValueError:
        raise SystemExit("The native update public key must be a base64 encoded 32-byte Ed25519 key.")
    path = sys.argv[1]
    with open(path, "rb") as source:
        info = plistlib.load(source)
    info["SUFeedURL"] = feed
    info["SUPublicEDKey"] = public_key
    info["SUEnableAutomaticChecks"] = False
    with open(path, "wb") as destination:
        plistlib.dump(info, destination)
PY

plutil -lint "$STAGED_APP/Contents/Info.plist"
for binary in "$STAGED_APP/Contents/MacOS/deno" "$STAGED_APP/Contents/MacOS/cua-driver" "$STAGED_APP/Contents/MacOS/falcondeck-parakeet" "$STAGED_APP/Contents/Frameworks/libfalcondeck_native_host.dylib"; do
    codesign --force --sign "$SIGNING_IDENTITY" --options runtime --entitlements "$REPO_DIR/apps/desktop/src-tauri/entitlements.plist" "$binary"
done
# Sign nested Sparkle services before their containing framework/app.
for framework in "$STAGED_APP/Contents/Frameworks"/*.framework; do
    if [[ -f "$framework/Versions/Current/Autoupdate" ]]; then
        codesign --force --sign "$SIGNING_IDENTITY" --options runtime "$framework/Versions/Current/Autoupdate"
    fi
    while IFS= read -r -d '' nested; do
        codesign --force --sign "$SIGNING_IDENTITY" --options runtime "$nested"
    done < <(find "$framework" -depth \( -name '*.xpc' -o -name '*.app' \) -print0)
    codesign --force --sign "$SIGNING_IDENTITY" --options runtime "$framework"
done
codesign --force --sign "$SIGNING_IDENTITY" --options runtime --entitlements "$REPO_DIR/apps/desktop/src-tauri/entitlements.plist" --identifier "$BUNDLE_ID" "$STAGED_APP"
codesign --verify --strict --deep "$STAGED_APP"
rm -rf "$APP_PATH"
mv "$STAGED_APP" "$APP_PATH"
printf 'Built %s\n' "$APP_PATH"

APP_TO_OPEN="$APP_PATH"
if $INSTALL; then
    if [[ -e "$INSTALL_PATH" ]]; then
        EXISTING_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$INSTALL_PATH/Contents/Info.plist" 2>/dev/null || true)"
        if [[ "$EXISTING_ID" != "$BUNDLE_ID" ]]; then
            printf 'Refusing to replace a different app at %s\n' "$INSTALL_PATH" >&2
            exit 1
        fi
        rm -rf "$INSTALL_PATH"
    fi
    ditto "$APP_PATH" "$INSTALL_PATH"
    APP_TO_OPEN="$INSTALL_PATH"
    printf 'Installed %s\n' "$INSTALL_PATH"
fi

if $LAUNCH; then
    open "$APP_TO_OPEN"
fi
