"""Exercise the request actually passed to the existing shared engine."""
import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parent / "worker/engine"))
spec = importlib.util.spec_from_file_location("local_pipeline", ROOT / "engine/local_pipeline.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class LocalRequestTests(unittest.TestCase):
    def test_normal_local_model_resolution_trusts_installed_contents(self):
        from unittest.mock import patch
        from musicmute_engine.artifacts import model_path, ModelArtifactError
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = model_path(root)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"installed fixture - no model hash required")
            with patch("musicmute_engine.pipeline.verified_cached_model", side_effect=AssertionError("unexpected audit")):
                pipeline = bridge.local_pipeline()
                self.assertEqual(pipeline._verified_model(root), path.resolve())
            path.unlink()
            with self.assertRaises(ModelArtifactError):
                bridge.installed_model(path)

    def test_untrimmed_revision_six_preserves_timeline(self):
        from musicmute_engine.recipes import validate_recipe_snapshot

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            attempt = root / str(uuid.uuid4())
            attempt.mkdir()
            source = attempt / "source.m4a"
            source.write_bytes(b"local audio identity fixture")
            tool = root / "tool"
            tool.touch()
            args = argparse.Namespace(input=source, work_root=attempt, model_cache=root, ffmpeg=tool, ffprobe=tool)
            payload = bridge.process_payload(args)
            recipe = validate_recipe_snapshot(payload["recipe"])
            self.assertFalse(recipe["trimEnabled"])
            self.assertIsNone(recipe["trimProfileId"])
            self.assertNotIn("trim-vocal-wav-v1", recipe["stepIds"])
            self.assertEqual(payload["provider"], "mps")
            self.assertEqual(payload["input"]["bytes"], len(source.read_bytes()))
            self.assertEqual(payload["attemptId"], attempt.name)

    def test_source_outside_attempt_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            attempt = root / str(uuid.uuid4())
            attempt.mkdir()
            source = root / "source.m4a"
            source.write_bytes(b"foreign")
            args = argparse.Namespace(input=source, work_root=attempt)
            with self.assertRaises(ValueError):
                bridge.process_payload(args)

    def run_stdin_tool(self, arguments, payload):
        return subprocess.run([
            sys.executable, "-I", "-B", str(ROOT / "engine/local_pipeline.py"),
            "--tool", sys.executable, "--", "-I", "-B", "-c",
            "import sys; sys.stdout.buffer.write(sys.stdin.buffer.read())",
            *arguments,
        ], input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, check=False)

    def test_metadata_replay_forwards_exact_stdin_bytes(self):
        payload = b'{"id":"public-id","formats":[{"format_id":"140"}]}\n'
        result = self.run_stdin_tool(["--load-info-json", "-"], payload)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, payload)
        self.assertEqual(result.stderr, b"")

    def test_normal_tool_receives_eof_despite_supplied_stdin(self):
        result = self.run_stdin_tool(["--dump-single-json"], b"private caller input")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"")

    def test_malformed_metadata_replay_does_not_receive_stdin(self):
        for arguments in (
            ["--load-info-json"],
            ["--load-info-json", "metadata.json"],
            ["--load-info-json", "--quiet", "-"],
            ["--load-info-json=-"],
            ["--load-info-json", "-", "--load-info-json", "metadata.json"],
            ["--load-info-json", "-", "--load-info-json=metadata.json"],
        ):
            with self.subTest(arguments=arguments):
                result = self.run_stdin_tool(arguments, b"private caller input")
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b"")
                self.assertEqual(result.stderr, b"")

    @unittest.skipUnless(os.name == "posix" and shutil.which("node"), "requires desktop Node/POSIX")
    def test_guardian_terminates_tools_after_abrupt_parent_death(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            started = root / "started"
            finished = root / "finished"
            command = "require('node:fs').writeFileSync(process.argv[1],'started');setTimeout(()=>require('node:fs').writeFileSync(process.argv[2],'bad'),1000)"
            args = ["-I", "-B", str(ROOT / "engine/local_pipeline.py"), "--tool", shutil.which("node"), "--", "-e", command, str(started), str(finished)]
            parent = subprocess.Popen([
                shutil.which("node"), "-e",
                "const {spawn}=require('node:child_process');spawn(process.argv[1],JSON.parse(process.argv[2]),{detached:true,stdio:'ignore'});setInterval(()=>{},100)",
                sys.executable, json.dumps(args),
            ], env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")})
            try:
                deadline = time.monotonic() + 4
                while not started.exists() and time.monotonic() < deadline:
                    time.sleep(0.025)
                self.assertTrue(started.exists(), "fixture tool did not start")
                parent.kill()
                parent.wait(timeout=2)
                time.sleep(1.2)
                self.assertFalse(finished.exists(), "orphaned tool continued after host death")
            finally:
                if parent.poll() is None:
                    parent.kill()
                    parent.wait(timeout=2)


if __name__ == "__main__":
    unittest.main()
