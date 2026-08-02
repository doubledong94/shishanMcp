#!/usr/bin/env python3
"""Demo Python worker — reads a JSON payload from STDIN, writes JSON to STDOUT.

Contract (used by apps/backend/src/core/tool-executor.service.ts):
  - input : one JSON object on STDIN, e.g. {"text": "hello"}
  - output: one JSON object on STDOUT, e.g. {"word_count": 1, ...}
  - non-zero exit code + message on STDERR = error

Add your own scripts here (native/python/). They get picked up automatically —
no build step, just install pip deps into requirements.txt.
"""
import json
import sys


def main() -> None:
    payload = json.load(sys.stdin)
    text = str(payload.get("text", ""))

    result = {
        "word_count": len(text.split()),
        "char_count": len(text),
        "reversed": text[::-1],
        "upper": text.upper(),
        "language": "python",
    }
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"python worker error: {exc}", file=sys.stderr)
        sys.exit(1)
