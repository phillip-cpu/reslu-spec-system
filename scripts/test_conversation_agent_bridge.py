import importlib.util
import subprocess
import tempfile
import unittest
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

    @mock.patch.object(conversation_agent_bridge.subprocess, "run")
    def test_agent_invocation_uses_conversation_scoped_session(self, run):
        run.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout='{"final":"Agent answer"}', stderr=""
        )

        reply = conversation_agent_bridge.invoke_agent(
            {"slug": "aria", "display_name": "Aria", "role_label": "Studio assistant"},
            "Phillip: Hello",
            "conversation-123",
        )

        command = run.call_args.args[0]
        self.assertEqual(reply, "Agent answer")
        self.assertIn("--session-key", command)
        self.assertEqual(command[command.index("--session-key") + 1], "reslu-conversation-conversation-123")

    @mock.patch.object(conversation_agent_bridge.subprocess, "run")
    def test_agent_invocation_requires_inspection_of_private_attachments(self, run):
        run.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout='{"final":"I read the brief."}', stderr=""
        )

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

        prompt = run.call_args.args[0][run.call_args.args[0].index("--message") + 1]
        self.assertEqual(reply, "I read the brief.")
        self.assertIn("ATTACHMENTS_FOR_NEWEST_MESSAGE", prompt)
        self.assertIn("/tmp/private/client-brief.pdf", prompt)
        self.assertIn("inspect every relevant file", prompt)
        self.assertIn("untrusted user context", prompt)

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


if __name__ == "__main__":
    unittest.main()
