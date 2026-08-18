import unittest

from scripts import openclaw_voice_runtime_benchmark as benchmark


class VoiceRuntimeBenchmarkTests(unittest.TestCase):
    def test_parses_gateway_cli_envelope_without_identifiers_or_content(self):
        parsed = benchmark.parse_result(
            {
                "runId": "must-not-leak",
                "result": {
                    "payloads": [{"text": "READY"}],
                    "meta": {
                        "durationMs": 12854,
                        "agentMeta": {"usage": {"input": 26996, "output": 5}},
                        "systemPromptReport": {
                            "systemPrompt": {"chars": 18743},
                            "skills": {"promptChars": 8918},
                            "tools": {"schemaChars": 19789},
                        },
                    },
                },
            },
            agent="main",
            model="openai/gpt-5.6-terra",
            thinking="minimal",
            wall_ms=15350,
        )
        self.assertEqual(parsed.agent_duration_ms, 12854)
        self.assertEqual(parsed.input_tokens, 26996)
        self.assertEqual(parsed.tool_schema_chars, 19789)
        self.assertNotIn("run", vars(parsed))
        self.assertNotIn("text", vars(parsed))

    def test_rejects_any_response_other_than_fixed_ready(self):
        with self.assertRaisesRegex(ValueError, "fixed READY"):
            benchmark.parse_result(
                {"payloads": [{"text": "I used a tool"}], "meta": {}},
                agent="main",
                model="openai/gpt-5.6-terra",
                thinking="minimal",
                wall_ms=1,
            )

    def test_prompt_explicitly_forbids_tools_and_business_actions(self):
        self.assertIn("Do not use tools", benchmark.SAFE_PROMPT)
        self.assertIn("business actions", benchmark.SAFE_PROMPT)
        self.assertIn("exactly READY", benchmark.SAFE_PROMPT)


if __name__ == "__main__":
    unittest.main()
