#!/usr/bin/env python3
"""Qualify Hermes' native stdio gateway without touching its installed profile.

Use the interpreter belonging to the source revision under test. Each run creates
and removes its own home and workspace; --credentials-home copies only .env and
auth.json for explicit --live checks. Reports contain check outcomes, never wire
frames, transcripts, credential values, or stderr.
"""
from __future__ import annotations

import argparse
from collections import deque
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import queue
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import uuid

MAX_FRAME_BYTES = 256 * 1024
MAX_BACKLOG = 512
SEED_MARKER = "FALCONDECK_HERMES_GATEWAY_SEED_OK"
TEXT_MARKER = "FALCONDECK_HERMES_GATEWAY_TEXT_OK"
ANSWER_MARKER = "FALCONDECK_HERMES_GATEWAY_ANSWER_OK"
STEER_MARKER = "FALCONDECK_HERMES_GATEWAY_STEER_OK"
ACP_MARKER = "FALCONDECK_HERMES_ACP_HISTORY_OK"
HANDOFF_MARKER = "FALCONDECK_HERMES_GATEWAY_HANDOFF_OK"


class ProbeError(Exception):
    """A bounded failure safe to include in a public report."""


class RpcError(ProbeError):
    def __init__(self, method: str, code):
        # An upstream error message may contain credentials or prompt content.
        super().__init__(f"{method} returned RPC error {code}")
        self.code = code


class Client:
    """Single caller, peer-to-peer JSON-RPC with bounded reads and owned cleanup."""

    def __init__(self, command, cwd: Path, env: dict, timeout: float):
        self.timeout = timeout
        self.next_id = 1
        self.pending = deque()
        self.closed = threading.Event()
        self.frames = queue.Queue(maxsize=32)
        self.process = subprocess.Popen(
            command, cwd=cwd, env=env, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=os.name == "posix",
        )
        self.readers = [threading.Thread(target=self._read_stdout, daemon=True),
                        threading.Thread(target=self._drain_stderr, daemon=True)]
        for reader in self.readers:
            reader.start()

    def _enqueue(self, frame):
        while not self.closed.is_set():
            try:
                self.frames.put(frame, timeout=0.1)
                return
            except queue.Full:
                continue

    def _read_stdout(self):
        try:
            while not self.closed.is_set():
                line = self.process.stdout.readline(MAX_FRAME_BYTES + 1)
                if not line:
                    self._enqueue(ProbeError("gateway stdout closed"))
                    return
                if len(line) > MAX_FRAME_BYTES:
                    self._enqueue(ProbeError("gateway exceeded the frame-size limit"))
                    return
                if not line.strip():
                    continue
                try:
                    frame = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    self._enqueue(ProbeError("gateway emitted invalid JSON"))
                    return
                if not isinstance(frame, dict) or frame.get("jsonrpc") != "2.0":
                    self._enqueue(ProbeError("gateway emitted an invalid RPC envelope"))
                    return
                self._enqueue(frame)
        except (OSError, ValueError):
            self._enqueue(ProbeError("gateway stdout read failed"))

    def _drain_stderr(self):
        try:
            while self.process.stderr.read(8192):
                pass
        except (OSError, ValueError):
            pass

    def send(self, frame):
        encoded = json.dumps(frame, separators=(",", ":")).encode() + b"\n"
        if len(encoded) > MAX_FRAME_BYTES:
            raise ProbeError("outgoing RPC frame exceeds the size limit")
        try:
            self.process.stdin.write(encoded)
            self.process.stdin.flush()
        except (OSError, ValueError):
            raise ProbeError("gateway stdin write failed") from None

    def _receive(self, deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ProbeError("gateway response timed out")
        try:
            frame = self.frames.get(timeout=remaining)
        except queue.Empty:
            raise ProbeError("gateway response timed out") from None
        if isinstance(frame, ProbeError):
            raise frame
        return frame

    def _defer(self, frame):
        if len(self.pending) >= MAX_BACKLOG:
            raise ProbeError("gateway exceeded the pending-frame limit")
        self.pending.append(frame)

    def decline(self, frame):
        self.send({"jsonrpc": "2.0", "id": frame["id"], "error": {
            "code": -32601, "message": "Request unsupported by conformance client"}})

    def _route(self, frame):
        if frame.get("method") and frame.get("id") is not None:
            if frame["method"] not in {"clarify", "approval", "session/request_permission"}:
                # Secrets/sudo/vault/desktop bridges never become ordinary answers.
                self.decline(frame)
                return
        self._defer(frame)

    def request(self, method, params=None):
        request_id = self.next_id
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method,
                   "params": params or {}})
        deadline = time.monotonic() + self.timeout
        while True:
            frame = self._receive(deadline)
            if frame.get("id") == request_id and "method" not in frame:
                if "error" in frame:
                    raise RpcError(method, frame["error"].get("code"))
                if "result" not in frame:
                    raise ProbeError(f"{method} returned no result")
                return frame["result"]
            self._route(frame)

    def wait(self, predicate):
        # Preserve unrelated frames while respecting one deadline for the operation.
        deadline = time.monotonic() + self.timeout
        remaining = deque()
        try:
            while True:
                frame = self.pending.popleft() if self.pending else self._receive(deadline)
                if predicate(frame):
                    return frame
                if frame.get("method") and frame.get("id") is not None:
                    self.decline(frame)
                else:
                    if len(remaining) >= MAX_BACKLOG:
                        raise ProbeError("gateway exceeded the pending-frame limit")
                    remaining.append(frame)
        finally:
            remaining.extend(self.pending)
            self.pending = remaining

    def answer(self, frame, result):
        self.send({"jsonrpc": "2.0", "id": frame["id"], "result": result})

    def close(self):
        if self.closed.is_set():
            return
        self.closed.set()
        self.process.stdin.close()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            if os.name == "posix":
                os.killpg(self.process.pid, signal.SIGKILL)
            else:
                self.process.kill()
            self.process.wait(timeout=3)
        # Reap owned descendants even when the parent exited on stdin EOF.
        if os.name == "posix":
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for reader in self.readers:
            reader.join(timeout=1)
        self.process.stdout.close()
        self.process.stderr.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def event(frame, kind, sid=None):
    params = frame.get("params", {})
    return (frame.get("method") == "event" and params.get("type") == kind
            and (sid is None or params.get("session_id") == sid))


