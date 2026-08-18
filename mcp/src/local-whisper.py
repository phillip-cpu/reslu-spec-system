#!/usr/bin/env python3
"""Private, local-only transcription entry point for RESLU Meeting Mode."""

import argparse
import json
import os
import sys

import mlx_whisper


INITIAL_PROMPT = (
    "Australian English client meeting. Names and terms may include Phillip, "
    "RESLU, Aria, Adelaide, project addresses, architects, builders, suppliers, "
    "materials, selections, quotations, variations and construction details."
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path")
    parser.add_argument(
        "--model",
        default=os.environ.get("RESLU_LOCAL_WHISPER_MODEL", "mlx-community/whisper-small-mlx"),
    )
    args = parser.parse_args()

    result = mlx_whisper.transcribe(
        args.audio_path,
        path_or_hf_repo=args.model,
        language="en",
        initial_prompt=INITIAL_PROMPT,
        condition_on_previous_text=False,
        verbose=False,
    )
    text = str(result.get("text") or "").strip()
    if not text:
        raise RuntimeError("Local Whisper returned an empty transcript")
    json.dump(
        {
            "text": text,
            "language": result.get("language") or "en",
            "engine": "mlx-whisper",
            "model": args.model,
        },
        sys.stdout,
        ensure_ascii=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
