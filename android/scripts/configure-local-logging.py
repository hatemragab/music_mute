#!/usr/bin/env python3
"""Configure an explicitly selected Android Debug install; never installs or restarts an app."""
import argparse
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True, help="Explicit adb device serial (never chosen automatically)")
    parser.add_argument("--package", choices=["com.hatem.musicmute", "com.hatem.musicmute.authtest"], default="com.hatem.musicmute")
    parser.add_argument("--disable", action="store_true")
    parser.add_argument("--no-payloads", action="store_true")
    parser.add_argument("--console", action="store_true")
    parser.add_argument("--reverse", action="store_true", help="Explicitly forward device loopback TCP 19740 to this Mac")
    args = parser.parse_args()
    data = {"enabled": False}
    if not args.disable:
        keys_file = ROOT / ".runtime/local-logging/keys.json"
        if not keys_file.is_file():
            parser.error("Start tools/local-logging first to create the private source keys")
        key = json.loads(keys_file.read_text())["keys"]["android"]
        data = {"enabled": True, "key": key, "endpoint": "http://127.0.0.1:19740/ingest/android", "payloads": not args.no_payloads, "console": args.console}
    adb = ["adb", "-s", args.serial]
    if args.reverse:
        subprocess.run(adb + ["reverse", "tcp:19740", "tcp:19740"], check=True)
    # Fixed command only; credentials travel on stdin, never through shell interpolation/argv.
    command = f"run-as {args.package} sh -c 'umask 077; mkdir -p files; cat > files/local-logging.json.new && chmod 600 files/local-logging.json.new && mv files/local-logging.json.new files/local-logging.json'"
    subprocess.run(adb + ["shell", "-T", command], input=json.dumps(data).encode(), check=True)
    print("Private Debug logging settings saved. Close and reopen the app manually to apply them. Release builds ignore this file.")


if __name__ == "__main__":
    main()