def require(condition, detail):
    if not condition:
        raise ProbeError(detail)


def session_ids(result):
    live = result.get("session_id")
    stored = result.get("stored_session_id") or result.get("session_key")
    require(isinstance(live, str) and bool(live), "missing live session ID")
    require(isinstance(stored, str) and bool(stored), "missing stored session ID")
    return live, stored


def history_has(result, marker):
    # Do not flatten metadata or tool arguments into evidence of conversation replay.
    return any(marker in str(message.get("content") or message.get("text") or "")
               for message in result.get("messages", [])
               if message.get("role") in {"user", "assistant"})


class Report:
    def __init__(self, revision, live):
        self.data = {"source_revision": revision, "live": live, "checks": []}

    def add(self, name, status, detail):
        self.data["checks"].append({"name": name, "status": status, "detail": detail})

    def check(self, name, action):
        try:
            detail = action()
            self.add(name, "pass", detail)
            return True
        except (ProbeError, OSError) as error:
            # OSError can include paths, but never include subprocess stdout/stderr.
            detail = str(error) if isinstance(error, ProbeError) else type(error).__name__
            self.add(name, "fail", detail)
            return False

    def failed(self):
        return any(check["status"] in {"fail", "blocked"} for check in self.data["checks"])


@contextmanager
def disposable_home(args):
    originals = {}
    with tempfile.TemporaryDirectory(prefix="falcondeck-hermes-gateway-", dir="/tmp") as folder:
        root = Path(folder)
        root.chmod(0o700)
        home, workspace = root / "home", root / "workspace"
        home.mkdir(mode=0o700)
        workspace.mkdir(mode=0o700)
        if args.credentials_home:
            for name in (".env", "auth.json"):
                source = args.credentials_home / name
                if source.is_file():
                    originals[source] = hashlib.sha256(source.read_bytes()).digest()
                    shutil.copyfile(source, home / name)
                    (home / name).chmod(0o600)
        # A fresh config avoids personal MCP services, cron, messaging and memory.
        config = {"toolsets": ["terminal", "file", "clarify"], "mcp_servers": {},
                  "platform_toolsets": {"cli": ["terminal", "file", "clarify"],
                                        "tui": ["terminal", "file", "clarify"]},
                  "terminal": {"backend": "local", "cwd": str(workspace)}}
        if args.model:
            config["model"] = {"default": args.model, "provider": args.provider}
        config_path = home / "config.yaml"
        config_path.write_text(json.dumps(config))  # JSON is valid YAML.
        config_path.chmod(0o600)
        try:
            yield home, workspace
        finally:
            for source, digest in originals.items():
                require(hashlib.sha256(source.read_bytes()).digest() == digest,
                        "source credentials changed during qualification")


