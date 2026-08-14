#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
transport=${OPENCODE_TRANSPORT:-auto}
model=${OPENCODE_MODEL:-default}
timeout_seconds=${OPENCODE_TIMEOUT_SECONDS:-90}

case "$transport" in
    auto|native|acp) ;;
    *)
        echo "OPENCODE_TRANSPORT must be auto, native, or acp" >&2
        exit 2
        ;;
esac

for command_name in cargo curl jq opencode ruby; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "OpenCode QA requires '$command_name' on PATH" >&2
        exit 2
    fi
done

qa_root=${TMPDIR:-/tmp}
qa_dir=$(mktemp -d "$qa_root/falcondeck-opencode-qa.XXXXXX")
daemon_pid=
keep_artifacts=1
cleaned_up=0

cleanup() {
    if [ "$cleaned_up" -eq 1 ]; then
        return
    fi
    cleaned_up=1
    if [ -n "$daemon_pid" ]; then
        kill "$daemon_pid" >/dev/null 2>&1 || true
        wait "$daemon_pid" >/dev/null 2>&1 || true
    fi
    if [ "$keep_artifacts" -eq 0 ]; then
        case "$qa_dir" in
            "$qa_root"/falcondeck-opencode-qa.*) rm -rf -- "$qa_dir" ;;
        esac
    else
        echo "[opencode-qa] diagnostics retained at $qa_dir" >&2
    fi
}
trap cleanup EXIT INT TERM

jq -n \
    --arg transport "$transport" \
    '{providers:{opencode:{label:"OpenCode",command:["opencode","acp"],transport:$transport}}}' \
    >"$qa_dir/providers.json"

port=$(ruby -rsocket -e 'server = TCPServer.new("127.0.0.1", 0); puts server.addr[1]; server.close')

echo "[opencode-qa] building FalconDeck daemon" >&2
cargo build -q -p falcondeck-daemon --bin falcondeck-daemon

echo "[opencode-qa] starting isolated daemon on port $port" >&2
FALCONDECK_STATE_PATH="$qa_dir/daemon-state.json" \
RUST_LOG=${RUST_LOG:-falcondeck_daemon=debug} \
    "$repo_root/target/debug/falcondeck-daemon" --port="$port" \
    >"$qa_dir/daemon.log" 2>&1 &
daemon_pid=$!
base_url="http://127.0.0.1:$port"

ready=0
attempt=0
while [ "$attempt" -lt 120 ]; do
    if curl -fsS "$base_url/api/health" >/dev/null 2>&1; then
        ready=1
        break
    fi
    if ! kill -0 "$daemon_pid" >/dev/null 2>&1; then
        echo "[opencode-qa] daemon exited during startup" >&2
        tail -100 "$qa_dir/daemon.log" >&2
        exit 1
    fi
    attempt=$((attempt + 1))
    sleep 0.25
done
if [ "$ready" -ne 1 ]; then
    echo "[opencode-qa] daemon did not become ready" >&2
    tail -100 "$qa_dir/daemon.log" >&2
    exit 1
fi

post_json() {
    label=$1
    url=$2
    body=$3
    status=$(curl -sS -o "$qa_dir/response.json" -w '%{http_code}' \
        -H 'content-type: application/json' -d "$body" "$url")
    case "$status" in
        2??) cat "$qa_dir/response.json" ;;
        *)
            echo "[opencode-qa] $label returned HTTP $status" >&2
            jq . "$qa_dir/response.json" >&2 2>/dev/null || cat "$qa_dir/response.json" >&2
            return 1
            ;;
    esac
}

get_json() {
    label=$1
    url=$2
    status=$(curl -sS -o "$qa_dir/response.json" -w '%{http_code}' "$url")
    case "$status" in
        2??) cat "$qa_dir/response.json" ;;
        *)
            echo "[opencode-qa] $label returned HTTP $status" >&2
            jq . "$qa_dir/response.json" >&2 2>/dev/null || cat "$qa_dir/response.json" >&2
            return 1
            ;;
    esac
}

echo "[opencode-qa] connecting workspace $repo_root" >&2
workspace=$(post_json \
    "connect workspace" \
    "$base_url/api/workspaces/connect" \
    "$(jq -n --arg path "$repo_root" '{path:$path}')")
workspace_id=$(printf '%s' "$workspace" | jq -er '.id')

echo "[opencode-qa] starting OpenCode thread (requested transport: $transport)" >&2
thread=$(post_json \
    "start thread" \
    "$base_url/api/workspaces/$workspace_id/threads" \
    "$(jq -n --arg model "$model" '{
        workspace_id:"",
        provider:"opencode",
        model_id:$model,
        collaboration_mode_id:"build",
        approval_policy:"on-request",
        permission_mode:"always-approve",
        isolation:"project_folder"
    }')")
thread_id=$(printf '%s' "$thread" | jq -er '.thread.id')
selected_transport=$(printf '%s' "$thread" | jq -r '.thread.provider_transport // "unknown"')
echo "[opencode-qa] selected transport: $selected_transport" >&2

expected_reply=FALCONDECK_OPENCODE_SMOKE_OK
echo "[opencode-qa] sending turn with model $model" >&2
post_json \
    "send turn" \
    "$base_url/api/workspaces/$workspace_id/threads/$thread_id/turns" \
    "$(jq -n --arg prompt "Reply with exactly: $expected_reply" '{
        workspace_id:"",
        thread_id:"",
        inputs:[{type:"text",text:$prompt}],
        selected_skills:[],
        model_id:null,
        reasoning_effort:null,
        approval_policy:null,
        service_tier:null,
        steer:false
    }')" >/dev/null

started_at=$(date +%s)
while :; do
    detail=$(get_json \
        "read thread" \
        "$base_url/api/workspaces/$workspace_id/threads/$thread_id")
    printf '%s' "$detail" >"$qa_dir/thread-detail.json"
    status=$(printf '%s' "$detail" | jq -r '.thread.status')
    if [ "$status" != "running" ]; then
        printf '%s' "$detail" | jq --arg requested "$transport" --argjson elapsed "$((($(date +%s) - started_at) * 1000))" '{
            workspace_id:.workspace.id,
            thread_id:.thread.id,
            native_session_id:.thread.native_session_id,
            requested_transport:$requested,
            selected_transport:.thread.provider_transport,
            status:.thread.status,
            last_error:.thread.last_error,
            assistant_replies:[.items[] | select(.kind == "assistant_message") | .text],
            elapsed_ms:$elapsed
        }'
        if [ "$status" = "idle" ] && printf '%s' "$detail" | jq -e --arg expected "$expected_reply" \
            '.items | any(.kind == "assistant_message" and (.text | contains($expected)))' \
            >/dev/null; then
            keep_artifacts=0
            exit 0
        fi
        echo "[opencode-qa] turn did not complete with the expected reply" >&2
        tail -100 "$qa_dir/daemon.log" >&2
        exit 1
    fi
    if [ "$(($(date +%s) - started_at))" -ge "$timeout_seconds" ]; then
        echo "[opencode-qa] turn was still running after $timeout_seconds seconds" >&2
        tail -100 "$qa_dir/daemon.log" >&2
        exit 1
    fi
    sleep 0.25
done
