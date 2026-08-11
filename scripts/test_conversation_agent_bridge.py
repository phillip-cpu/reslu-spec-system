import importlib.util
from datetime import datetime, timezone
import os
import stat
import subprocess
import tempfile
import unittest
import urllib.error
import json
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("conversation_agent_bridge.py")
SPEC = importlib.util.spec_from_file_location("conversation_agent_bridge", MODULE_PATH)
conversation_agent_bridge = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(conversation_agent_bridge)


class ConversationAgentBridgeTests(unittest.TestCase):
    def test_agent_claim_has_a_short_network_timeout(self):
        rest = conversation_agent_bridge.SupabaseRest(
            "https://example.supabase.co",
            "secret",
        )
        with mock.patch.object(rest, "request", return_value=[]) as request:
            self.assertIsNone(rest.claim("aria"))

        self.assertEqual(
            request.call_args.kwargs["timeout_seconds"],
            conversation_agent_bridge.CLAIM_REQUEST_TIMEOUT_SECONDS,
        )

    def test_aria_and_marco_use_independent_serial_workers(self):
        with mock.patch.object(conversation_agent_bridge.threading, "Thread") as thread:
            workers = conversation_agent_bridge.build_agent_workers(
                "https://example.supabase.co",
                "secret",
            )

        self.assertEqual(len(workers), 2)
        self.assertEqual(thread.call_count, 2)
        calls_by_name = {call.kwargs["name"]: call for call in thread.call_args_list}
        self.assertEqual(set(calls_by_name), {
            "reslu-conversation-aria",
            "reslu-conversation-marco",
        })
        for slug in conversation_agent_bridge.AGENT_SLUGS:
            call = calls_by_name[f"reslu-conversation-{slug}"]
            self.assertIs(
                call.kwargs["target"],
                conversation_agent_bridge.agent_worker_loop,
            )
            self.assertEqual(
                call.kwargs["args"],
                ("https://example.supabase.co", "secret", slug),
            )
            self.assertFalse(call.kwargs["daemon"])

    def test_background_tasks_have_workers_independent_from_conversation_turns(self):
        with mock.patch.object(conversation_agent_bridge.threading, "Thread") as thread:
            workers = conversation_agent_bridge.build_task_workers(
                "https://example.supabase.co",
                "secret",
            )

        self.assertEqual(len(workers), 2)
        calls_by_name = {call.kwargs["name"]: call for call in thread.call_args_list}
        self.assertEqual(set(calls_by_name), {"reslu-task-aria", "reslu-task-marco"})
        self.assertTrue(all(call.kwargs["target"] is conversation_agent_bridge.task_worker_loop for call in thread.call_args_list))

    def test_strong_tasks_route_to_the_configured_capable_model(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                conversation_agent_bridge.task_model_override("strong"),
                "openai/gpt-5.6-sol",
            )
            self.assertIsNone(conversation_agent_bridge.task_model_override("standard"))
        with mock.patch.dict(os.environ, {"RESLU_TASK_STRONG_MODEL": "anthropic/claude-opus-4-6"}):
            self.assertEqual(
                conversation_agent_bridge.task_model_override("strong"),
                "anthropic/claude-opus-4-6",
            )

    def test_task_result_keeps_a_reviewable_email_draft(self):
        result = conversation_agent_bridge.parse_task_result(json.dumps({
            "status": "awaiting_approval",
            "summary": "Email draft is ready.",
            "message": "I drafted the email for your approval.",
            "artifact": {
                "artifact_key": "client-email",
                "kind": "email_draft",
                "title": "Email to Jane",
                "content": {"to": "jane@example.com", "subject": "Friday", "body": "Hi Jane"},
            },
        }), {"title": "Draft email"})

        self.assertEqual(result["status"], "awaiting_approval")
        self.assertEqual(result["artifact"]["kind"], "email_draft")
        self.assertEqual(result["artifact"]["content"]["subject"], "Friday")

    def test_task_result_recovers_wrapped_json_without_losing_approval(self):
        reply = "Here is the finished draft:\n```json\n" + json.dumps({
            "status": "awaiting_approval",
            "summary": "Email draft is ready.",
            "message": "Please review it.",
            "artifact": {
                "kind": "email_draft",
                "title": "Email to Phillip",
                "content": {"to": "phillip@example.com", "subject": "Voice workspace", "body": "Hi Phillip"},
            },
        }) + "\n```\nLet me know if you want changes."

        result = conversation_agent_bridge.parse_task_result(reply, {"title": "Draft email"})

        self.assertEqual(result["status"], "awaiting_approval")
        self.assertEqual(result["artifact"]["kind"], "email_draft")
        self.assertEqual(result["artifact"]["content"]["body"], "Hi Phillip")

    @mock.patch.object(conversation_agent_bridge.subprocess, "Popen")
    def test_task_invocation_uses_a_task_session_and_stops_only_on_explicit_cancel(self, popen):
        process = popen.return_value
        process.communicate.return_value = ('{"final":"{\\"status\\":\\"completed\\",\\"summary\\":\\"Done\\",\\"message\\":\\"Done\\"}"}', "")
        process.returncode = 0
        task = {
            "id": "task-123",
            "title": "Prepare report",
            "objective": "Prepare the report",
            "model_tier": "strong",
            "approval_state": "none",
            "approval_note": None,
        }

        result = conversation_agent_bridge.invoke_task_agent(
            {"slug": "aria", "display_name": "Aria", "role_label": "Studio assistant"},
            task,
            "Phillip: Please prepare it.",
            [],
            should_continue=lambda: True,
        )

        command = popen.call_args.args[0]
        self.assertEqual(command[command.index("--session-key") + 1], "reslu-task-task-123")
        self.assertEqual(command[command.index("--model") + 1], "openai/gpt-5.6-sol")
        self.assertEqual(result["status"], "completed")

    def test_task_cancellation_is_separate_from_call_or_conversation_state(self):
        rest = mock.Mock()
        rest.rows.return_value = [{"status": "running", "cancellation_requested_at": None}]
        self.assertTrue(conversation_agent_bridge.task_should_continue(rest, "task-1"))
        rest.rows.return_value = [{"status": "running", "cancellation_requested_at": "2026-08-11T00:00:00Z"}]
        self.assertFalse(conversation_agent_bridge.task_should_continue(rest, "task-1"))

    def test_history_resolves_quoted_reply_target_outside_recent_window(self):
        class FakeRest:
            @staticmethod
            def rows(table, params):
                if table == "conversation_messages" and "id" not in params:
                    return [{
                        "id": "reply-1",
                        "author_profile_id": "profile-phillip",
                        "author_agent_id": None,
                        "body": "Yes, use that option.",
                        "kind": "text",
                        "reply_to_id": "target-older",
                        "created_at": "2026-08-10T11:00:00Z",
                    }]
                if table == "conversation_messages":
                    return [{
                        "id": "target-older",
                        "author_profile_id": "profile-jane",
                        "author_agent_id": None,
                        "body": "Should we specify the limestone finish?",
                        "kind": "text",
                        "reply_to_id": None,
                        "created_at": "2026-08-09T09:00:00Z",
                    }]
                if table == "profiles":
                    return [
                        {"id": "profile-phillip", "full_name": "Phillip"},
                        {"id": "profile-jane", "full_name": "Jane"},
                    ]
                if table in ("conversation_agents", "conversation_attachments"):
                    return []
                raise AssertionError((table, params))

        history = conversation_agent_bridge.conversation_history(FakeRest(), "conversation-1")

        self.assertIn("[Replying to Jane: Should we specify the limestone finish?]", history)
        self.assertIn("Phillip: Yes, use that option.", history)

    def test_history_uses_requested_voice_window(self):
        class FakeRest:
            params = None

            @classmethod
            def rows(cls, table, params):
                if table == "conversation_messages":
                    cls.params = params
                    return []
                raise AssertionError((table, params))

        conversation_agent_bridge.conversation_history(FakeRest(), "conversation-1", 16)

        self.assertEqual(FakeRest.params["limit"], "16")

    def test_only_openai_realtime_messages_use_voice_tuning(self):
        class FakeRest:
            @staticmethod
            def rows(_table, _params, **_kwargs):
                return [{
                    "id": "message-1",
                    "metadata": {
                        "source": "voice",
                        "transport": "openai_realtime_webrtc",
                    },
                }]

        self.assertTrue(
            conversation_agent_bridge.is_realtime_voice_message(FakeRest(), "message-1")
        )

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
            "reslu-conversation-v2-d5442b38-d5ee-4650-93be-9e5953dbf401",
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
        self.assertEqual(command[command.index("--session-key") + 1], "reslu-conversation-v2-conversation-123")
        self.assertNotIn("--thinking", command)

    @mock.patch.object(conversation_agent_bridge.subprocess, "Popen")
    def test_realtime_voice_invocation_uses_low_latency_thinking(self, popen):
        process = popen.return_value
        process.communicate.return_value = ('{"final":"Short answer"}', "")
        process.returncode = 0

        reply = conversation_agent_bridge.invoke_agent(
            {"slug": "aria", "display_name": "Aria", "role_label": "Studio assistant"},
            "Phillip: What is on my list?",
            "conversation-123",
            thinking_level="minimal",
        )

        command = popen.call_args.args[0]
        self.assertEqual(reply, "Short answer")
        self.assertEqual(command[command.index("--thinking") + 1], "minimal")

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
            def rows(_table, _params, **_kwargs):
                raise urllib.error.URLError("temporary network failure")

        with mock.patch.object(conversation_agent_bridge.sys, "stderr"):
            self.assertTrue(
                conversation_agent_bridge.job_should_continue(UnavailableRest(), "job-123")
            )

    def test_status_timeout_does_not_cancel_running_agent(self):
        class SlowRest:
            @staticmethod
            def rows(_table, _params, **_kwargs):
                raise TimeoutError("temporary timeout")

        with mock.patch.object(conversation_agent_bridge.sys, "stderr"):
            self.assertTrue(
                conversation_agent_bridge.job_should_continue(SlowRest(), "job-123")
            )

    def test_cancellation_status_check_has_a_short_network_timeout(self):
        rest = mock.Mock()
        rest.rows.return_value = [{"status": "processing"}]

        self.assertTrue(conversation_agent_bridge.job_is_processing(rest, "job-123"))

        self.assertEqual(
            rest.rows.call_args.kwargs["timeout_seconds"],
            conversation_agent_bridge.JOB_STATUS_REQUEST_TIMEOUT_SECONDS,
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

    @mock.patch.object(conversation_agent_bridge.urllib.request, "urlopen")
    def test_push_delivery_uses_one_job_token_and_exact_job_id(self, urlopen):
        response = urlopen.return_value.__enter__.return_value
        response.read.return_value = b'{"ok":true}'
        job = {
            "id": "11111111-1111-4111-8111-111111111111",
            "delivery_token": "22222222-2222-4222-8222-222222222222",
        }

        conversation_agent_bridge.deliver_push_job("https://spec.reslu.com.au/", job)

        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://spec.reslu.com.au/api/conversations/push/deliver")
        self.assertEqual(request.headers["Authorization"], f"Bearer {job['delivery_token']}")
        self.assertEqual(json.loads(request.data), {"job_id": job["id"]})

    @mock.patch.object(conversation_agent_bridge, "datetime")
    def test_failed_push_is_returned_to_durable_queue_with_backoff(self, mocked_datetime):
        mocked_datetime.now.return_value = datetime(2026, 8, 10, tzinfo=timezone.utc)
        rest = mock.Mock()
        job = {"id": "push-job", "attempts": 3, "delivery_token": "claim-token"}

        conversation_agent_bridge.mark_push_delivery_failed(rest, job, RuntimeError("temporary"))

        values = rest.patch_where.call_args.args[2]
        self.assertEqual(rest.patch_where.call_args.args[:2], (
            "conversation_push_jobs",
            {
                "id": "eq.push-job",
                "delivery_token": "eq.claim-token",
                "status": "eq.processing",
            },
        ))
        self.assertEqual(values["status"], "failed")
        self.assertEqual(values["next_attempt_at"], "2026-08-10T00:00:08+00:00")
        self.assertEqual(values["last_error"], "temporary")


if __name__ == "__main__":
    unittest.main()