def environment(source, home):
    env = os.environ.copy()
    # Prevent a parent gateway/activated profile from routing this disposable run.
    for key in list(env):
        if key.startswith("HERMES_") or key.startswith("__HERMES_"):
            env.pop(key)
    env.update(HERMES_HOME=str(home), HERMES_PYTHON_SRC_ROOT=str(source),
               PYTHONPATH=str(source), PYTHONUNBUFFERED="1",
               HERMES_TUI_GATEWAY_SHUTDOWN_GRACE_S="1")
    return env


def gateway(args, home):
    client = Client([str(args.python), "-m", "tui_gateway.entry"],
                    args.source, environment(args.source, home), args.timeout)
    try:
        client.wait(lambda frame: event(frame, "gateway.ready"))
        return client
    except BaseException:
        client.close()
        raise


def negotiate(client):
    capabilities = client.request("gateway.capabilities")
    require(capabilities.get("per_session_exclusive_submit") is True,
            "gateway does not advertise exclusive session ownership")
    requests = client.request("client.capabilities", {"server_requests": True})
    methods = requests.get("server_requests", [])
    require("clarify" in methods and "approval" in methods,
            "gateway does not negotiate clarification and approvals")
    require(client.request("ping").get("pong") is True, "gateway ping failed")
    return "exclusive submit, clarification, approval and ping negotiated"


def submit(client, sid, text):
    result = client.request("prompt.submit", {"session_id": sid, "text": text})
    require(result.get("status") == "streaming", "prompt was not admitted as a new streamed turn")


def wait_idle(client, sid):
    deadline = time.monotonic() + client.timeout
    while time.monotonic() < deadline:
        snapshot = client.request("session.activate", {"session_id": sid, "omit_messages": True})
        require(isinstance(snapshot.get("running"), bool), "live snapshot omitted running state")
        if not snapshot["running"]:
            return
        time.sleep(0.03)
    raise ProbeError("completed turn did not release its running claim")


def complete(client, sid, marker=None):
    frame = client.wait(lambda value: event(value, "message.complete", sid))
    payload = frame.get("params", {}).get("payload", {})
    require(payload.get("status") == "complete" and not payload.get("error"),
            "turn completed with an error or interruption")
    if marker:
        require(marker in payload.get("text", ""), "completion did not contain the expected marker")
    wait_idle(client, sid)
    return frame


