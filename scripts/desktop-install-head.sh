#!/usr/bin/env bash
# Build and install FalconDeck.app from committed HEAD in a throwaway worktree,
# so other agents' uncommitted edits in the shared tree never ship.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
ref="${1:-HEAD}"
worktree="$(mktemp -d "${TMPDIR:-/tmp}/falcondeck-install.XXXXXX")"
cleanup() { git -C "$root" worktree remove --force "$worktree" >/dev/null 2>&1 || rm -rf "$worktree"; }
trap cleanup EXIT

git -C "$root" worktree add --detach "$worktree" "$ref" >/dev/null
echo "Building $(git -C "$worktree" log --oneline -1) in $worktree"

# Sidecar binaries are gitignored; reuse the shared tree's copies.
binaries=apps/desktop/src-tauri/binaries
mkdir -p "$worktree/$binaries"
cp "$root/$binaries"/* "$worktree/$binaries/"

[ -d /opt/homebrew/opt/rustup/bin ] && export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
cd "$worktree"
npm ci --silent
make desktop-install \
  CARGO_TARGET_DIR="$root/target" \
  CARGO_PRUNE_DAYS=0 \
  DESKTOP_BUNDLE_APP="$root/target/release/bundle/macos/FalconDeck.app"
