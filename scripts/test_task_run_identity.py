"""Offline regression tests: no gateway, database or business tools are called."""
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location(
    "bridge", Path(__file__).with_name("conversation_agent_bridge.py")
)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class TaskRunIdentityTests(unittest.TestCase):
    def setUp(self):
        self.task = {
            "id": "426680ac-0d07-40e4-bd39-55a398f22b29",
            "conversation_id": "conversation-1",
            "title": "Prepare a review",
            "objective": "Prepare a review",
            "model_tier": "strong",
            "retry_count": 1,
            "steering_version": 0,
            "approval_state": "none",
        }
        self.agent = {"slug": "stuart", "display_name": "Stuart", "role_label": "Finance"}

    def key(self, task=None, artifacts=None, iteration=0):
        with mock.patch.dict(os.environ, {"RESLU_OPENCLAW_GATEWAY_EVENTS_ENABLED": "true"}), \
                mock.patch.object(bridge, "invoke_agent_via_gateway", return_value=json.dumps({
                    "status": "completed", "summary": "Fixture only", "message": "Fixture only",
                })) as gateway, mock.patch.object(bridge.subprocess, "Popen") as cli:
            bridge.invoke_task_agent(
                self.agent, task or self.task, "", artifacts or [],
                should_continue=lambda: True, steering_iteration=iteration,
            )
            cli.assert_not_called()
            return gateway.call_args.kwargs["idempotency_key"]

    def test_approval_cannot_reuse_preparation_run(self):
        approved = {**self.task, "approval_state": "approved", "approval_receipt_id": "receipt-1"}
        self.assertNotEqual(self.key(), self.key(approved))
        self.assertEqual(self.key(approved), self.key(dict(approved)))
        self.assertNotEqual(self.key(approved), self.key({**approved, "approval_receipt_id": "receipt-2"}))

    def test_durable_steering_survives_worker_restart(self):
        steered = {**self.task, "steering_version": 3}
        self.assertNotEqual(self.key(), self.key(steered))
        self.assertEqual(self.key(steered, iteration=2), self.key(steered, iteration=0))

    def test_review_revision_gets_new_run_and_same_revision_deduplicates(self):
        revision = {**self.task, "approval_state": "changes_requested", "approval_note": "Refresh evidence"}
        first = [{"id": "artifact-1", "status": "changes_requested", "content": {"retrieved_at": "first"}}]
        second = [{"id": "artifact-1", "status": "changes_requested", "content": {"retrieved_at": "second"}}]
        self.assertNotEqual(self.key(), self.key(revision, first))
        self.assertEqual(self.key(revision, first), self.key(dict(revision), list(first)))
        self.assertNotEqual(self.key(revision, first), self.key(revision, second))

    def test_review_input_order_does_not_change_identity(self):
        revision = {**self.task, "approval_state": "changes_requested", "approval_note": "Refresh"}
        artifacts = [{"id": "b", "content": {"a": 1, "b": 2}}, {"id": "a", "content": {"value": 3}}]
        reordered = [{"content": {"value": 3}, "id": "a"}, {"id": "b", "content": {"b": 2, "a": 1}}]
        self.assertEqual(self.key(revision, artifacts), self.key(revision, reordered))

    def test_approved_results_and_progress_cannot_create_new_execution_identity(self):
        approved = {**self.task, "approval_state": "approved", "approval_receipt_id": "receipt-1"}
        progressed = {**approved, "updated_at": "later", "gateway_run_id": "previous", "approval_note": "display note"}
        self.assertEqual(self.key(approved), self.key(progressed, [{"content": {"result": "updated"}}]))

    def test_explicit_retry_and_distinct_tasks_remain_distinct_and_bounded(self):
        self.assertNotEqual(self.key(), self.key({**self.task, "retry_count": 2}))
        self.assertNotEqual(self.key(), self.key({**self.task, "id": "319440cb-556b-434a-9def-3f57126e358d"}))
        key = self.key()
        self.assertRegex(key, r"^[A-Za-z0-9_-]{1,160}$")

    def failed_worker_state(self, task):
        rest = mock.Mock()
        rest.claim_task.side_effect = [task, KeyboardInterrupt()]
        with mock.patch.object(bridge, "SupabaseRest", return_value=rest), \
                mock.patch.object(bridge, "process_task", side_effect=RuntimeError("uncertain result")), \
                mock.patch.object(bridge, "task_should_continue", return_value=True), \
                mock.patch.object(bridge, "insert_task_event"), \
                mock.patch.object(bridge.time, "sleep"):
            with self.assertRaises(KeyboardInterrupt):
                bridge.task_worker_loop("unused", "unused", "stuart")
        return rest.patch.call_args.args[2]["status"]

    def test_approved_or_pending_failure_never_automatically_requeues(self):
        for state, receipt in [("approved", "receipt-1"), ("approved", None), ("pending", None), ("none", "receipt-1")]:
            with self.subTest(state=state, receipt=receipt):
                task = {**self.task, "retry_count": 0, "approval_state": state, "approval_receipt_id": receipt}
                self.assertEqual(self.failed_worker_state(task), "failed")

    def test_unapproved_recovery_retains_existing_single_retry(self):
        self.assertEqual(self.failed_worker_state({**self.task, "retry_count": 0}), "queued")
        self.assertEqual(self.failed_worker_state({**self.task, "retry_count": 1}), "failed")


if __name__ == "__main__":
    unittest.main()
