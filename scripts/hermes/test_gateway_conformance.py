"""Focused protocol and isolation regressions for the native gateway probe."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("gateway_conformance", Path(__file__).with_name("gateway_conformance.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class GatewayConformanceTests(unittest.TestCase):
    def client(self, code, timeout=1):
        return probe.Client([sys.executable, "-u", "-c", code], Path.cwd(), os.environ.copy(), timeout)

    def test_sensitive_request_is_declined_by_exact_id_without_echoing_value(self):
        code = '''import json,sys
req=json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc":"2.0","id":"srq-private","method":"sudo","params":{"value":"PRIVATE_VALUE"}}),flush=True)
answer=json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc":"2.0","id":req["id"],"result":answer}),flush=True)
'''
        with self.client(code) as client:
            answer = client.request("ping")
            self.assertEqual(answer["id"], "srq-private")
            self.assertEqual(answer["error"]["code"], -32601)
            self.assertNotIn("PRIVATE_VALUE", json.dumps(answer))

    def test_rpc_response_does_not_consume_pending_clarification(self):
        code = '''import json,sys
req=json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc":"2.0","id":"srq-1","method":"clarify","params":{"session_id":"live","questions":[{"qid":"q"}]}}),flush=True)
print(json.dumps({"jsonrpc":"2.0","id":req["id"],"result":{"status":"streaming"}}),flush=True)
sys.stdin.readline()
'''
        with self.client(code) as client:
            self.assertEqual(client.request("prompt.submit")["status"], "streaming")
            frame = client.wait(lambda value: value.get("method") == "clarify")
            self.assertEqual(frame["id"], "srq-1")
            client.answer(frame, {"answers": {"q": "RED"}})

    def test_wait_preserves_unrelated_events_for_later_checks(self):
        code = '''import json,sys
for kind in ("message.delta","message.complete"):
 print(json.dumps({"jsonrpc":"2.0","method":"event","params":{"type":kind,"session_id":"live","payload":{"text":"OK"}}}),flush=True)
sys.stdin.readline()
'''
        with self.client(code) as client:
            client.wait(lambda value: probe.event(value, "message.complete", "live"))
            self.assertEqual(client.wait(lambda value: probe.event(value, "message.delta", "live"))["params"]["payload"]["text"], "OK")

    def test_invalid_and_oversized_frames_fail_without_exposing_wire_content(self):
        for code, expected in [
            ('print("SECRET_NOT_JSON",flush=True)', "invalid JSON"),
            (f'print("x"*{probe.MAX_FRAME_BYTES + 1},flush=True)', "frame-size limit"),
        ]:
            with self.subTest(expected=expected), self.client(code) as client:
                with self.assertRaisesRegex(probe.ProbeError, expected) as failure:
                    client.request("ping")
                self.assertNotIn("SECRET", str(failure.exception))

    def test_rpc_errors_keep_code_and_method_but_omit_sensitive_upstream_message(self):
        code = '''import json,sys
req=json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc":"2.0","id":req["id"],"error":{"code":-32601,"message":"PRIVATE_VALUE"}}),flush=True)
'''
        with self.client(code) as client:
            with self.assertRaises(probe.RpcError) as failure:
                client.request("gateway.capabilities")
            self.assertEqual(failure.exception.code, -32601)
            self.assertNotIn("PRIVATE_VALUE", str(failure.exception))

    def test_unresponsive_process_has_deadline_and_is_reaped(self):
        client = self.client('import time;time.sleep(30)', timeout=0.05)
        try:
            with self.assertRaisesRegex(probe.ProbeError, "timed out"):
                client.request("ping")
        finally:
            client.close()
        self.assertIsNotNone(client.process.returncode)
        self.assertTrue(all(not reader.is_alive() for reader in client.readers))

    def test_fresh_home_copies_only_credentials_and_is_removed(self):
        with tempfile.TemporaryDirectory() as folder:
            original = Path(folder)
            files = {".env": "TOKEN=PRIVATE_VALUE", "auth.json": '{"token":"PRIVATE_VALUE"}',
                     "config.yaml": "personal-config", "state.db": "native-history"}
            for name, text in files.items():
                (original / name).write_text(text)
            args = argparse.Namespace(credentials_home=original, model="model", provider="provider")
            with probe.disposable_home(args) as (home, workspace):
                root = home.parent
                self.assertEqual(home.stat().st_mode & 0o777, 0o700)
                self.assertEqual((home / ".env").stat().st_mode & 0o777, 0o600)
                self.assertFalse((home / "state.db").exists())
                config = json.loads((home / "config.yaml").read_text())
                self.assertEqual(config["mcp_servers"], {})
                self.assertNotIn("personal-config", (home / "config.yaml").read_text())
                self.assertTrue(workspace.is_dir())
            self.assertFalse(root.exists())
            for name, text in files.items():
                self.assertEqual((original / name).read_text(), text)

    def test_disposable_home_cleanup_runs_on_probe_failure(self):
        args = argparse.Namespace(credentials_home=None, model=None, provider=None)
        with self.assertRaises(probe.ProbeError):
            with probe.disposable_home(args) as (home, _):
                root = home.parent
                raise probe.ProbeError("failed")
        self.assertFalse(root.exists())

    def test_inherited_gateway_routing_is_removed_from_child_environment(self):
        with patch.dict(os.environ, {"HERMES_HOME": "/personal", "HERMES_TUI_SIDECAR_URL": "ws://personal",
                                     "__HERMES_ACTIVATED": "/old"}):
            env = probe.environment(Path("/source"), Path("/isolated"))
        self.assertEqual(env["HERMES_HOME"], "/isolated")
        self.assertNotIn("HERMES_TUI_SIDECAR_URL", env)
        self.assertNotIn("__HERMES_ACTIVATED", env)

    def test_history_evidence_uses_transcript_content_not_metadata(self):
        self.assertFalse(probe.history_has({"messages": [{"role": "tool", "content": "MARKER"},
                                                       {"role": "assistant", "metadata": "MARKER"}]}, "MARKER"))
        self.assertTrue(probe.history_has({"messages": [{"role": "user", "content": "MARKER"}]}, "MARKER"))

    def test_resume_uses_session_key_as_stored_identity(self):
        self.assertEqual(probe.session_ids({"session_id": "live", "session_key": "stored"}), ("live", "stored"))
        self.assertEqual(probe.session_ids({"session_id": "live", "stored_session_id": "stored"}), ("live", "stored"))
        with self.assertRaises(probe.ProbeError):
            probe.session_ids({"session_id": "live", "resumed": "unproven"})

    def test_completion_waits_for_running_claim_release(self):
        from unittest.mock import Mock
        client = Mock(timeout=1)
        client.wait.return_value = {"params": {"payload": {"text": "OK", "status": "complete"}}}
        client.request.side_effect = [{"running": True}, {"running": False}]
        with patch.object(probe.time, "sleep"):
            probe.complete(client, "live", "OK")
        self.assertEqual(client.request.call_count, 2)
        self.assertEqual(client.request.call_args.args[0], "session.activate")

    def test_error_or_missing_completion_status_is_not_success(self):
        from unittest.mock import Mock
        for status in (None, "error", "interrupted"):
            with self.subTest(status=status):
                client = Mock()
                client.wait.return_value = {"params": {"payload": {"text": "OK", "status": status}}}
                with self.assertRaises(probe.ProbeError):
                    probe.complete(client, "live", "OK")
                client.request.assert_not_called()

    def test_queued_frames_cannot_extend_an_expired_deadline(self):
        client = object.__new__(probe.Client)
        client.frames = probe.queue.Queue()
        client.frames.put({"jsonrpc": "2.0", "method": "event"})
        with self.assertRaisesRegex(probe.ProbeError, "timed out"):
            client._receive(probe.time.monotonic() - 1)

    def test_empty_acp_load_is_not_history_handoff_evidence(self):
        from collections import deque
        from unittest.mock import Mock
        client = Mock(pending=deque())
        self.assertFalse(probe.acp_replayed(client, "stored", "MARKER"))
        client.pending.append({"method": "session/update", "params": {
            "sessionId": "other", "update": {"sessionUpdate": "agent_message_chunk", "content": {"text": "MARKER"}}}})
        self.assertFalse(probe.acp_replayed(client, "stored", "MARKER"))
        client.pending.append({"method": "session/update", "params": {
            "sessionId": "stored", "update": {"sessionUpdate": "agent_message_chunk", "content": {"text": "MARKER"}}}})
        self.assertTrue(probe.acp_replayed(client, "stored", "MARKER"))

    def test_blocked_transport_boundary_makes_report_nonzero(self):
        report = probe.Report("revision", False)
        report.add("MCP", "blocked", "profile write required")
        self.assertTrue(report.failed())

    def test_acp_streaming_evidence_joins_chunks_and_excludes_user_echo(self):
        from collections import deque
        from unittest.mock import Mock
        client = Mock(pending=deque([{"method": "session/update", "params": {
            "sessionId": "stored", "update": {"sessionUpdate": "user_message_chunk",
            "content": {"text": "MARKER"}}}}]))
        self.assertFalse(probe.acp_replayed(client, "stored", "MARKER"))
        for text in ("MAR", "KER"):
            client.pending.append({"method": "session/update", "params": {
                "sessionId": "stored", "update": {"sessionUpdate": "agent_message_chunk",
                "content": {"text": text}}}})
        self.assertTrue(probe.acp_replayed(client, "stored", "MARKER"))

    def test_report_does_not_print_private_error_message(self):
        report = probe.Report("revision", False)
        report.check("RPC", lambda: (_ for _ in ()).throw(probe.RpcError("ping", -1)))
        self.assertTrue(report.failed())
        self.assertEqual(report.data["checks"][0]["detail"], "ping returned RPC error -1")


if __name__ == "__main__":
    unittest.main()
