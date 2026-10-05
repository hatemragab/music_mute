import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest import mock

import acquirer


FAKE_CHILD = '''
import json, os, pathlib, subprocess, sys, time
request = json.load(sys.stdin)
root = pathlib.Path(request['scratch'])
mode = request['url']
if mode == 'block':
    (root / 'audio.webm.part').write_bytes(b'partial')
    time.sleep(5)
elif mode == 'helper':
    marker = root.parent / 'unexpected-helper-survived'
    subprocess.Popen([sys.executable, '-c', 'import pathlib,time;time.sleep(.3);pathlib.Path(' + repr(str(marker)) + ').write_text("alive")'])
    time.sleep(5)
elif mode == 'oversized-output':
    sys.stdout.write('x' * 20000)
elif mode == 'failure':
    (root / 'audio.webm.part').write_bytes(b'partial')
    print(json.dumps({'error': 'IMPORT_UPSTREAM_REFUSED'}))
elif mode == 'diagnostic-failure':
    print(json.dumps({'progress': {'phase': 'extraction'}, 'timings_ms': {'extraction_ms': 3}}), flush=True)
    print(json.dumps({'error': 'IMPORT_UPSTREAM_REFUSED', 'diagnostics': {'phase': 'transfer',
        'reason': 'http_forbidden', 'http_status': 403, 'format_id': '250', 'format_count': 3,
        'proxy': 'fixture-password', 'message': 'fixture-password'}, 'timings_ms': {'transfer_ms': 9}}))
elif mode == 'diagnostic-block':
    print(json.dumps({'progress': {'phase': 'token_generation', 'reason': 'fixture-password',
        'proxy': 'fixture-password'}, 'timings_ms': {'extraction_ms': 8}}), flush=True)
    time.sleep(5)
elif mode == 'progress-flood':
    for _ in range(65):
        print(json.dumps({'progress': {'phase': 'extraction'}}), flush=True)
elif mode == 'bad-path':
    print(json.dumps({'filename': '../outside.webm'}))
else:
    (root / 'audio.webm').write_bytes(b'audio')
    print(json.dumps({'filename': 'audio.webm', 'content_type': 'audio/webm',
        'metadata': {'schema_version': 1, 'provider': 'ytdlp', 'site': 'youtube', 'title': 'https://fixture.invalid'},
        'timings_ms': {'extraction_ms': 1, 'token_generation_ms': 0, 'transfer_ms': 1},
        'bytes_downloaded': 5}))
'''


class Cancelled(Exception):
    pass


class AcquisitionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.scratch = self.root / 'request'
        self.scratch.mkdir()
        self.child = self.root / 'child.py'
        self.child.write_text(FAKE_CHILD)
        self.calls = []
        real_popen = subprocess.Popen

        def launch(arguments, **kwargs):
            self.calls.append((arguments, kwargs))
            return real_popen([arguments[0], '-B', str(self.child)], **kwargs)

        self.launch_patch = mock.patch.object(acquirer.subprocess, 'Popen', side_effect=launch)
        self.launch_patch.start()
        self.addCleanup(self.launch_patch.stop)
        self.addCleanup(self.temp.cleanup)

    def acquire(self, mode='success', *, timeout=3, check=lambda: None):
        return acquirer.acquire(
            mode, 100, 30, 'http://fixture-login:fixture-password@gw.dataimpulse.com:10000',
            time.monotonic() + timeout, check, self.scratch,
            'http://127.0.0.1:4416', '/usr/bin/deno',
        )

    def test_success_retains_only_measured_native_file(self):
        result = self.acquire()
        self.assertEqual(result.path, (self.scratch / 'audio.webm').resolve())
        self.assertEqual(result.size, 5)
        self.assertEqual(result.bytes_downloaded, 5)
        self.assertEqual(result.content_type, 'audio/webm')
        self.assertNotIn('title', result.metadata)
        self.assertEqual(result.timings_ms['extraction_ms'], 1)

    def test_proxy_credentials_stay_out_of_process_arguments_and_environment(self):
        with mock.patch.dict(os.environ, {'PRIVATE_OTHER_SECRET': 'sensitive', 'HTTPS_PROXY': 'http://ambient-proxy',
                                          'DENO_DIR': '/app/.cache/deno'}):
            self.acquire()
        arguments, parameters = self.calls[0]
        self.assertNotIn('fixture-password', str(arguments))
        self.assertNotIn('fixture-password', str(parameters['env']))
        self.assertNotIn('PRIVATE_OTHER_SECRET', parameters['env'])
        self.assertNotIn('HTTPS_PROXY', parameters['env'])
        self.assertEqual(parameters['env']['DENO_DIR'], '/app/.cache/deno')
        self.assertTrue(parameters['start_new_session'])
        self.assertEqual(parameters['stderr'], subprocess.DEVNULL)

    def test_failure_is_sanitized_and_removes_partial_file(self):
        with self.assertRaises(acquirer.AcquisitionError) as caught:
            self.acquire('failure')
        self.assertEqual(caught.exception.code, 'IMPORT_UPSTREAM_REFUSED')
        self.assertEqual(caught.exception.status, 502)
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_total_deadline_interrupts_blocked_child_and_cleans_scratch(self):
        started = time.monotonic()
        with self.assertRaises(acquirer.AcquisitionError):
            self.acquire('block', timeout=.15)
        self.assertLess(time.monotonic() - started, .8)
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_failure_preserves_safe_child_phase_status_and_partial_timings(self):
        with self.assertRaises(acquirer.AcquisitionError) as caught:
            self.acquire('diagnostic-failure')
        failure = caught.exception
        self.assertEqual(failure.diagnostics['phase'], 'transfer')
        self.assertEqual(failure.diagnostics['http_status'], 403)
        self.assertEqual(failure.diagnostics['format_count'], 3)
        self.assertEqual(failure.timings_ms, {'extraction_ms': 3, 'transfer_ms': 9})
        self.assertNotIn('fixture-password', json.dumps(failure.diagnostics))
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_hard_timeout_retains_last_phase_before_killing_child(self):
        with self.assertRaises(acquirer.AcquisitionError) as caught:
            self.acquire('diagnostic-block', timeout=.15)
        self.assertEqual(caught.exception.diagnostics['phase'], 'token_generation')
        self.assertEqual(caught.exception.diagnostics['reason'], 'attempt_deadline')
        self.assertTrue(caught.exception.diagnostics['timeout'])
        self.assertTrue(caught.exception.diagnostics['child_killed'])
        self.assertEqual(caught.exception.timings_ms['extraction_ms'], 8)
        self.assertNotIn('fixture-password', json.dumps(caught.exception.diagnostics))

    def test_progress_message_count_is_bounded(self):
        with self.assertRaises(acquirer.AcquisitionError) as caught:
            self.acquire('progress-flood')
        self.assertEqual(caught.exception.diagnostics['reason'], 'child_protocol_invalid')

    def test_deadline_kills_helpers_in_child_process_group(self):
        with self.assertRaises(acquirer.AcquisitionError):
            self.acquire('helper', timeout=.15)
        time.sleep(.35)
        self.assertFalse((self.root / 'unexpected-helper-survived').exists())

    def test_caller_cancellation_propagates_unchanged(self):
        calls = 0

        def check():
            nonlocal calls
            calls += 1
            if calls >= 3:
                raise Cancelled('caller disconnected')

        with self.assertRaises(Cancelled):
            self.acquire('block', check=check)
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_result_output_and_path_are_bounded(self):
        for mode in ('oversized-output', 'bad-path'):
            with self.assertRaises(acquirer.AcquisitionError):
                self.acquire(mode)
            self.assertEqual(list(self.scratch.iterdir()), [])

    def test_nonempty_scratch_rejected_without_deleting_unrelated_file(self):
        existing = self.scratch / 'unrelated.txt'
        existing.write_text('preserve')
        with self.assertRaises(acquirer.AcquisitionError):
            self.acquire()
        self.assertEqual(existing.read_text(), 'preserve')
        self.assertEqual(self.calls, [])

    def test_result_symlink_and_unmeasured_bytes_rejected(self):
        outside = self.root / 'outside.webm'
        outside.write_bytes(b'audio')
        (self.scratch / 'audio.webm').symlink_to(outside)
        raw = json.dumps({'filename': 'audio.webm', 'content_type': 'audio/webm',
                          'metadata': {}, 'timings_ms': {}, 'bytes_downloaded': 5})
        with self.assertRaises(acquirer.AcquisitionError):
            acquirer._result(raw, self.scratch, 100)
        (self.scratch / 'audio.webm').unlink()
        (self.scratch / 'audio.webm').write_bytes(b'audio')
        with self.assertRaises(acquirer.AcquisitionError):
            acquirer._result(raw.replace('"bytes_downloaded": 5', '"bytes_downloaded": 1'), self.scratch, 100)


if __name__ == '__main__':
    unittest.main()
