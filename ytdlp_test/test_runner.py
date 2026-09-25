import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import runner


class RunnerTests(unittest.TestCase):
    def test_normalize_single_item(self):
        for value in ['https://youtu.be/aqz-KE-bpKQ',
                      'https://www.youtube.com/shorts/aqz-KE-bpKQ',
                      'https://music.youtube.com/watch?v=aqz-KE-bpKQ']:
            self.assertEqual(runner.canonical_url(value), 'https://www.youtube.com/watch?v=aqz-KE-bpKQ')

    def test_reject_untrusted_or_collection(self):
        for value in ['https://127.0.0.1/watch?v=aqz-KE-bpKQ',
                      'https://www.youtube.com/watch?v=aqz-KE-bpKQ&list=xxx',
                      'https://user:pass@youtube.com/watch?v=aqz-KE-bpKQ',
                      'file:///tmp/audio', 'https://youtu.be/aqz-KE-bpKQ/extra',
                      'https://youtube.com:443/watch?v=aqz-KE-bpKQ']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                runner.canonical_url(value)

    def test_audio_only_arguments(self):
        args = runner.command('https://youtu.be/aqz-KE-bpKQ', Path('/work/test'))
        self.assertEqual(args[args.index('--format') + 1], 'bestaudio[vcodec=none]')
        self.assertNotIn('-x', args)
        self.assertIn('--no-playlist', args)
        self.assertIn('--no-remote-components', args)

    def test_failure_cleans_and_cools_down(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(runner, 'ROOT', Path(tmp)), \
                patch.object(runner, 'download', side_effect=ValueError('UPSTREAM_ACCESS_REFUSED')):
            with self.assertRaisesRegex(ValueError, 'UPSTREAM_ACCESS_REFUSED'):
                runner.run('https://youtu.be/aqz-KE-bpKQ')
            self.assertEqual(list(Path(tmp).glob('attempt-*')), [])
            with self.assertRaisesRegex(ValueError, 'COOLDOWN'):
                runner.run('https://youtu.be/aqz-KE-bpKQ')

    def test_concurrent_rejection(self):
        import fcntl
        with tempfile.TemporaryDirectory() as tmp, patch.object(runner, 'ROOT', Path(tmp)):
            with (Path(tmp) / '.lock').open('a+') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                with self.assertRaisesRegex(ValueError, 'BUSY'):
                    runner.run('https://youtu.be/aqz-KE-bpKQ')

    def test_interrupt_cleans_partial_audio(self):
        def interrupt(url, directory):
            (directory / 'source.m4a.part').write_bytes(b'partial')
            raise KeyboardInterrupt
        with tempfile.TemporaryDirectory() as tmp, patch.object(runner, 'ROOT', Path(tmp)), \
                patch.object(runner, 'download', side_effect=interrupt):
            with self.assertRaises(KeyboardInterrupt):
                runner.run('https://youtu.be/aqz-KE-bpKQ')
            self.assertEqual(list(Path(tmp).glob('attempt-*')), [])

    def test_timeout_kills_child_group(self):
        from unittest.mock import MagicMock
        child = MagicMock(pid=999)
        child.poll.return_value = None
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(runner.subprocess, 'Popen', return_value=child), \
                patch.object(runner.time, 'monotonic', side_effect=[0, 601]), \
                patch.object(runner.os, 'killpg') as kill:
            with self.assertRaisesRegex(ValueError, 'TIMEOUT'):
                runner.download('https://youtu.be/aqz-KE-bpKQ', Path(tmp))
            kill.assert_called_once_with(999, runner.signal.SIGKILL)
            child.wait.assert_called_once()

    def test_reject_non_audio_probe(self):
        from unittest.mock import MagicMock
        import json
        response = json.dumps({'streams': [{'codec_type': 'video'}]})
        with patch.object(runner, 'checked_output', return_value=response):
            with self.assertRaisesRegex(ValueError, 'NON_AUDIO_TRACK'):
                runner.verify(Path('/does-not-need-to-exist'))

    def test_real_audio_decode(self):
        import shutil
        import subprocess
        if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
            self.skipTest('FFmpeg runtime test runs in container')
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'audio.wav'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                            'sine=frequency=440:duration=0.1', str(path)], check=True)
            result = runner.verify(path)
            self.assertTrue(result['full_decode'])
            self.assertEqual(result['video_tracks'], 0)
            self.assertGreater(result['bytes'], 0)

    def test_expected_media_mismatch_cleans(self):
        for source, measured, error in [
            ({'filesize': 100}, {'bytes': 10}, 'INCOMPLETE_AUDIO'),
            ({'duration': 100}, {'bytes': 10, 'duration_seconds': 50}, 'DURATION_MISMATCH'),
        ]:
            with self.subTest(error=error), tempfile.TemporaryDirectory() as tmp, \
                    patch.object(runner, 'ROOT', Path(tmp)), \
                    patch.object(runner, 'download', return_value=(Path(tmp) / 'audio', source)), \
                    patch.object(runner, 'verify', return_value=measured):
                with self.assertRaisesRegex(ValueError, error):
                    runner.run('https://youtu.be/aqz-KE-bpKQ')
                self.assertEqual(list(Path(tmp).glob('attempt-*')), [])

    def test_error_redaction(self):
        self.assertEqual(runner.classify('secret-url HTTP 403'), 'UPSTREAM_ACCESS_REFUSED')
        self.assertEqual(runner.classify('HTTP 429'), 'UPSTREAM_RATE_LIMIT')


if __name__ == '__main__':
    unittest.main()

class NormalizationTests(unittest.TestCase):
    def test_compatible_audio_is_not_converted(self):
        path = Path('/unused/native.m4a')
        result = {'format_name': 'mov,mp4,m4a,3gp,3g2,mj2', 'audio_codecs': ['aac']}
        with patch.object(runner, 'checked_output') as execute:
            self.assertEqual(runner.normalize(path, result, lambda: False), (path, result))
            execute.assert_not_called()

    def test_native_wav_becomes_compatible_audio_and_source_is_removed(self):
        import shutil
        import subprocess
        if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
            self.skipTest('Requires FFmpeg')
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'source.wav'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                            'sine=frequency=440:duration=0.5', str(path)], check=True)
            output, result = runner.normalize(path, runner.verify(path), lambda: False)
            self.assertFalse(path.exists())
            self.assertTrue(output.exists())
            self.assertEqual(result['audio_codecs'], ['aac'])
            self.assertEqual(result['video_tracks'], 0)
            self.assertTrue(result['full_decode'])