def run_live(client, sid, report):
    def text_turn():
        submit(client, sid, f"Reply exactly {TEXT_MARKER}. Do not use tools.")
        complete(client, sid, TEXT_MARKER)
        delta = client.wait(lambda f: event(f, "message.delta", sid))
        require(bool(delta["params"].get("payload", {}).get("text")), "empty text delta")
        return "streamed text and explicit completion observed"
    if not report.check("Text streaming", text_turn):
        return

    def clarification():
        submit(client, sid, "Use the clarify tool to ask exactly one question with choices RED and BLUE. "
               f"Wait for my answer, then reply exactly {ANSWER_MARKER}. Do not use other tools.")
        request = client.wait(lambda f: f.get("method") == "clarify"
                              and f.get("params", {}).get("session_id") == sid)
        replay = client.request("session.events.since", {"session_id": sid, "last_seen": 0})
        require(any(item.get("id") == request["id"] and item.get("method") == "clarify"
                    for item in replay.get("open_requests", [])), "pending clarification absent from replay")
        restored = client.request("session.activate", {"session_id": sid, "omit_messages": True})
        require(any(item.get("id") == request["id"] for item in restored.get("open_requests", [])),
                "pending clarification absent from activation")
        questions = request.get("params", {}).get("questions", [])
        require(bool(questions) and all(q.get("qid") for q in questions), "missing clarification question IDs")
        client.answer(request, {"answers": {q["qid"]: "RED" for q in questions}})
        complete(client, sid, ANSWER_MARKER)
        return "exact request/question IDs restored and answered; turn completed"
    if not report.check("Clarification and open-request replay", clarification):
        return

    def steering():
        submit(client, sid, "Use terminal to run `sleep 8`, wait for it, then reply ORIGINAL. "
               "Do not start a background command.")
        client.wait(lambda f: event(f, "tool.start", sid)
                    and f.get("params", {}).get("payload", {}).get("name") == "terminal")
        result = client.request("session.steer", {"session_id": sid,
                                "text": f"After the command finishes reply exactly {STEER_MARKER} instead."})
        require(result.get("status") == "queued", "native steering was rejected")
        complete(client, sid, STEER_MARKER)
        return "native steering accepted during the same running turn"
    if not report.check("Native steering", steering):
        return

    def cancellation():
        submit(client, sid, "Use clarify to ask exactly one question. Wait for my answer before continuing.")
        request = client.wait(lambda f: f.get("method") == "clarify"
                              and f.get("params", {}).get("session_id") == sid)
        result = client.request("session.interrupt", {"session_id": sid})
        require(result.get("status") == "interrupted", "interrupt was not acknowledged")
        client.wait(lambda f: event(f, "request.cancel", sid)
                    and f.get("params", {}).get("payload", {}).get("id") == request["id"])
        terminal = client.wait(lambda f: event(f, "message.complete", sid))
        require(terminal["params"].get("payload", {}).get("status") == "interrupted",
                "cancelled turn did not report interrupted outcome")
        wait_idle(client, sid)
        replay = client.request("session.events.since", {"session_id": sid, "last_seen": 0})
        require(not replay.get("open_requests"), "interrupted request remained open")
        submit(client, sid, f"Reply exactly {TEXT_MARKER}. Do not use tools.")
        complete(client, sid, TEXT_MARKER)
        return "pending clarification withdrawn; next turn completed"
    report.check("Pending-request cancellation and next turn", cancellation)


def acp_replayed(client, sid, marker):
    chunks = []
    for frame in client.pending:
        params = frame.get("params", {})
        update = params.get("update", {})
        if (frame.get("method") == "session/update" and params.get("sessionId") == sid
                and update.get("sessionUpdate") == "agent_message_chunk"):
            chunks.append(update.get("content", {}).get("text", ""))
    return marker in "".join(chunks)


def acp_client(args, home):
    client = Client([str(args.python), "-m", "acp_adapter.entry"],
                    args.source, environment(args.source, home), args.timeout)
    try:
        client.request("initialize", {"protocolVersion": 1, "clientCapabilities": {}})
        return client
    except BaseException:
        client.close()
        raise


