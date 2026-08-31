#!/usr/bin/env python3
"""Measure content-free OpenClaw voice-runtime overhead without business work."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import time
import uuid
from dataclasses import asdict, dataclass


SAFE_PROMPT = (
    "RESLU voice latency benchmark only. Do not use tools, memory, files, records, "
    "email, network access, or business actions. Reply with exactly READY."
)
AGENTS = ("main", "marco", "stuart")
MODEL_PATTERN = re.compile(r"^[A-Za-z0-9._:-]+/[A-Za-z0-9._:-]+$")


@dataclass(frozen=True)
class BenchmarkResult:
    agent: str
    model: str
    thinking: str
    wall_ms: int
    agent_duration_ms: int
    input_tokens: int
    output_tokens: int
    system_prompt_chars: int
    skills_prompt_chars: int
    tool_schema_chars: int


def result_envelope(payload: object) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("OpenClaw benchmark returned a non-object payload")
    nested = payload.get("result")
    return nested if isinstance(nested, dict) else payload


def parse_result(payload: object, *, agent: str, model: str, thinking: str, wall_ms: int) -> BenchmarkResult:
    envelope = result_envelope(payload)
    payloads = envelope.get("payloads")
    if not isinstance(payloads, list) or not payloads or payloads[0].get("text") != "READY":
        raise ValueError("OpenClaw benchmark did not return the fixed READY response")
    meta = envelope.get("meta")
    if not isinstance(meta, dict):
        raise ValueError("OpenClaw benchmark metadata is missing")
    agent_meta = meta.get("agentMeta")
    report = meta.get("systemPromptReport")
    if not isinstance(agent_meta, dict) or not isinstance(report, dict):
        raise ValueError("OpenClaw benchmark runtime metadata is missing")
    usage = agent_meta.get("usage") if isinstance(agent_meta.get("usage"), dict) else {}
    system_prompt = report.get("systemPrompt") if isinstance(report.get("systemPrompt"), dict) else {}
    skills = report.get("skills") if isinstance(report.get("skills"), dict) else {}
    tools = report.get("tools") if isinstance(report.get("tools"), dict) else {}
    return BenchmarkResult(
        agent=agent,
        model=model,
        thinking=thinking,
        wall_ms=max(0, wall_ms),
        agent_duration_ms=max(0, int(meta.get("durationMs") or 0)),
        input_tokens=max(0, int(usage.get("input") or 0)),
        output_tokens=max(0, int(usage.get("output") or 0)),
        system_prompt_chars=max(0, int(system_prompt.get("chars") or 0)),
        skills_prompt_chars=max(0, int(skills.get("promptChars") or 0)),
        tool_schema_chars=max(0, int(tools.get("schemaChars") or 0)),
    )


def run_once(*, agent: str, model: str, thinking: str, timeout_seconds: int) -> BenchmarkResult:
    command = [
        "openclaw",
        "agent",
        "--agent",
        agent,
        "--session-key",
        f"reslu-voice-benchmark-{uuid.uuid4()}",
        "--thinking",
        thinking,
        "--model",
        model,
        "--message",
        SAFE_PROMPT,
        "--timeout",
        str(timeout_seconds),
        "--json",
    ]
    started = time.monotonic()
    completed = subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
        timeout=timeout_seconds + 20,
    )
    wall_ms = round((time.monotonic() - started) * 1000)
    return parse_result(
        json.loads(completed.stdout),
        agent=agent,
        model=model,
        thinking=thinking,
        wall_ms=wall_ms,
    )


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", choices=AGENTS, default="main")
    parser.add_argument("--model", default="openai/gpt-5.6-terra")
    parser.add_argument("--thinking", choices=("off", "minimal", "low"), default="minimal")
    parser.add_argument("--runs", type=int, choices=range(1, 6), default=1, metavar="1-5")
    parser.add_argument("--timeout-seconds", type=int, choices=range(10, 121), default=60, metavar="10-120")
    args = parser.parse_args()
    if not MODEL_PATTERN.fullmatch(args.model):
        parser.error("--model must be a provider/model identifier")
    return args


def main() -> int:
    args = arguments()
    results = [
        run_once(
            agent=args.agent,
            model=args.model,
            thinking=args.thinking,
            timeout_seconds=args.timeout_seconds,
        )
        for _ in range(args.runs)
    ]
    output = {
        "schema_version": 1,
        "content_free": True,
        "runs": [asdict(result) for result in results],
        "average": {
            key: round(sum(getattr(result, key) for result in results) / len(results))
            for key in (
                "wall_ms",
                "agent_duration_ms",
                "input_tokens",
                "output_tokens",
                "system_prompt_chars",
                "skills_prompt_chars",
                "tool_schema_chars",
            )
        },
    }
    print(json.dumps(output, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
