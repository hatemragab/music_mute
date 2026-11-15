#!/usr/bin/env python3
"""Launch a locally built Debug app on the sole authorized simulator, without printing keys."""
import argparse
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
UDID = "3CC14436-EC3C-4419-A079-C84951E5FA07"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True, type=Path, help="Path to the simulator Debug MusicMute.app")
    parser.add_argument("--fixture", action="store_true", help="Run isolated processing UI and safe diagnostics canary fixtures")
    args = parser.parse_args()
    if not (args.app / "Info.plist").is_file():
        parser.error("--app must identify a built simulator Debug MusicMute.app")
    keys_file = ROOT / ".runtime/local-logging/keys.json"
    if not keys_file.is_file():
        parser.error("Start tools/local-logging first to create the private source keys")
    key = json.loads(keys_file.read_text())["keys"]["ios"]
    devices = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "devices", "available", "--json"]))["devices"]
    target = next((device for runtime, group in devices.items() if runtime.endswith("iOS-26-0") for device in group if device["udid"] == UDID and device["name"] == "iPhone 17 Pro"), None)
    if target is None:
        parser.error("The authorized iPhone 17 Pro / iOS 26.0 simulator is unavailable")
    if target["state"] == "Shutdown":
        subprocess.run(["xcrun", "simctl", "boot", UDID], check=True)
    subprocess.run(["xcrun", "simctl", "bootstatus", UDID, "-b"], check=True)
    subprocess.run(["xcrun", "simctl", "install", UDID, str(args.app.resolve())], check=True)
    environment = os.environ.copy()
    for name, value in {
        "MUSICMUTE_LOG_ENABLED": "1", "MUSICMUTE_LOG_PAYLOADS": os.environ.get("MUSICMUTE_LOG_PAYLOADS", "1"),
        "MUSICMUTE_LOG_CONSOLE": os.environ.get("MUSICMUTE_LOG_CONSOLE", "0"),
        "MUSICMUTE_LOG_ENDPOINT": "http://127.0.0.1:19740/ingest/ios", "MUSICMUTE_LOG_KEY": key,
    }.items():
        environment[f"SIMCTL_CHILD_{name}"] = value
    command = ["xcrun", "simctl", "launch", UDID, "com.hatem.musicmute"]
    if args.fixture:
        command += ["--processing-ui-fixture", "--local-logging-smoke"]
    subprocess.run(command, env=environment, check=True)
    print("Debug logging configured for this launch; an already running app must be closed manually before relaunch to inherit environment settings.")


if __name__ == "__main__":
    main()
