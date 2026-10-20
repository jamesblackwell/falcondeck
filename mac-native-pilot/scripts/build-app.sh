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
INSTALL=false
LAUNCH=false

usage() {
    cat <<'USAGE'
Usage: build-app.sh [--debug] [--install] [--open]

Build the native Mac prototype as build/FalconDeck Native.app.
  --debug    Build without release optimizations.
  --install  Copy to /Applications/FalconDeck Native.app.
  --open     Open the built app (or installed app with --install).

Uses the running FalconDeck daemon; never starts or restarts it.
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

xcrun swift build --package-path "$PACKAGE_DIR" --configuration "$CONFIGURATION" --product FalconDeckMac
BIN_DIR="$(xcrun swift build --package-path "$PACKAGE_DIR" --configuration "$CONFIGURATION" --show-bin-path)"
mkdir -p "$BUILD_DIR"
STAGING_DIR="$(mktemp -d "$BUILD_DIR/.app.XXXXXX")"
trap 'rm -rf "$STAGING_DIR"' EXIT
STAGED_APP="$STAGING_DIR/$APP_NAME.app"
mkdir -p "$STAGED_APP/Contents/MacOS" "$STAGED_APP/Contents/Resources"
cp "$BIN_DIR/FalconDeckMac" "$STAGED_APP/Contents/MacOS/FalconDeckMac"
cp "$REPO_DIR/apps/desktop/src-tauri/icons/icon.icns" "$STAGED_APP/Contents/Resources/FalconDeck.icns"

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
</dict>
</plist>
PLIST

plutil -lint "$STAGED_APP/Contents/Info.plist"
codesign --force --sign - --identifier "$BUNDLE_ID" "$STAGED_APP"
codesign --verify --strict "$STAGED_APP"
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
