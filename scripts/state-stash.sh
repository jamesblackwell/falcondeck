#!/usr/bin/env bash
set -euo pipefail

# FalconDeck State Stash & Restore CLI
# Allows developer to stash local daemon & WebKit state to test fresh installs,
# and easily restore back to their development state.

STASH_DIR="$HOME/.falcondeck-stashes"
FALCONDECK_DIR="$HOME/.falcondeck"
WEBKIT_DIR="$HOME/Library/WebKit/com.falcondeck.desktop"
WEBKIT_DIR_ALT="$HOME/Library/WebKit/falcondeck-desktop"
CACHES_DIR="$HOME/Library/Caches/com.falcondeck.desktop"
CACHES_DIR_ALT="$HOME/Library/Caches/falcondeck-desktop"

stop_daemon() {
  echo "Checking for running daemon processes..."
  local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local root_dir="$(cd "$script_dir/.." && pwd)"
  if [[ -f "$root_dir/apps/desktop/scripts/stop-dev-daemon.mjs" ]]; then
    node "$root_dir/apps/desktop/scripts/stop-dev-daemon.mjs" 2>/dev/null || true
  fi

  # Also kill any standalone falcondeck-daemon on default ports if running
  pkill -f "falcondeck-daemon.*--port=4123" 2>/dev/null || true
  pkill -f "falcondeck-daemon.*--port=4124" 2>/dev/null || true
  sleep 0.5
}

cmd_stash() {
  stop_daemon
  mkdir -p "$STASH_DIR"
  local timestamp
  timestamp="$(date +%Y%m%d-%H%M%S)"
  local target="$STASH_DIR/stash-$timestamp"

  if [[ ! -d "$FALCONDECK_DIR" ]] && [[ ! -d "$WEBKIT_DIR" ]]; then
    echo "No existing FalconDeck state found (~/.falcondeck or WebKit data). Nothing to stash."
    return 0
  fi

  echo "Creating stash at: $target"
  mkdir -p "$target"

  if [[ -d "$FALCONDECK_DIR" ]]; then
    echo "  -> Moving ~/.falcondeck to stash..."
    mv "$FALCONDECK_DIR" "$target/falcondeck"
  fi

  if [[ -d "$WEBKIT_DIR" ]]; then
    echo "  -> Moving $WEBKIT_DIR to stash..."
    mv "$WEBKIT_DIR" "$target/webkit-com.falcondeck.desktop"
  fi

  if [[ -d "$WEBKIT_DIR_ALT" ]]; then
    echo "  -> Moving $WEBKIT_DIR_ALT to stash..."
    mv "$WEBKIT_DIR_ALT" "$target/webkit-falcondeck-desktop"
  fi

  rm -rf "$CACHES_DIR" "$CACHES_DIR_ALT" 2>/dev/null || true

  echo ""
  echo "✨ FalconDeck state stashed successfully!"
  echo "   Stash location: $target"
  echo "   System is now in a 100% fresh, clean state."
  echo "   Run 'npm run state:restore' whenever you want your state back."
}

