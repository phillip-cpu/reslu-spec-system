import importlib.util
import unittest
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


if __name__ == "__main__":
    unittest.main()
