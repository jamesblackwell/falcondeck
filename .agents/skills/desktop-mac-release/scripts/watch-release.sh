#!/usr/bin/env bash
# Watch a GitHub Actions run until it completes. Prints one DONE/FAILED line.
# Usage: watch-release.sh <run-id>
set -euo pipefail
RUN_ID=${1:?run id}
DIR=${WATCH_LOG_DIR:-$HOME/.grok/long-running-background-tasks}
mkdir -p "$DIR"
LOG=$DIR/watch_desktop_release_${RUN_ID}.log

run_status() {
  gh run view "$RUN_ID" --json status --jq .status
}
run_conclusion() {
  gh run view "$RUN_ID" --json conclusion --jq '.conclusion // ""'
}
run_url() {
  gh run view "$RUN_ID" --json url --jq .url
}

while :; do
  st=$(run_status) || { echo "FAILED: could not read GitHub run $RUN_ID"; exit 1; }
  conc=$(run_conclusion)
  url=$(run_url)
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $st $conc" >>"$LOG"
  case "$st" in
    completed)
      if [ "$conc" = success ]; then
        echo "DONE: release-desktop $RUN_ID succeeded $url"
        exit 0
      fi
      echo "FAILED: release-desktop $RUN_ID $conc $url"
      exit 1
      ;;
    waiting)
      echo "FAILED: release-desktop $RUN_ID is waiting for approval $url"
      exit 1
      ;;
  esac
  sleep 30
done
