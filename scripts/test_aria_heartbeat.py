import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("aria_heartbeat.py")
SPEC = importlib.util.spec_from_file_location("aria_heartbeat", MODULE_PATH)
aria_heartbeat = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(aria_heartbeat)


class AriaHeartbeatTests(unittest.TestCase):
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

    def test_successful_wake_is_throttled_for_twenty_minutes(self):
        now = datetime(2026, 7, 14, 13, 0, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "heartbeat.json"
            aria_heartbeat.record_successful_wake(state_path, 2, now=now)

            remaining = aria_heartbeat.wake_cooldown_remaining(
                state_path,
                now=now + timedelta(minutes=5),
            )

        self.assertEqual(remaining, timedelta(minutes=15))

    def test_successful_wake_can_retry_after_cooldown(self):
        now = datetime(2026, 7, 14, 13, 0, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "heartbeat.json"
            aria_heartbeat.record_successful_wake(state_path, 2, now=now)

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


if __name__ == "__main__":
    unittest.main()