def acp_gateway_round_trip(args, home, workspace):
    with acp_client(args, home) as acp:
        session = acp.request("session/new", {"cwd": str(workspace), "mcpServers": []})
        sid = session.get("sessionId")
        require(isinstance(sid, str) and bool(sid), "ACP omitted the native session handle")
        result = acp.request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text",
                             "text": f"Reply exactly {ACP_MARKER}. Do not use tools."}]})
        require(result.get("stopReason") == "end_turn" and acp_replayed(acp, sid, ACP_MARKER),
                "ACP did not complete the seed turn")
    with gateway(args, home) as native:
        negotiate(native)
        resumed = native.request("session.resume", {"session_id": sid, "eager_build": True})
        live_id, stored = session_ids(resumed)
        require(stored == sid and history_has(resumed, ACP_MARKER), "gateway did not restore the ACP handle/history")
        submit(native, live_id, f"Reply exactly {HANDOFF_MARKER}. Do not use tools.")
        complete(native, live_id, HANDOFF_MARKER)
    with acp_client(args, home) as reloaded:
        loaded = reloaded.request("session/load", {"sessionId": sid, "cwd": str(workspace), "mcpServers": []})
        require(bool(loaded) and acp_replayed(reloaded, sid, HANDOFF_MARKER),
                "ACP did not replay the gateway continuation under the original handle")
    return "original ACP handle/history and gateway continuation replayed through ACP; no compression"


def transport_checks(args, home, workspace, stored, report):
    """Verify rollout boundaries separately from the working gateway protocol."""
    if args.live:
        report.check("ACP-origin history round trip", lambda: acp_gateway_round_trip(args, home, workspace))
    with acp_client(args, home) as acp:
        try:
            loaded = acp.request("session/load", {"sessionId": stored, "cwd": str(workspace), "mcpServers": []})
            replayed = acp_replayed(acp, stored, SEED_MARKER)
            if isinstance(loaded, dict) and loaded and replayed:
                report.add("Native-to-ACP history handoff", "pass", "ACP loaded the stored ID and replayed seeded history")
            else:
                report.add("Native-to-ACP history handoff", "blocked", "ACP returned no proven native-session history")
        except RpcError as error:
            report.add("Native-to-ACP history handoff", "blocked", str(error))

    with gateway(args, home) as client:
        negotiate(client)
        name = "falcondeck_ephemeral_probe"
        marker = workspace / "mcp-launched"
        server = {"name": name, "command": str(args.python), "args": ["-c",
                  f"from pathlib import Path; Path({str(marker)!r}).write_text('launched')"], "env": []}
        # These are candidate injection fields, not a claimed native contract.
        try:
            client.request("session.create", {"cwd": str(workspace),
                           "mcpServers": [server], "mcp_servers": {name: server}})
            raise ProbeError("gateway accepted undeclared session MCP fields; qualify the new contract")
        except RpcError as error:
            require(error.code == 4000, "candidate MCP fields failed for an unexpected reason")
        servers = client.request("mcp.servers.list").get("servers", [])
        require(not any(row.get("name") == name for row in servers) and not marker.exists(),
                "rejected injection fields changed gateway MCP registration")
        config_path = home / "config.yaml"
        before = config_path.read_bytes()
        added = client.request("mcp.servers.add", {"name": name, "config": {
            "command": str(args.python), "args": ["-c", "pass"], "enabled": False}})
        require(added.get("ok") is True, "profile MCP write was not acknowledged")
        require(config_path.read_bytes() != before and name in config_path.read_text(),
                "MCP add did not persist its profile configuration")
        report.add("Thread-scoped MCP injection", "blocked",
                   "session MCP fields rejected (4000); supported MCP add writes profile config")


