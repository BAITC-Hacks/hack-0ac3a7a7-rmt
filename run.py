#!/usr/bin/env python3
"""One-command local build required by the hackathon brief."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def main() -> None:
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", str(ROOT / "requirements.txt")],
        check=True,
    )
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "starter.py"),
            "--data",
            str(ROOT / "data"),
            "--out",
            str(ROOT / "out"),
        ],
        check=True,
    )
    subprocess.run([sys.executable, str(ROOT / "validate.py")], check=True)


if __name__ == "__main__":
    main()
