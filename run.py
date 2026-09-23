#!/usr/bin/env python3
"""One-command local build required by the hackathon brief."""

from __future__ import annotations

import subprocess
import sys
import argparse
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def main() -> None:
    parser = argparse.ArgumentParser(description='Build and optionally serve Freedom AML')
    parser.add_argument('--serve',action='store_true',help='Запустить интерфейс с backend после расчёта')
    parser.add_argument('--skip-install',action='store_true',help='Не переустанавливать зависимости')
    parser.add_argument('--port',type=int,default=8000)
    args=parser.parse_args()
    if not args.skip_install:
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
    if args.serve:
        subprocess.run([sys.executable,str(ROOT/'server.py'),'--port',str(args.port)],check=True)


if __name__ == "__main__":
    main()