cmd_restore() {
  stop_daemon
  local target="${1:-}"

  if [[ -z "$target" ]]; then
    if [[ ! -d "$STASH_DIR" ]]; then
      echo "Error: No stashes found in $STASH_DIR" >&2
      exit 1
    fi

    target="$(find "$STASH_DIR" -maxdepth 1 -name "stash-*" -type d 2>/dev/null | sort -r | head -n 1)"
    if [[ -z "$target" ]]; then
      echo "Error: No stashes found in $STASH_DIR" >&2
      exit 1
    fi
  elif [[ ! -d "$target" && -d "$STASH_DIR/$target" ]]; then
    target="$STASH_DIR/$target"
  fi

  if [[ ! -d "$target" ]]; then
    echo "Error: Stash directory '$target' not found" >&2
    exit 1
  fi

  echo "Restoring state from: $target"

  # If current ~/.falcondeck exists and is not empty, offer safety or move to auto-stash
  if [[ -d "$FALCONDECK_DIR" ]]; then
    local auto_ts
    auto_ts="$(date +%Y%m%d-%H%M%S)"
    local current_stash="$STASH_DIR/pre-restore-replaced-$auto_ts"
    echo "  -> Backing up currently active state to: $current_stash"
    mkdir -p "$current_stash"
    mv "$FALCONDECK_DIR" "$current_stash/falcondeck"
    if [[ -d "$WEBKIT_DIR" ]]; then
      mv "$WEBKIT_DIR" "$current_stash/webkit"
    fi
  fi

  if [[ -d "$target/falcondeck" ]]; then
    echo "  -> Restoring ~/.falcondeck..."
    cp -cR "$target/falcondeck" "$FALCONDECK_DIR" 2>/dev/null || cp -R "$target/falcondeck" "$FALCONDECK_DIR"
  fi

  if [[ -d "$target/webkit-com.falcondeck.desktop" ]]; then
    echo "  -> Restoring WebKit data to $WEBKIT_DIR..."
    mkdir -p "$(dirname "$WEBKIT_DIR")"
    rm -rf "$WEBKIT_DIR"
    cp -cR "$target/webkit-com.falcondeck.desktop" "$WEBKIT_DIR" 2>/dev/null || cp -R "$target/webkit-com.falcondeck.desktop" "$WEBKIT_DIR"
  fi

  if [[ -d "$target/webkit-falcondeck-desktop" ]]; then
    mkdir -p "$(dirname "$WEBKIT_DIR_ALT")"
    rm -rf "$WEBKIT_DIR_ALT"
    cp -cR "$target/webkit-falcondeck-desktop" "$WEBKIT_DIR_ALT" 2>/dev/null || cp -R "$target/webkit-falcondeck-desktop" "$WEBKIT_DIR_ALT"
  fi

  echo ""
  echo "✨ State restored successfully from: $target"
}

cmd_status() {
  echo "=== FalconDeck Current State ==="
  if [[ -d "$FALCONDECK_DIR" ]]; then
    local size
    size="$(du -sh "$FALCONDECK_DIR" 2>/dev/null | cut -f1)"
    echo "Active ~/.falcondeck: Present (size: $size)"
    if [[ -f "$FALCONDECK_DIR/daemon-state.json" ]]; then
      local count
      count=$(grep -o '"path"' "$FALCONDECK_DIR/daemon-state.json" 2>/dev/null | wc -l | tr -d ' ' || echo "0")
      echo "  -> Registered projects: ~$count"
    fi
    if [[ -f "$FALCONDECK_DIR/falcondeck.json" ]]; then
      echo "  -> Preferences: falcondeck.json present"
    fi
    if [[ -f "$FALCONDECK_DIR/extensions-state.json" ]]; then
      echo "  -> Extensions state: extensions-state.json present"
    fi
    if [[ -f "$FALCONDECK_DIR/agent-control.json" ]]; then
      echo "  -> Automations: agent-control.json present"
    fi
  else
    echo "Active ~/.falcondeck: None (Clean / Fresh)"
  fi

  if [[ -d "$WEBKIT_DIR" ]]; then
    echo "WebKit LocalStorage: Present ($WEBKIT_DIR)"
  else
    echo "WebKit LocalStorage: None (Clean / Fresh)"
  fi

  echo ""
  echo "=== Available Stashes ($STASH_DIR) ==="
  if [[ -d "$STASH_DIR" ]]; then
    local found=0
    for d in "$STASH_DIR"/stash-*; do
      if [[ -d "$d" ]]; then
        found=1
        local name
        name="$(basename "$d")"
        local dsize
        dsize="$(du -sh "$d" 2>/dev/null | cut -f1)"
        echo "  - $name (size: $dsize)"
      fi
    done
    if [[ $found -eq 0 ]]; then
      echo "  (No stashes found)"
    fi
  else
    echo "  (No stash directory yet)"
  fi
}

case "${1:-status}" in
  stash|fresh|clean)
    cmd_stash
    ;;
  restore)
    shift
    cmd_restore "${1:-}"
    ;;
  status)
    cmd_status
    ;;
  *)
    echo "Usage: $0 {stash|restore [stash-name]|status}"
    exit 1
    ;;
esac