def run_probe(args):
    revision = subprocess.run(["git", "-C", str(args.source), "rev-parse", "HEAD"],
                              capture_output=True, text=True, check=True).stdout.strip()
    report = Report(revision, args.live)
    with disposable_home(args) as (home, workspace):
        try:
            client = gateway(args, home)
        except ProbeError as error:
            report.add("Gateway startup", "fail", str(error))
            return report
        with client:
            if not report.check("Capability negotiation", lambda: negotiate(client)):
                return report
            params = {"cwd": str(workspace), "cwd_explicit": True,
                      "idempotency_key": uuid.uuid4().hex,
                      "messages": [{"role": "user", "content": "Seeded qualification history."},
                                   {"role": "assistant", "content": SEED_MARKER}]}
            if args.model:
                params.update(model=args.model, provider=args.provider)
            try:
                created = client.request("session.create", params)
                sid, stored = session_ids(created)
                require(sid != stored, "live/stored session IDs were conflated")
                retried = client.request("session.create", params)
                require(session_ids(retried) == (sid, stored), "create retry minted a second session")
                require(history_has(created, SEED_MARKER), "seed history was not projected")
                report.add("Session identity and create retry", "pass", "distinct live/stored IDs; retry reused both")
            except ProbeError as error:
                report.add("Session identity and create retry", "fail", str(error))
                return report
            if args.live:
                run_live(client, sid, report)
                if report.failed():
                    return report
            if not args.restart and not args.transport_checks:
                report.add("Gateway restart", "skipped", "run with --restart")
                return report
        if args.transport_checks:
            try:
                transport_checks(args, home, workspace, stored, report)
            except ProbeError as error:
                report.add("Transport boundary checks", "fail", str(error))
        if not args.restart:
            report.add("Gateway restart", "skipped", "run with --restart")
            return report
        try:
            with gateway(args, home) as restarted:
                negotiate(restarted)
                resumed = restarted.request("session.resume", {"session_id": stored, "eager_build": args.live, "lazy": not args.live})
                resumed_sid, resumed_stored = session_ids(resumed)
                require(resumed_stored == stored, "restart changed the stored session identity")
                require(history_has(resumed, SEED_MARKER), "seeded history missing after restart")
                if args.live:
                    require(all(history_has(resumed, marker) for marker in
                                (TEXT_MARKER, ANSWER_MARKER, STEER_MARKER)),
                            "live interaction history missing after restart")
                require(not resumed.get("open_requests"), "completed session restored an open request")
                if args.live:
                    submit(restarted, resumed_sid, f"Reply exactly {TEXT_MARKER}. Do not use tools.")
                    complete(restarted, resumed_sid, TEXT_MARKER)
                report.add("Gateway restart", "pass", "stored identity and native history restored" +
                           ("; continuation completed" if args.live else ""))
        except ProbeError as error:
            report.add("Gateway restart", "fail", str(error))
    return report


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Hermes checkout to qualify (never upgraded)")
    parser.add_argument("--python", type=Path, required=True, help="interpreter with that source's dependencies")
    parser.add_argument("--live", action="store_true", help="spend model tokens on controlled interaction checks")
    parser.add_argument("--transport-checks", action="store_true",
                        help="test ACP handoff and MCP scoping; blocked boundaries exit nonzero")
    parser.add_argument("--restart", action="store_true", help="restart the owned gateway and resume native history")
    parser.add_argument("--credentials-home", type=Path, help="copy .env/auth.json into the disposable home")
    parser.add_argument("--model", help="explicit model for the disposable session")
    parser.add_argument("--provider", help="Hermes model provider, e.g. openai-codex")
    parser.add_argument("--timeout", type=float, default=90, help="per-operation deadline in seconds")
    args = parser.parse_args()
    args.source = args.source.resolve()
    args.python = args.python.absolute()  # Resolving a venv symlink loses the venv's identity.
    if not args.source.is_dir() or not args.python.is_file():
        parser.error("--source and --python must exist")
    if bool(args.model) != bool(args.provider):
        parser.error("--model and --provider must be supplied together")
    if args.live and not args.model:
        parser.error("--live requires an explicit --model and --provider")
    if args.credentials_home and not args.live:
        parser.error("--credentials-home requires --live")
    if not 0 < args.timeout <= 300:
        parser.error("--timeout must be between 0 and 300 seconds")
    return args


def main():
    try:
        report = run_probe(parse_args())
        print(json.dumps(report.data, indent=2))
        return int(report.failed())
    except (ProbeError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({"error": str(error) if isinstance(error, ProbeError) else type(error).__name__}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
