import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch


MODULE_PATH = Path(__file__).with_name("aria_heartbeat.py")
SPEC = importlib.util.spec_from_file_location("aria_heartbeat", MODULE_PATH)
aria_heartbeat = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(aria_heartbeat)


class AriaHeartbeatTests(unittest.TestCase):
    def test_batch_limit_is_timeout_safe(self):
        self.assertEqual(aria_heartbeat.QUEUE_BATCH_LIMIT, 4)

    def test_count_url_encodes_filters(self):
        url = aria_heartbeat._queue_count_url(
            "https://example.supabase.co",
            status="eq.picked_up",
            picked_up_at="lt.2026-07-14T00:00:00+00:00",
        )
        self.assertIn("status=eq.picked_up", url)
        self.assertIn("picked_up_at=lt.2026-07-14T00%3A00%3A00%2B00%3A00", url)

    @patch.object(aria_heartbeat, "_queue_count", side_effect=[3, 2])
    def test_actionable_count_includes_pending_and_abandoned(self, count):
        self.assertEqual(
            aria_heartbeat.get_actionable_queue_count("https://example.test", "secret"),
            5,
        )
        self.assertEqual(count.call_count, 2)

    def test_claim_queue_items_posts_to_atomic_claim_function(self):
        response = MagicMock()
        response.read.return_value = json.dumps(
            [{"id": "queue-1", "kind": "invoice_candidate", "payload": {}}]
        ).encode()
        response.__enter__.return_value = response
        response.__exit__.return_value = False

        with patch.object(aria_heartbeat.urllib.request, "urlopen", return_value=response) as urlopen:
            items = aria_heartbeat.claim_queue_items("https://example.test", "secret", limit=4)

        self.assertEqual(items[0]["id"], "queue-1")
        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.full_url, "https://example.test/rest/v1/rpc/claim_aria_queue_items")
        self.assertEqual(json.loads(request.data), {"p_limit": 4})

    @patch("subprocess.run")
    def test_wake_message_forbids_overlapping_queue_claim(self, run):
        run.return_value = MagicMock(returncode=0, stdout="{}", stderr="")

        self.assertTrue(
            aria_heartbeat.wake_aria(
                [{"id": "queue-1", "kind": "invoice_candidate", "payload": {}}]
            )
        )

        message = run.call_args.args[0]
        text_index = message.index("--text") + 1
        self.assertIn("Do NOT call get_aria_queue", message[text_index])

    @patch.object(aria_heartbeat, "release_queue_items")
    @patch.object(aria_heartbeat, "wake_aria", return_value=False)
    @patch.object(
        aria_heartbeat,
        "claim_queue_items",
        return_value=[{"id": "queue-1", "kind": "invoice_candidate", "payload": {}}],
    )
    @patch.object(aria_heartbeat, "get_actionable_queue_count", return_value=1)
    def test_failed_wake_releases_claimed_batch(self, _count, _claim, _wake, release):
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            aria_heartbeat.os.environ,
            {
                "SUPABASE_URL": "https://example.test",
                "SUPABASE_SERVICE_ROLE_KEY": "secret",
                "ARIA_HEARTBEAT_STATE_PATH": str(Path(directory) / "state.json"),
            },
            clear=False,
        ), self.assertRaises(SystemExit) as exited:
            aria_heartbeat.main()

        self.assertEqual(exited.exception.code, 1)
        release.assert_called_once_with("https://example.test", "secret", ["queue-1"])

    def test_successful_wake_is_throttled_for_twenty_minutes(self):
        now = datetime(2026, 7, 14, 13, 0, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "heartbeat.json"
            aria_heartbeat.record_successful_wake(
                state_path,
                [{"id": "queue-1"}, {"id": "queue-2"}],
                now=now,
            )

            remaining = aria_heartbeat.wake_cooldown_remaining(
                state_path,
                now=now + timedelta(minutes=5),
            )

        self.assertEqual(remaining, timedelta(minutes=15))

    def test_successful_wake_can_retry_after_cooldown(self):
        now = datetime(2026, 7, 14, 13, 0, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "heartbeat.json"
            aria_heartbeat.record_successful_wake(
                state_path,
                [{"id": "queue-1"}, {"id": "queue-2"}],
                now=now,
            )

            remaining = aria_heartbeat.wake_cooldown_remaining(
                state_path,
                now=now + timedelta(minutes=20),
            )

        self.assertEqual(remaining, timedelta(0))

    def test_empty_queue_state_clear_allows_new_work_to_wake_immediately(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "heartbeat.json"
            state_path.write_text(
                json.dumps({"last_successful_wake_at": "2026-07-14T13:00:00+00:00"})
            )

            aria_heartbeat.clear_wake_state(state_path)

            self.assertFalse(state_path.exists())
            self.assertEqual(
                aria_heartbeat.wake_cooldown_remaining(state_path),
                timedelta(0),
            )

    def test_corrupt_state_never_suppresses_a_real_wake(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "heartbeat.json"
            state_path.write_text("not-json")

            self.assertEqual(
                aria_heartbeat.wake_cooldown_remaining(state_path),
                timedelta(0),
            )

    def test_successful_wake_records_exact_batch(self):
        now = datetime(2026, 7, 14, 13, 0, tzinfo=timezone.utc)
        queue_items = [
            {
                "id": "queue-1",
                "kind": "invoice_candidate",
                "payload": {"supplier": "Example"},
                "created_at": "2026-07-14T12:00:00+00:00",
            }
        ]
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "heartbeat.json"
            aria_heartbeat.record_successful_wake(state_path, queue_items, now=now)

            self.assertEqual(aria_heartbeat.active_queue_batch(state_path), queue_items)

    @patch.object(aria_heartbeat, "claim_queue_items")
    @patch.object(aria_heartbeat, "wake_aria")
    @patch.object(
        aria_heartbeat,
        "get_queue_item_statuses",
        return_value={"queue-1": "picked_up"},
    )
    def test_unfinished_active_batch_blocks_new_claim_during_cooldown(
        self,
        _statuses,
        wake,
        claim,
    ):
        now = datetime.now(timezone.utc)
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            aria_heartbeat.os.environ,
            {
                "SUPABASE_URL": "https://example.test",
                "SUPABASE_SERVICE_ROLE_KEY": "secret",
                "ARIA_HEARTBEAT_STATE_PATH": str(Path(directory) / "state.json"),
            },
            clear=False,
        ):
            aria_heartbeat.record_successful_wake(
                aria_heartbeat.heartbeat_state_path(),
                [{"id": "queue-1", "kind": "daily_review", "payload": {}}],
                now=now,
            )
            aria_heartbeat.main()

        claim.assert_not_called()
        wake.assert_not_called()

    @patch.object(aria_heartbeat, "claim_queue_items")
    @patch.object(aria_heartbeat, "wake_aria", return_value=True)
    @patch.object(
        aria_heartbeat,
        "get_queue_item_statuses",
        return_value={"queue-1": "picked_up"},
    )
    def test_expired_active_batch_rewakes_same_items_without_new_claim(
        self,
        _statuses,
        wake,
        claim,
    ):
        now = datetime.now(timezone.utc)
        queue_items = [
            {
                "id": "queue-1",
                "kind": "daily_review",
                "payload": {},
                "created_at": None,
            }
        ]
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            aria_heartbeat.os.environ,
            {
                "SUPABASE_URL": "https://example.test",
                "SUPABASE_SERVICE_ROLE_KEY": "secret",
                "ARIA_HEARTBEAT_STATE_PATH": str(Path(directory) / "state.json"),
            },
            clear=False,
        ):
            aria_heartbeat.record_successful_wake(
                aria_heartbeat.heartbeat_state_path(),
                queue_items,
                now=now - timedelta(minutes=21),
            )
            aria_heartbeat.main()

        claim.assert_not_called()
        wake.assert_called_once_with(queue_items)


if __name__ == "__main__":
    unittest.main()
