"""Sample-level comparisons with the shipped legacy trimming algorithm."""

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    import numpy as np
    import soundfile as sf
except ImportError:
    np = sf = None

SEPARATOR = Path(__file__).resolve().parents[1] / "musicmute_worker" / "separation.py"
spec = importlib.util.spec_from_file_location("separator_under_test", SEPARATOR)
separator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(separator)


def legacy(audio, rate, threshold_db=-45, min_silence=0.8, padding=0.2):
    frame = max(1, round(rate * 0.01))
    threshold = 10 ** (threshold_db / 20)
    silent = [
        float(np.sqrt(np.mean(audio[i : i + frame] ** 2, axis=0)).max()) < threshold
        for i in range(0, len(audio), frame)
    ]
    edges = np.diff(np.asarray([False, *silent, False], dtype=np.int8))
    cuts = []
    pad = round(padding * rate)
    for first, last in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)):
        start, end = int(first * frame), min(int(last * frame), len(audio))
        if end - start >= round(min_silence * rate):
            left = start + (pad if start > 0 else 0)
            right = end - (pad if end < len(audio) else 0)
            if right > left:
                cuts.append((left, right))
    keep, cursor = [], 0
    for left, right in cuts:
        if left > cursor:
            keep.append((cursor, left))
        cursor = right
    if cursor < len(audio):
        keep.append((cursor, len(audio)))
    if not keep:
        return audio
    pieces = []
    for start, end in keep:
        piece = audio[start:end].copy()
        fade = min(round(rate * 0.005), len(piece) // 2)
        if fade:
            ramp = np.linspace(0, 1, fade, dtype=np.float32)[:, None]
            if start > 0:
                piece[:fade] *= ramp
            if end < len(audio):
                piece[-fade:] *= ramp[::-1]
        pieces.append(piece)
    return np.concatenate(pieces)


@unittest.skipIf(np is None, "NumPy and soundfile required for sample parity")
class SeparatorTests(unittest.TestCase):
    def test_streamed_pcm_matches_reference_for_audio_boundaries(self):
        rate = 44100
        rng = np.random.default_rng(713)
        audio = (rng.standard_normal((rate * 5 + 37, 2)) * 0.1).astype("float32")
        audio[:rate] = 0
        audio[rate * 2 : rate * 3] = 0
        audio[rate * 4 :] = 0
        asymmetric = np.zeros((rate * 2 + 79, 2), dtype="float32")
        asymmetric[:, 1] = 0.15
        threshold = np.full((rate * 3 + 17, 2), 0.1, dtype="float32")
        threshold[rate : rate * 2] = 10 ** (-45 / 20)
        long_audio = np.full((rate * 13 + 113, 2), 0.1, dtype="float32")
        long_audio[rate * 9 : rate * 12] = 0
        fade_boundary = np.full((rate * 5 + 29, 2), 0.1, dtype="float32")
        fade_boundary[441 * 129 : 441 * 129 + rate * 2] = 0
        quiet_gap = audio.copy()
        quiet_gap[rate * 2 : rate * 3] = np.float32(33 / 32768)
        for name, samples in [
            ("subthreshold gap fades", quiet_gap),
            ("gaps", audio),
            ("RMS chunk boundary", long_audio),
            ("fade across retained write boundary", fade_boundary),
            ("asymmetric", asymmetric),
            ("silent", np.zeros_like(audio)),
            ("threshold", threshold),
            ("short", audio[rate : rate + 111]),
            ("below", threshold * np.float32(0.9999)),
            ("above", threshold * np.float32(1.0001)),
        ]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                source, output, expected = [
                    directory / n for n in ("input.wav", "out.wav", "expected.flac")
                ]
                sf.write(source, samples, rate, subtype="FLOAT")
                sf.write(expected, legacy(samples, rate), rate, subtype="PCM_16")
                separator.trim_vocal_gaps(source, output)
                actual, actual_rate = sf.read(output, dtype="int16", always_2d=True)
                wanted, _ = sf.read(expected, dtype="int16", always_2d=True)
                np.testing.assert_array_equal(actual, wanted)
                self.assertEqual(actual_rate, rate)

    def test_retained_output_never_concatenates_audio(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, target = Path(temporary) / "in.wav", Path(temporary) / "out.wav"
            sf.write(source, np.ones((44100, 2), dtype="float32") * 0.1, 44100)
            with patch.object(
                np, "concatenate", side_effect=AssertionError("full copy")
            ):
                separator.trim_vocal_gaps(source, target)

    def test_prepared_requires_canonical_pcm_and_bypasses_ffmpeg(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for rate, channels, subtype, valid in [
                (44100, 2, "PCM_16", True),
                (48000, 2, "PCM_16", False),
                (44100, 1, "PCM_16", False),
                (44100, 2, "FLOAT", False),
            ]:
                source = directory / "prepared.wav"
                sf.write(source, np.zeros((100, channels)), rate, subtype=subtype)
                with (
                    self.subTest(rate=rate, channels=channels, subtype=subtype),
                    patch.object(
                        separator.subprocess,
                        "run",
                        side_effect=AssertionError("extra decode"),
                    ),
                ):
                    if valid:
                        self.assertEqual(
                            separator.prepare_audio(
                                source, directory, "ffmpeg", prepared=True
                            ),
                            source,
                        )
                    else:
                        with self.assertRaises(ValueError):
                            separator.prepare_audio(
                                source, directory, "ffmpeg", prepared=True
                            )


@unittest.skipIf(
    np is None, "NumPy and soundfile required for local separator integration"
)
class SeparatorIntegrationTests(unittest.TestCase):
    def setUp(self):
        import shutil

        from process_test_support import ProcessTestIsolation

        if not shutil.which("ffmpeg"):
            self.skipTest("FFmpeg required for local encode/decode proof")
        self.enterContext(ProcessTestIsolation())
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.loads = self.directory / "loads.txt"
        self.commands = self.directory / "commands.jsonl"
        (self.directory / "fixture_separator.py").write_text(f"""
from pathlib import Path
import soundfile as sf
class Separator:
    def __init__(self, work_output, model_dir):
        assert Path(model_dir).is_absolute()
        self.output_dir=Path(work_output)
        self.output_dir.mkdir()
        self.onnx_execution_provider=['DmlExecutionProvider']
        self.model_instance=self
        self.last=None
        with Path({str(self.loads)!r}).open('a') as f: f.write('loaded\\n')
    def clear_file_specific_paths(self):
        self.last=None
    def separate(self, source):
        assert self.last is None
        assert not list(self.output_dir.iterdir())
        self.last=source
        audio,rate=sf.read(source)
        output=self.output_dir/'Vocals.flac'
        sf.write(output,audio,rate,subtype='PCM_24')
        return [str(output)]
""")
        self.wrapper = self.directory / "separator-wrapper.py"
        self.wrapper.write_text(f"""
import json, runpy, sys
from pathlib import Path
sys.path.insert(0, {str(self.directory)!r})
module=runpy.run_path({str(SEPARATOR)!r},run_name='test_separator')
from fixture_separator import Separator
def fixture_loader(work_output, model_dir, runtime_path=None):
    return Separator(work_output, model_dir)
module['main'].__globals__['load_separator']=fixture_loader
original=module['subprocess'].run
def record(args, **kwargs):
    with Path({str(self.commands)!r}).open('a') as output:
        output.write(json.dumps(args)+'\\n')
    return original(args, **kwargs)
module['subprocess'].run=record
module['main']()
""")
        self.source = self.directory / "prepared.wav"
        t = np.arange(44100) / 44100
        samples = np.column_stack(
            [np.sin(t * 2 * np.pi * 440) * 0.2, np.cos(t * 2 * np.pi * 600) * 0.1]
        )
        sf.write(self.source, samples, 44100, subtype="PCM_16")

    def test_real_server_loads_model_once_for_two_jobs_and_encodes_only_once_each(self):
        import json

        from musicmute_worker.engine import SeparatorEngine

        engine = SeparatorEngine(
            self.wrapper, self.directory / "state", model_dir=self.directory / "models"
        )
        self.addCleanup(engine.close)
        for index in range(2):
            output = self.directory / f"output-{index}"
            timings = engine.run(self.source, output, timeout=15, check=lambda: None)
            self.assertEqual(
                set(timings),
                {"model_load", "engine_startup", "separation", "trim", "encode"},
            )
            self.assertEqual(len(list(output.glob("*.mp3"))), 1)
            import subprocess

            result = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "stream=codec_name,sample_rate,channels,bit_rate",
                    "-of",
                    "json",
                    str(next(output.glob("*.mp3"))),
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            stream = json.loads(result.stdout)["streams"][0]
            self.assertEqual(
                (
                    stream["codec_name"],
                    stream["sample_rate"],
                    stream["channels"],
                    stream["bit_rate"],
                ),
                ("mp3", "44100", 2, "192000"),
            )
        self.assertEqual(self.loads.read_text().splitlines(), ["loaded"])
        commands = [json.loads(line) for line in self.commands.read_text().splitlines()]
        self.assertEqual(len(commands), 2)
        self.assertTrue(all("libmp3lame" in command for command in commands))
        self.assertTrue(
            all(
                command[command.index("-i") + 1].endswith("_trimmed.wav")
                for command in commands
            )
        )

    def test_standalone_cli_preserves_decode_and_prepared_skips_it(self):
        import json
        import subprocess
        import sys

        for prepared in (False, True):
            command = [
                sys.executable,
                str(self.wrapper),
                str(self.source),
                "--model-dir",
                str(self.directory / "models"),
                "--output_dir",
                str(self.directory / str(prepared)),
            ]
            if prepared:
                command.append("--prepared")
            subprocess.run(command, check=True, capture_output=True)
        commands = [json.loads(line) for line in self.commands.read_text().splitlines()]
        self.assertEqual(len(commands), 3)
        self.assertIn("pcm_s16le", commands[0])
        self.assertTrue(all("libmp3lame" in command for command in commands[1:]))

    def test_server_rejects_oversized_or_invalid_request_with_sanitized_code(self):
        import json
        import sys
        import time
        from uuid import uuid4

        from musicmute_worker.processes import ContainedProcess

        for raw in (
            b"x" * 20000,
            json.dumps(
                {
                    "version": 1,
                    "id": "bad-id",
                    "input": str(self.source),
                    "output_dir": str(self.directory / "out"),
                }
            ).encode(),
        ):
            with self.subTest(size=len(raw)):
                state = self.directory / uuid4().hex
                state.mkdir()
                process = ContainedProcess(
                    [
                        sys.executable,
                        str(self.wrapper),
                        "--serve",
                        str(state),
                        "--model-dir",
                        str(self.directory / "models"),
                        "--session-id",
                        uuid4().hex,
                    ],
                    cwd=self.directory,
                    slot="engine",
                )
                try:
                    deadline = time.monotonic() + 10
                    while not (state / "ready.json").exists():
                        self.assertLess(time.monotonic(), deadline)
                        time.sleep(0.01)
                    (state / "request.tmp").write_bytes(raw)
                    (state / "request.tmp").replace(state / "request.json")
                    while not (state / "response.json").exists():
                        self.assertLess(time.monotonic(), deadline)
                        time.sleep(0.01)
                    response = json.loads((state / "response.json").read_text())
                    self.assertEqual(
                        response,
                        {
                            "version": 1,
                            "id": None,
                            "status": "error",
                            "error": "INVALID_REQUEST",
                        },
                    )
                    # INVALID_REQUEST is terminal: observe the promised server
                    # exit before cleanup. Abrupt-stop races belong to process tests.
                    while process.poll() is None:
                        self.assertLess(time.monotonic(), deadline)
                        time.sleep(0.01)
                finally:
                    process.close()


class ProtocolRequestTests(unittest.TestCase):
    def test_windows_request_open_retries_transient_sharing_error(self):
        import io
        from types import SimpleNamespace
        from unittest.mock import Mock

        request = Mock()
        request.open.side_effect = [
            PermissionError("sharing race"),
            io.BytesIO(b'{"version":1}'),
        ]
        with patch.object(separator, "os", SimpleNamespace(name="nt")):
            self.assertEqual(separator._read_request(request), b'{"version":1}')
        self.assertEqual(request.open.call_count, 2)

    def test_permanent_windows_permission_error_is_bounded(self):
        from types import SimpleNamespace
        from unittest.mock import Mock

        request = Mock()
        request.open.side_effect = PermissionError("denied")
        with (
            patch.object(separator, "os", SimpleNamespace(name="nt")),
            patch.object(separator, "_IPC_RETRY_SECONDS", 0.01),
            self.assertRaises(PermissionError),
        ):
            separator._read_request(request)
        self.assertLessEqual(request.open.call_count, 3)

    def test_posix_permission_error_is_not_retried(self):
        from types import SimpleNamespace
        from unittest.mock import Mock

        request = Mock()
        request.open.side_effect = PermissionError("denied")
        with (
            patch.object(separator, "os", SimpleNamespace(name="posix")),
            self.assertRaises(PermissionError),
        ):
            separator._read_request(request)
        request.open.assert_called_once()


class SeparationTelemetryTests(unittest.TestCase):
    def test_phase_records_only_separate_call_after_reset_before_trim(self):
        import json

        now = [0.0]

        class Model:
            def clear_file_specific_paths(self):
                now[0] = 10.0

        class FakeSeparator:
            model_instance = Model()

            def separate(self, _source):
                now[0] = 14.0
                return []

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            output = root / "run"
            with patch.object(separator.time, "monotonic", side_effect=lambda: now[0]):
                with self.assertRaisesRegex(ValueError, "no vocal"):
                    separator.process_audio(
                        FakeSeparator(),
                        root / "source.wav",
                        output,
                        root / "stems",
                        root,
                        "ffmpeg",
                    )
            phase = json.loads((output / ".execution.json").read_text())
            self.assertEqual(phase["runId"], "run")
            self.assertEqual(phase["phase"], "separated")
            self.assertEqual(phase["seconds"], 4.0)
            self.assertTrue(phase["completed"])
            self.assertEqual(phase["startedMonotonic"], 10.0)
            self.assertNotIn("source", phase)

    def test_failed_separator_phase_never_claims_completed_separation(self):
        import json

        class FailedSeparator:
            def separate(self, _source):
                raise RuntimeError("synthetic separator failure")

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with self.assertRaises(RuntimeError):
                separator.process_audio(
                    FailedSeparator(),
                    root / "source.wav",
                    root / "run",
                    root / "stems",
                    root,
                    "ffmpeg",
                )
            phase = json.loads((root / "run" / ".execution.json").read_text())
            self.assertEqual(phase["phase"], "separated")
            self.assertFalse(phase["completed"])
            self.assertGreaterEqual(phase["seconds"], 0)
