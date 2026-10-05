"""Real private-socket lifecycle with a synthetic engine, no GPU or user data."""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]


class LocalEngineServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="mm-engine-", dir="/tmp")
        self.root = Path(self.temporary.name).resolve()
        self.socket = self.root / "engine.sock"
        self.work = self.root / "cache/jobs" / str(uuid.uuid4())
        self.work.mkdir(parents=True, mode=0o700)
        self.input = self.work / "source.m4a"
        self.input.write_bytes(b"synthetic audio")
        self.input.chmod(0o600)
        self.model = self.root / "model"
        self.model.write_bytes(b"synthetic model")
        package = self.root / "musicmute_engine"
        package.mkdir()
        (package / "__init__.py").write_text("")
        (package / "artifacts.py").write_text("def model_path(root): return root / 'model'\n")
        (package / "media.py").write_text("def sha256_base64(path): raise AssertionError('request digest was already supplied')\n")
        (package / "recipes.py").write_text("def recipe_snapshot(*args, **kwargs): return {}\n")
        (package / "pipeline.py").write_text('''
import base64, hashlib, time
from pathlib import Path
class ProcessRequest:
    @staticmethod
    def from_payload(value): return value
class RuntimePipeline:
    def __init__(self, **kwargs): self.calls = 0
    def process(self, request, progress, window_progress):
        self.calls += 1
        content = Path(request['input']['path']).read_bytes()
        if base64.b64encode(hashlib.sha256(content).digest()).decode() != request['input']['sha256']:
            error = ValueError('INPUT_CHECKSUM_MISMATCH'); raise error
        progress('separation')
        if content == b'block': time.sleep(60)
        return {'calls': self.calls, 'outputPath': request['input']['path']}
''')
        self.child = subprocess.Popen([
            sys.executable, str(ROOT / "engine/local_pipeline.py"), "--serve",
            "--service-root", str(self.root), "--socket", str(self.socket),
            "--engine-id", "a" * 64, "--model-cache", str(self.root),
            "--ffmpeg", sys.executable, "--ffprobe", sys.executable,
        ], env={**os.environ, "PYTHONPATH": str(self.root), "PYTHONDONTWRITEBYTECODE": "1"},
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
        deadline = time.monotonic() + 5
        while not self.socket.exists() and time.monotonic() < deadline:
            if self.child.poll() is not None:
                self.fail(self.child.stderr.read().decode())
            time.sleep(0.02)
        self.assertTrue(self.socket.exists())

    def tearDown(self):
        if self.child.poll() is None:
            os.killpg(self.child.pid, signal.SIGKILL)
        self.child.wait(timeout=5)
        self.child.stderr.close()
        self.temporary.cleanup()

    def connect(self):
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(5)
        client.connect(str(self.socket))
        stream = client.makefile("rb")
        hello = json.loads(stream.readline())
        self.assertEqual(hello['engine_id'], 'a' * 64)
        return client, stream, hello['pid']

    def request(self, changes=None):
        client, stream, pid = self.connect()
        message = dict(operation="process", input=str(self.input), work_root=str(self.work),
            sha256=base64.b64encode(hashlib.sha256(self.input.read_bytes()).digest()).decode())
        message.update(changes or {})
        client.sendall((json.dumps(message) + "\n").encode())
        events = []
        while True:
            event = json.loads(stream.readline())
            events.append(event)
            if event['type'] in ('result', 'error'):
                break
        stream.close()
        client.close()
        return pid, events[-1]

    def test_reuses_one_pipeline_across_independent_clients(self):
        first_pid, first = self.request()
        next_pid, second = self.request()
        self.assertEqual(first_pid, next_pid)
        self.assertEqual(first['result']['calls'], 1)
        self.assertFalse(first['result']['localEngineWarm'])
        self.assertEqual(second['result']['calls'], 2)
        self.assertTrue(second['result']['localEngineWarm'])

    def test_idle_engine_releases_update_lease(self):
        self.request()
        deadline = time.monotonic() + 2
        with (self.root / 'update.lock').open('rb') as lock:
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() > deadline: raise
                    time.sleep(0.01)

    def test_cancel_disconnect_terminates_owned_engine(self):
        self.input.write_bytes(b'block')
        client, stream, _ = self.connect()
        client.sendall((json.dumps(dict(operation='process', input=str(self.input),
            work_root=str(self.work), sha256=base64.b64encode(hashlib.sha256(b'block').digest()).decode())) + '\n').encode())
        self.assertEqual(json.loads(stream.readline())['stage'], 'separation')
        with (self.root / 'update.lock').open('rb') as lock:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stream.close()
        client.close()
        self.assertEqual(self.child.wait(timeout=3), -signal.SIGKILL)

    def test_changed_model_retires_warm_engine(self):
        self.request()
        self.model.write_bytes(b'replacement')
        _, result = self.request()
        self.assertEqual(result, dict(type='error', code='RUNTIME_CONFIG_CHANGED'))
        self.assertEqual(self.child.wait(timeout=3), 0)

    def test_wrong_checksum_fails_without_replay(self):
        _, result = self.request({'sha256': base64.b64encode(bytes(32)).decode()})
        self.assertEqual(result, dict(type='error', code='INPUT_CHECKSUM_MISMATCH'))

    def test_rejects_source_outside_owned_attempt(self):
        _, result = self.request({'input': str(self.model)})
        self.assertEqual(result, dict(type='error', code='INVALID_WORK_ROOT'))

    def test_idle_retire_removes_only_owned_socket(self):
        client, stream, _ = self.connect()
        client.sendall(b'{"operation":"retire"}\n')
        stream.close()
        client.close()
        self.assertEqual(self.child.wait(timeout=3), 0)
        self.assertFalse(self.socket.exists())
        self.assertTrue((self.root / 'engine.lock').exists())


if __name__ == '__main__':
    unittest.main()
