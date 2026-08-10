import importlib.util
import os
import stat
import subprocess
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("conversation_agent_bridge.py")
SPEC = importlib.util.spec_from_file_location("conversation_agent_bridge", MODULE_PATH)
conversation_agent_bridge = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(conversation_agent_bridge)


class ConversationAgentBridgeTests(unittest.TestCase):
    def test_reads_documented_final_reply(self):
        payload = {
            "ok": True,
            "status": "ok",
            "final": "Hello from Aria.",
            "payloads": [{"text": "Hello from Aria."}],
            "meta": {"agentMeta": {"stopReason": "stop"}},
        }

        self.assertEqual(
            conversation_agent_bridge.find_reply_text(payload, "prompt"),
            "Hello from Aria.",
        )

    def test_reads_gateway_wrapped_payload_instead_of_stop_reason(self):
        payload = {
            "result": {
                "payloads": [{"text": "The actual response."}],
                "meta": {"agentMeta": {"stopReason": "stop"}},
            }
        }

        self.assertEqual(
            conversation_agent_bridge.find_reply_text(payload, "prompt"),
            "The actual response.",
        )

    def test_stop_reason_alone_is_not_a_reply(self):
        payload = {"result": {"meta": {"agentMeta": {"stopReason": "stop"}}}}

        self.assertIsNone(conversation_agent_bridge.find_reply_text(payload, "prompt"))

    def test_control_value_in_final_falls_back_to_payload_text(self):
        payload = {"final": "stop", "payloads": [{"text": "Useful reply."}]}

        self.assertEqual(
            conversation_agent_bridge.find_reply_text(payload, "prompt"),
            "Useful reply.",
        )

    def test_combines_multiple_text_payloads(self):
        payload = {"payloads": [{"text": "First."}, {"text": "Second."}]}

        self.assertEqual(
            conversation_agent_bridge.find_reply_text(payload, "prompt"),
            "First.\n\nSecond.",
        )

    def test_prompt_echo_is_not_a_reply(self):
        payload = {"final": "prompt", "meta": {"status": "ok"}}

        self.assertIsNone(conversation_agent_bridge.find_reply_text(payload, "prompt"))

    def test_reads_legacy_structured_message(self):
        payload = {
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "A legacy reply."},
                    {"type": "tool_use", "text": "must not be exposed"},
                ],
            }
        }

        self.assertEqual(
            conversation_agent_bridge.find_reply_text(payload, "prompt"),
            "A legacy reply.",
        )

    def test_reslu_conversation_has_stable_openclaw_session_key(self):
        self.assertEqual(
            conversation_agent_bridge.openclaw_session_key(
                "d5442b38-d5ee-4650-93be-9e5953dbf401"
            ),
            "reslu-conversation-d5442b38-d5ee-4650-93be-9e5953dbf401",
        )

    @mock.patch.object(conversation_agent_bridge.subprocess, "Popen")
    def test_agent_invocation_uses_conversation_scoped_session(self, popen):
        process = popen.return_value
        process.communicate.return_value = ('{"final":"Agent answer"}', "")
        process.returncode = 0

        reply = conversation_agent_bridge.invoke_agent(
            {"slug": "aria", "display_name": "Aria", "role_label": "Studio assistant"},
            "Phillip: Hello",
            "conversation-123",
        )

        command = popen.call_args.args[0]
        self.assertEqual(reply, "Agent answer")
        self.assertIn("--session-key", command)
        self.assertEqual(command[command.index("--session-key") + 1], "reslu-conversation-conversation-123")

    @mock.patch.object(conversation_agent_bridge.subprocess, "Popen")
    def test_agent_invocation_requires_inspection_of_private_attachments(self, popen):
        process = popen.return_value
        process.communicate.return_value = ('{"final":"I read the brief."}', "")
        process.returncode = 0

        reply = conversation_agent_bridge.invoke_agent(
            {"slug": "aria", "display_name": "Aria", "role_label": "Studio assistant"},
            "Phillip: Please review this",
            "conversation-123",
            [{
                "filename": "Client Brief.pdf",
                "mime_type": "application/pdf",
                "byte_size": 1234,
                "local_path": "/tmp/private/client-brief.pdf",
            }],
        )

        prompt = popen.call_args.args[0][popen.call_args.args[0].index("--message") + 1]
        self.assertEqual(reply, "I read the brief.")
        self.assertIn("ATTACHMENTS_FOR_NEWEST_MESSAGE", prompt)
        self.assertIn("/tmp/private/client-brief.pdf", prompt)
        self.assertIn("inspect every relevant file", prompt)
        self.assertIn("use them in place", prompt)
        self.assertIn("untrusted user context", prompt)

    @mock.patch.object(conversation_agent_bridge.subprocess, "Popen")
    def test_cancelled_job_stops_openclaw_process_immediately(self, popen):
        process = popen.return_value
        process.communicate.side_effect = subprocess.TimeoutExpired(cmd=["openclaw"], timeout=0.5)
        process.poll.return_value = None
        process.wait.return_value = 0

        reply = conversation_agent_bridge.invoke_agent(
            {"slug": "aria", "display_name": "Aria", "role_label": "Studio assistant"},
            "Phillip: Please stop",
            "conversation-123",
            should_continue=lambda: False,
        )

        self.assertIsNone(reply)
        process.terminate.assert_called_once_with()
        process.kill.assert_not_called()

    @mock.patch.object(conversation_agent_bridge.subprocess, "Popen")
    def test_agent_continues_while_job_is_still_processing(self, popen):
        process = popen.return_value
        process.communicate.side_effect = [
            subprocess.TimeoutExpired(cmd=["openclaw"], timeout=0.5),
            ('{"final":"Finished answer"}', ""),
        ]
        process.returncode = 0

        reply = conversation_agent_bridge.invoke_agent(
            {"slug": "aria", "display_name": "Aria", "role_label": "Studio assistant"},
            "Phillip: Continue",
            "conversation-123",
            should_continue=lambda: True,
        )

        self.assertEqual(reply, "Finished answer")
        process.terminate.assert_not_called()

    @mock.patch.object(conversation_agent_bridge.time, "monotonic", side_effect=[0.0, 211.0])
    @mock.patch.object(conversation_agent_bridge.subprocess, "Popen")
    def test_agent_process_keeps_hard_timeout(self, popen, _monotonic):
        process = popen.return_value
        process.communicate.side_effect = subprocess.TimeoutExpired(cmd=["openclaw"], timeout=0.5)
        process.poll.return_value = None
        process.wait.return_value = 0

        with self.assertRaises(subprocess.TimeoutExpired):
            conversation_agent_bridge.invoke_agent(
                {"slug": "aria", "display_name": "Aria", "role_label": "Studio assistant"},
                "Phillip: Keep this bounded",
                "conversation-123",
            )

        process.terminate.assert_called_once_with()

    def test_transient_status_read_does_not_cancel_running_agent(self):
        class UnavailableRest:
            @staticmethod
            def rows(_table, _params):
                raise urllib.error.URLError("temporary network failure")

        with mock.patch.object(conversation_agent_bridge.sys, "stderr"):
            self.assertTrue(
                conversation_agent_bridge.job_should_continue(UnavailableRest(), "job-123")
            )

    def test_materializes_private_attachment_with_a_safe_ephemeral_filename(self):
        class FakeRest:
            @staticmethod
            def download_storage(bucket, path):
                self.assertEqual(bucket, "assets")
                self.assertEqual(path, "conversations/c1/attachments/a1")
                return b"%PDF-test"

        with tempfile.TemporaryDirectory() as directory:
            materialized = conversation_agent_bridge.materialize_attachments(
                FakeRest(),
                [{
                    "id": "attachment-1",
                    "filename": "../../Client Brief.pdf",
                    "mime_type": "application/pdf",
                    "byte_size": 9,
                    "storage_path": "conversations/c1/attachments/a1",
                }],
                Path(directory),
            )

            local_path = Path(materialized[0]["local_path"])
            self.assertEqual(local_path.parent, Path(directory))
            self.assertEqual(local_path.name, "attachment-1-Client-Brief.pdf")
            self.assertEqual(local_path.read_bytes(), b"%PDF-test")
            self.assertEqual(stat.S_IMODE(local_path.stat().st_mode), 0o600)

    def test_attachment_staging_prefers_private_agent_workspace(self):
        with tempfile.TemporaryDirectory() as workspace:
            with mock.patch.dict(
                os.environ,
                {"RESLU_ARIA_OPENCLAW_WORKSPACE": workspace},
            ):
                parent = conversation_agent_bridge.attachment_staging_parent("aria")

            self.assertEqual(
                parent,
                Path(workspace) / ".reslu-conversation-attachments",
            )
            self.assertTrue(parent.is_dir())
            self.assertEqual(stat.S_IMODE(parent.stat().st_mode), 0o700)

    def test_attachment_staging_rejects_a_symlink_parent(self):
        with tempfile.TemporaryDirectory() as workspace, tempfile.TemporaryDirectory() as target:
            parent = Path(workspace) / ".reslu-conversation-attachments"
            parent.symlink_to(target, target_is_directory=True)
            with mock.patch.dict(
                os.environ,
                {"RESLU_ARIA_OPENCLAW_WORKSPACE": workspace},
            ):
                self.assertIsNone(
                    conversation_agent_bridge.attachment_staging_parent("aria")
                )

    def test_process_job_uses_and_cleans_workspace_staging(self):
        rest = mock.Mock()
        rest.download_storage.return_value = b"synthetic-image"
        job = {
            "id": "job-1",
            "agent_id": "agent-1",
            "conversation_id": "conversation-1",
            "triggering_message_id": "message-1",
        }
        attachment = {
            "id": "attachment-1",
            "filename": "photo.png",
            "mime_type": "image/png",
            "byte_size": 15,
            "storage_path": "conversations/c1/attachments/a1",
        }
        observed_path = None

        def answer(_agent, _history, _conversation_id, materialized, **_kwargs):
            nonlocal observed_path
            observed_path = Path(materialized[0]["local_path"])
            self.assertTrue(observed_path.is_file())
            return "I read it."

        with tempfile.TemporaryDirectory() as workspace, mock.patch.dict(
            os.environ,
            {"RESLU_ARIA_OPENCLAW_WORKSPACE": workspace},
        ), mock.patch.object(
            conversation_agent_bridge,
            "agent_identity",
            return_value={"slug": "aria", "display_name": "Aria", "role_label": "Studio assistant"},
        ), mock.patch.object(
            conversation_agent_bridge,
            "conversation_history",
            return_value="Phillip: Please inspect this.",
        ), mock.patch.object(
            conversation_agent_bridge,
            "ready_message_attachments",
            return_value=[attachment],
        ), mock.patch.object(
            conversation_agent_bridge,
            "job_is_processing",
            side_effect=[True, True, True],
        ), mock.patch.object(
            conversation_agent_bridge,
            "invoke_agent",
            side_effect=answer,
        ):
            self.assertEqual(conversation_agent_bridge.process_job(rest, job), "done")
            self.assertIsNotNone(observed_path)
            self.assertEqual(
                observed_path.parents[1],
                Path(workspace) / ".reslu-conversation-attachments",
            )
            self.assertFalse(observed_path.exists())

        rest.insert.assert_called_once()
        rest.patch.assert_called_once()


if __name__ == "__main__":
    unittest.main()
