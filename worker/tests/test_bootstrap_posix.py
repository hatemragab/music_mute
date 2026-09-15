"""Rendered shell runs with fake host/HTTPS boundaries and real archive checks.

No elevation, service, GPU, production HTTP, or host installation is performed.
"""

import hashlib
import io
import json
import os
import shlex
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from pathlib import Path
from uuid import uuid4

from musicmute_worker.bootstrap_events import import_bootstrap_events
from musicmute_worker.bootstrap_recipe import render_entrypoint
from musicmute_worker.events import EventSpool


@unittest.skipUnless(
    Path("/usr/bin/lockf").is_file(), "macOS lockf fixture requires its native utility"
)
class PosixBootstrapTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.base = self.root / "installation"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.marker = self.root / "executed"
        self.archive = self.root / "bundle.tar.gz"
        self.transport = self.root / "transport.jsonl"
        self.make_archive()
        digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.recipe = {
            "schemaVersion": 3,
            "installerBuild": 1,
            "launcherBuild": 1,
            "apiBaseUrl": "https://api.example.test/api/v1",
            "distributionOrigin": "https://updates.music-mute.com",
            "bundles": [
                {
                    "os": "macos",
                    "arch": "arm64",
                    "url": f"https://updates.music-mute.com/releases/{uuid4()}/launcher-macos-arm64/{digest}/bootstrap.tar.gz",
                    "sha256": digest,
                    "bytes": self.archive.stat().st_size,
                    "expandedBytes": self.expanded,
                    "pythonPath": "python/bin/python3",
                    "rootPath": "trust/root.json",
                    "rootSha256": hashlib.sha256(b"{}").hexdigest(),
                }
            ],
        }
        self.executable("id", "#!/bin/sh\nprintf '0\\n'\n")
        self.executable(
            "uname", "#!/bin/sh\ncase $1 in -s) echo Darwin;; -m) echo arm64;; esac\n"
        )
        self.executable(
            "stat",
            "#!/bin/sh\ncase $2 in %u) echo 0;; %Lp) echo 700;; *) exit 1;; esac\n",
        )
        self.executable(
            "ioreg",
            '#!/bin/sh\necho \'"IOPlatformUUID" = "12345678-1234-1234-1234-123456789abc"\'\n',
        )
        self.executable("sync", "#!/bin/sh\nexit 0\n")
        self.executable(
            "curl",
            f"#!{sys.executable}\n"
            + """
import fcntl, json, os, pathlib, sys
# A separately opened descriptor must conflict while native setup is running.
with (pathlib.Path(os.environ['FIXTURE_BASE']) / 'state/bootstrap.lock').open('r+') as guard:
    try:
        fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        pass
    else:
        raise RuntimeError('Native bootstrap did not retain its kernel lock')
a = sys.argv[1:]
out = pathlib.Path(a[a.index('--output') + 1])
url = a[-1]
with pathlib.Path(os.environ['FIXTURE_TRANSPORT']).open('a') as log:
    body = None
    if '--data-binary' in a:
        body = json.loads(pathlib.Path(a[a.index('--data-binary') + 1][1:]).read_text())
    log.write(json.dumps({'url': url, 'body': body, 'args': a}) + '\\n')
if '--dump-header' in a:
    pathlib.Path(a[a.index('--dump-header') + 1]).write_text(
        os.environ.get('FIXTURE_HEADERS', ''))
if url.endswith('.tar.gz'):
    out.write_bytes(pathlib.Path(os.environ['FIXTURE_ARCHIVE']).read_bytes())
else:
    out.write_text(json.dumps({'serverTime': '2027-01-15T08:00:00.000Z'}, separators=(',', ':')))
    forced = os.environ.get('FIXTURE_STATUS')
    print(forced or ('201' if url.endswith('/worker-installations') else '200'), end='')
""",
        )

    def executable(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o700)

    def make_archive(self, *, unsafe=False):
        with tarfile.open(self.archive, "w:gz") as archive:
            entries = {
                "python/bin/python3": f"#!/bin/sh\nprintf done > {shlex.quote(str(self.marker))}\n".encode(),
                "trust/root.json": b"{}",
            }
            if unsafe:
                entries["../escaped"] = b"never"
            for name, data in entries.items():
                item = tarfile.TarInfo(name)
                item.size = len(data)
                item.mode = 0o700 if name.endswith("python3") else 0o600
                archive.addfile(item, io.BytesIO(data))
        import gzip

        self.expanded = len(gzip.decompress(self.archive.read_bytes()))

    def run_installer(self, **environment):
        templates = self.root / "templates"
        templates.mkdir(exist_ok=True)
        source = (
            Path(__file__).resolve().parents[1] / "install/install.sh"
        ).read_text()
        source = source.replace(
            "BASE='/Library/Application Support/MusicMute'",
            "BASE=" + shlex.quote(str(self.base)),
        )
        (templates / "install.sh").write_text(source)
        source = render_entrypoint(self.recipe, "posix", templates=templates)
        script = self.root / "install.sh"
        script.write_text(source)
        return subprocess.run(
            ["/bin/sh", str(script)],
            capture_output=True,
            check=False,
            text=True,
            timeout=30,
            env={
                **os.environ,
                "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
                "FIXTURE_ARCHIVE": str(self.archive),
                "FIXTURE_TRANSPORT": str(self.transport),
                "FIXTURE_BASE": str(self.base),
                **environment,
            },
        )

    def requests(self):
        if not self.transport.exists():
            return []
        return [
            json.loads(line) for line in self.transport.read_text().splitlines() if line
        ]

    def registrations(self):
        return [
            entry
            for entry in self.requests()
            if entry["url"].endswith("/worker-installations")
        ]

    def deadline(self):
        path = self.base / "state/setup/retry-after.json"
        return json.loads(path.read_text()) if path.exists() else None

    def test_throttled_registration_persists_a_durable_deadline(self):
        before = int(time.time())
        result = self.run_installer(
            FIXTURE_STATUS="429", FIXTURE_HEADERS="Retry-After: 60\r\n"
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("REPORTING_UNAVAILABLE", result.stderr)
        record = self.deadline()
        self.assertEqual(record["schemaVersion"], 3)
        self.assertEqual(record["code"], "REPORTING_UNAVAILABLE")
        # The deadline is a wall-clock instant within the offered window.
        self.assertGreaterEqual(record["deadlineEpoch"], before + 55)
        self.assertLessEqual(record["deadlineEpoch"], before + 130)

    def test_a_persisted_deadline_blocks_a_manual_rerun_without_any_request(self):
        self.run_installer(
            FIXTURE_STATUS="429", FIXTURE_HEADERS="Retry-After: 3600\r\n"
        )
        sent = len(self.requests())
        # The operator retries immediately, now against a healthy server.
        result = self.run_installer()
        self.assertEqual(result.returncode, 1)
        self.assertIn("REPORTING_UNAVAILABLE", result.stderr)
        self.assertEqual(len(self.requests()), sent)
        # The recorded deadline is not silently extended by the blocked rerun.
        self.assertEqual(self.deadline()["code"], "REPORTING_UNAVAILABLE")

    def test_a_header_date_is_bounded_rather_than_reinterpreted(self):
        before = int(time.time())
        self.run_installer(
            FIXTURE_STATUS="429",
            FIXTURE_HEADERS="Retry-After: Wed, 21 Oct 2027 07:28:00 GMT\r\n",
        )
        record = self.deadline()
        self.assertGreaterEqual(record["deadlineEpoch"], before + 890)
        self.assertLessEqual(record["deadlineEpoch"], before + 905)

    def test_an_expired_deadline_and_a_successful_run_clear_it(self):
        (self.base / "state/setup").mkdir(parents=True, exist_ok=True)
        (self.base / "state/setup/retry-after.json").write_text(
            json.dumps(
                {
                    "deadlineEpoch": int(time.time()) - 1,
                    "code": "REPORTING_UNAVAILABLE",
                    "schemaVersion": 3,
                }
            )
        )
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(self.deadline())

    def test_a_corrupt_deadline_record_fails_visibly(self):
        (self.base / "state/setup").mkdir(parents=True, exist_ok=True)
        (self.base / "state/setup/retry-after.json").write_text("{not json")
        result = self.run_installer()
        self.assertEqual(result.returncode, 1)
        self.assertIn("UNSAFE_STATE_PATH", result.stderr)
        self.assertEqual(self.requests(), [])

    def test_verified_bundle_runs_and_native_event_imports_without_credentials(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.marker.exists())
        identity = json.loads((self.base / "identity/setup-identity.json").read_text())
        self.assertNotIn(
            identity["installationToken"],
            result.stdout + result.stderr + self.transport.read_text(),
        )
        spool = EventSpool(self.base / "events", identity["installationId"])
        self.assertEqual(
            import_bootstrap_events(self.base / "events/bootstrap", spool), 1
        )
        self.assertEqual(spool.inspect()["pending"], 1)
        # A repeat uses exactly the saved identity and does not download again.
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads((self.base / "identity/setup-identity.json").read_text()),
            identity,
        )
        calls = [json.loads(line) for line in self.transport.read_text().splitlines()]
        self.assertEqual(sum(call["url"].endswith(".tar.gz") for call in calls), 1)

    def test_checksum_failure_reports_and_resume_keeps_identity(self):
        original = self.archive.read_bytes()
        self.archive.write_bytes(bytes([original[0] ^ 1]) + original[1:])
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.marker.exists())
        saved = (self.base / "identity/setup-identity.json").read_bytes()
        events = [
            json.loads(p.read_text())
            for p in (self.base / "events/bootstrap").glob("*.json")
        ]
        self.assertEqual(events[0]["event"]["code"], "CHECKSUM_MISMATCH")
        self.archive.write_bytes(original)
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            (self.base / "identity/setup-identity.json").read_bytes(), saved
        )

    def test_authenticated_but_unsafe_archive_never_extracts_or_executes(self):
        self.make_archive(unsafe=True)
        bundle = self.recipe["bundles"][0]
        old = bundle["sha256"]
        bundle["sha256"] = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        bundle["url"] = bundle["url"].replace(old, bundle["sha256"])
        bundle["bytes"] = self.archive.stat().st_size
        bundle["expandedBytes"] = self.expanded
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.marker.exists())
        self.assertFalse((self.base / "state/escaped").exists())

    def test_cached_interpreter_tampering_never_executes(self):
        self.assertEqual(self.run_installer().returncode, 0)
        self.marker.unlink()
        config = json.loads((self.base / "config/setup-host.json").read_text())
        Path(config["launcherPath"]).write_text("#!/bin/sh\necho tampered\n")
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("tampered", result.stdout)
        self.assertIn("BOOTSTRAP_CACHE_INVALID", result.stderr)

    def test_new_installer_build_uses_protected_cached_host_without_registration(self):
        self.assertEqual(self.run_installer().returncode, 0)
        calls_before = self.transport.read_bytes()
        self.recipe["installerBuild"] = 2
        bundle = self.recipe["bundles"][0]
        bundle["url"] = bundle["url"].replace(bundle["sha256"], "c" * 64)
        bundle["sha256"] = "c" * 64
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.transport.read_bytes(), calls_before)

    def test_abandoned_lock_file_is_reused_but_live_lock_is_not_stolen(self):
        import fcntl

        self.assertEqual(self.run_installer().returncode, 0)
        lock = self.base / "state/bootstrap.lock"
        lock.write_text("Retained inode after interrupted bootstrap")
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        with lock.open("r+") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_installer()
            self.assertNotEqual(result.returncode, 0)

    def test_missing_identity_with_durable_setup_record_is_not_replaced(self):
        self.assertEqual(self.run_installer().returncode, 0)
        calls = self.transport.read_bytes()
        identity = self.base / "identity/setup-identity.json"
        identity.unlink()
        # Cover the shared journal itself, without relying on cached host config.
        (self.base / "config/setup-host.json").unlink()
        setup = self.base / "state/setup"
        # The entrypoint now creates this root for its durable backoff record.
        setup.mkdir(mode=0o700, exist_ok=True)
        (setup / "setup.json").write_text('{"schemaVersion":3}')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("MISSING_IDENTITY", result.stderr)
        self.assertFalse(identity.exists())
        self.assertEqual(self.transport.read_bytes(), calls)


if __name__ == "__main__":
    unittest.main()
