import base64
import io
import json
import tempfile
import threading
import unittest
import socket
import urllib.error
import urllib.request
from unittest.mock import patch

from service import Failure, Handler, Provider, PublicTLS, Server, metadata, select_format, source_url, source_site, storage_url

FORMAT = {'format_id': '140', 'ext': 'm4a', 'acodec': 'mp4a.40.2', 'vcodec': 'none',
          'protocol': 'https', 'audio_channels': 2, 'abr': 129.4, 'asr': 44100,
          'filesize': 1024, 'url': 'https://secret.invalid/?Signature=private',
          'http_headers': {'Authorization': 'secret'}}


class ContractTests(unittest.TestCase):
    def test_public_item_platforms_and_metadata(self):
        for site, url in [
            ('instagram', 'https://www.instagram.com/reel/Example/?igsh=secret'),
            ('tiktok', 'https://www.tiktok.com/@creator/video/123'),
            ('tiktok', 'https://vm.tiktok.com/Example/'),
            ('vimeo', 'https://vimeo.com/123456'),
            ('vimeo', 'https://player.vimeo.com/video/123456'),
            ('soundcloud', 'https://soundcloud.com/artist/track'),
            ('facebook', 'https://www.facebook.com/reel/123456/'),
            ('facebook', 'https://www.facebook.com/watch/?v=123456'),
            ('facebook', 'https://www.facebook.com/share/r/Example/'),
            ('bandcamp', 'https://artist.bandcamp.com/track/example'),
        ]:
            with self.subTest(site=site, url=url):
                canonical = source_url(url)
                self.assertEqual(source_site(canonical), site)
                self.assertEqual(metadata(FORMAT, site)['site'], site)
                self.assertNotIn('secret', canonical)

    def test_platform_allowlist_rejects_profiles_and_unsafe_urls(self):
        for url in ['https://instagram.com/creator/', 'https://tiktok.com/@creator',
                    'https://vimeo.com/showcase/123', 'https://facebook.com/groups/123',
                    'https://soundcloud.com/artist/sets/album', 'https://instagram.com.evil.test/reel/Example',
                    'https://evil.test/reel/Example', 'https://instagram.com:443/reel/Example',
                    'https://user@instagram.com/reel/Example', 'https://vimeo.com/123#private',
                    'https://facebook.com/watch?v=123&v=456']:
            with self.subTest(url=url), self.assertRaises(Failure):
                source_url(url)

    def test_provider_managed_segmented_audio_and_he_aac(self):
        for change in [{'protocol': 'm3u8_native'}, {'protocol': 'http_dash_segments'},
                       {'acodec': 'mp4a.40.5'}]:
            self.assertEqual(select_format([{**FORMAT, **change}], 2048), {**FORMAT, **change})

    def test_rejection_counts_are_safe_and_actionable(self):
        rejected = {}
        with self.assertRaises(Failure) as error:
            select_format([{**FORMAT, 'vcodec': 'h264'}, {**FORMAT, 'abr': 256},
                           {**FORMAT, 'protocol': 'secret'}, {**FORMAT, 'has_drm': True}], 2048, rejected)
        self.assertEqual(rejected, {'not_separate_audio': 1, 'bitrate_limit': 1,
                                    'unsupported_protocol': 1, 'drm': 1})
        self.assertIn('No eligible separate audio', error.exception.reason)
        self.assertNotIn('secret', json.dumps(rejected))

    def test_steps_explain_progress_without_raw_provider_data(self):
        events = []
        provider = Provider('Basic synthetic', lambda: None, log=lambda **e: events.append(e))
        provider.request = unittest.mock.Mock(side_effect=[
            [FORMAT], {'task_id': '00000000-0000-4000-8000-000000000001'},
            {'status': 'failed', 'error': 'secret https://private.test/?token=hidden'},
        ])
        with self.assertRaises(Failure) as error:
            provider.acquire('https://instagram.com/reel/Example', 2048, io.BytesIO())
        self.assertIn('task failed', error.exception.reason)
        self.assertEqual([e['stage'] for e in events],
                         ['formats', 'formats', 'task-create', 'task-status', 'task-status'])
        self.assertTrue(all(e['message'] for e in events))
        self.assertEqual(events[-1]['selected_format']['site'], 'instagram')
        serialized = json.dumps(events)
        for sensitive in ['secret', 'private.test', 'hidden', 'Authorization', 'synthetic']:
            self.assertNotIn(sensitive, serialized)

    def provider_with_responses(self, responses):
        calls = []
        replies = iter(responses)
        class Connection:
            def __init__(self, *args, **kwargs):
                pass
            def request(self, method, path, body, headers):
                calls.append(method)
            def getresponse(self):
                value = next(replies)
                if isinstance(value, Exception):
                    raise value
                status, payload = value
                response = unittest.mock.Mock(status=status)
                response.read1 = io.BytesIO(json.dumps(payload).encode()).read
                return response
            def close(self):
                pass
        return Provider('Basic synthetic', lambda: None, Connection), calls

    def test_get_transient_errors_are_bounded(self):
        for failure in [(503, {}), (502, {}), TimeoutError(), ConnectionResetError()]:
            with self.subTest(failure=type(failure).__name__), patch('service.time.sleep'):
                provider, calls = self.provider_with_responses([failure, (200, [FORMAT])])
                self.assertEqual(provider.request('/api/formats'), [FORMAT])
                self.assertEqual(calls, ['GET', 'GET'])
                self.assertEqual(provider.read_retries, 1)
        provider, calls = self.provider_with_responses([(503, {})] * 3)
        with patch('service.time.sleep'), self.assertRaises(Failure):
            provider.request('/api/status/fixture')
        self.assertEqual(len(calls), 3)

    def test_post_and_permanent_get_failures_are_never_retried(self):
        for method in ['GET', 'POST']:
            for status in ([401, 403, 404, 429] if method == 'GET' else [403, 429, 500, 502, 503, 504]):
                with self.subTest(method=method, status=status):
                    provider, calls = self.provider_with_responses([(status, {'secret': 'must not log'})])
                    with self.assertRaises(Failure):
                        provider.request('/api/download', {} if method == 'POST' else None)
                    self.assertEqual(calls, [method])
                    self.assertEqual(provider.diagnostics()['upstream_http_status'], status)
                    self.assertNotIn('secret', json.dumps(provider.diagnostics()))
        provider, calls = self.provider_with_responses([TimeoutError()])
        with self.assertRaises(Failure):
            provider.request('/api/download', {})
        self.assertEqual(calls, ['POST'])

    def test_retry_sleep_checks_cancellation(self):
        provider, calls = self.provider_with_responses([(503, {})])
        checks = iter([None, ConnectionAbortedError()])
        def check():
            value = next(checks)
            if value:
                raise value
        provider.check = check
        with patch('service.time.sleep'), self.assertRaises(ConnectionAbortedError):
            provider.request('/api/formats')
        self.assertEqual(calls, ['GET'])

    def test_formats_recheck_and_task_failure_diagnostics(self):
        provider = Provider('Basic synthetic', lambda: None)
        calls = []
        replies = iter([[], [FORMAT], {'task_id': '00000000-0000-4000-8000-000000000001'},
                        {'status': 'failed', 'error': 'secret URL'}])
        def request(path, body=None):
            calls.append((path, body))
            return next(replies)
        provider.request = request
        with patch('service.time.sleep'), self.assertRaisesRegex(Failure, 'IMPORT_SOURCE_UNAVAILABLE'):
            provider.acquire('https://youtu.be/aqz-KE-bpKQ', 2048, io.BytesIO())
        self.assertEqual(len([c for c in calls if '/formats?' in c[0]]), 2)
        self.assertEqual(len([c for c in calls if c[1] is not None]), 1)
        self.assertEqual(provider.diagnostics()['stage'], 'task-status')
        self.assertEqual(provider.diagnostics()['task_status'], 'failed')
        self.assertNotIn('secret', json.dumps(provider.diagnostics()))

    def test_unsupported_formats_stop_before_submission(self):
        for formats in [[], [{**FORMAT, 'vcodec': 'h264'}], [{**FORMAT, 'has_drm': True}]]:
            provider = Provider('Basic synthetic', lambda: None)
            provider.request = unittest.mock.Mock(return_value=formats)
            with patch('service.time.sleep'), self.assertRaisesRegex(Failure, 'IMPORT_UNSUPPORTED_AUDIO_SOURCE'):
                provider.acquire('https://youtu.be/aqz-KE-bpKQ', 2048, io.BytesIO())
            self.assertEqual(provider.request.call_count, 2)
            self.assertTrue(all('/formats?' in call.args[0] for call in provider.request.call_args_list))

    def test_oversized_or_malformed_formats_are_not_retried(self):
        for formats in [[FORMAT], {'formats': []}]:
            provider = Provider('Basic synthetic', lambda: None)
            provider.request = unittest.mock.Mock(return_value=formats)
            with self.assertRaises(Failure):
                provider.acquire('https://youtu.be/aqz-KE-bpKQ', 100, io.BytesIO())
            provider.request.assert_called_once()

    def test_operation_retry_budget(self):
        provider, calls = self.provider_with_responses([(503, {}), (200, {})] * 4 + [(503, {})])
        with patch('service.time.sleep'):
            for _ in range(4):
                provider.request('/api/status/fixture')
            with self.assertRaises(Failure):
                provider.request('/api/status/fixture')
        self.assertEqual(len(calls), 9)
        self.assertEqual(provider.read_retries, 4)

    def test_unknown_task_status_is_sanitized_and_does_not_resubmit(self):
        provider = Provider('Basic synthetic', lambda: None)
        provider.request = unittest.mock.Mock(side_effect=[
            [FORMAT], {'task_id': '00000000-0000-4000-8000-000000000001'},
            *[{'status': 'private url secret'} for _ in range(31)],
        ])
        with patch('service.time.sleep'), self.assertRaisesRegex(Failure, 'IMPORT_DEPENDENCY_FAILED'):
            provider.acquire('https://youtu.be/aqz-KE-bpKQ', 2048, io.BytesIO())
        self.assertEqual(provider.request.call_count, 33)
        self.assertEqual(provider.read_retries, 0)
        self.assertEqual(provider.unknown_polls, 31)
        self.assertEqual(provider.diagnostics()['task_status'], 'unknown')
        self.assertNotIn('secret', json.dumps(provider.diagnostics()))

    def test_fresh_task_404_retry_budget_expires_without_resubmission(self):
        provider = Provider('Basic synthetic', lambda: None)
        provider.request = unittest.mock.Mock(side_effect=[
            [FORMAT], {'task_id': '00000000-0000-4000-8000-000000000001'},
            *[Failure('IMPORT_SOURCE_UNAVAILABLE', 422) for _ in range(5)],
        ])
        with patch('service.time.sleep'), self.assertRaises(Failure):
            provider.acquire('https://youtu.be/aqz-KE-bpKQ', 2048, io.BytesIO())
        self.assertEqual(provider.request.call_count, 7)
        self.assertEqual(provider.read_retries, 4)

    def test_unknown_status_shapes_recover_to_terminal_failure_without_resubmission(self):
        for status, shape in [({}, 'missing'), ({'status': None}, 'invalid_type'),
                              ({'status': []}, 'invalid_type'),
                              ({'status': 'unknown'}, 'literal_unknown'),
                              ({'status': 'private secret'}, 'string')]:
            events = []
            provider = Provider('Basic synthetic', lambda: None, log=lambda **e: events.append(e))
            provider.request = unittest.mock.Mock(side_effect=[
                [FORMAT], {'task_id': '00000000-0000-4000-8000-000000000001'},
                status, {'status': 'failed'},
            ])
            with self.subTest(shape=shape), patch('service.time.sleep'), self.assertRaisesRegex(Failure, 'IMPORT_SOURCE_UNAVAILABLE'):
                provider.acquire('https://youtu.be/aqz-KE-bpKQ', 2048, io.BytesIO())
            self.assertEqual(provider.read_retries, 0)
            self.assertEqual(provider.unknown_polls, 1)
            self.assertEqual(provider.request.call_count, 4)
            self.assertTrue(any(e.get('task_status_shape') == shape for e in events))
            self.assertNotIn('secret', json.dumps(events))

    def test_unknown_status_recheck_obeys_cancellation(self):
        provider = Provider('Basic synthetic', lambda: None)
        provider.request = unittest.mock.Mock(side_effect=[
            [FORMAT], {'task_id': '00000000-0000-4000-8000-000000000001'},
            {'status': 'unknown'},
        ])
        provider.check = unittest.mock.Mock(side_effect=[None, ConnectionAbortedError()])
        with self.assertRaises(ConnectionAbortedError):
            provider.acquire('https://youtu.be/aqz-KE-bpKQ', 2048, io.BytesIO())
        self.assertEqual(provider.request.call_count, 3)

    def test_unknown_status_wall_clock_window_is_bounded(self):
        provider = Provider('Basic synthetic', lambda: None)
        provider.request = unittest.mock.Mock(side_effect=[
            [FORMAT], {'task_id': '00000000-0000-4000-8000-000000000001'},
            {'status': 'unknown'}, {'status': 'unknown'},
        ])
        with patch('service.time.monotonic', side_effect=[0, 0, 0, 61]), patch('service.time.sleep'), self.assertRaises(Failure):
            provider.acquire('https://youtu.be/aqz-KE-bpKQ', 2048, io.BytesIO())
        self.assertEqual(provider.request.call_count, 4)
        self.assertEqual(provider.read_retries, 0)

    def test_failed_task_never_submits_a_paid_fallback_format(self):
        alternatives = [FORMAT,
                        {**FORMAT, 'format_id': 'audio-mp3', 'ext': 'mp3', 'acodec': 'mp3'},
                        {**FORMAT, 'format_id': '251', 'ext': 'webm', 'acodec': 'opus'}]
        for state in ['failed', 'error', 'cancelled', 'canceled']:
            provider = Provider('Basic synthetic', lambda: None)
            provider.request = unittest.mock.Mock(side_effect=[
                alternatives, {'task_id': '00000000-0000-4000-8000-000000000001'},
                {'status': state},
            ])
            with self.subTest(state=state), self.assertRaises(Failure):
                provider.acquire('https://youtu.be/aqz-KE-bpKQ', 2048, io.BytesIO())
            posts = [call for call in provider.request.call_args_list if len(call.args) > 1]
            self.assertEqual(len(posts), 1)
            self.assertEqual(posts[0].args[1]['format_id'], '251')
            self.assertEqual(provider.read_retries, 0)

    def test_delivery_failure_never_reacquires_or_retries_media(self):
        for status in [403, 429, 503]:
            response = unittest.mock.Mock(status=status)
            connection = unittest.mock.Mock()
            connection.getresponse.return_value = response
            provider = Provider('Basic synthetic', lambda: None, unittest.mock.Mock(return_value=connection))
            provider.request = unittest.mock.Mock(side_effect=[
                [FORMAT], {'task_id': '00000000-0000-4000-8000-000000000001'},
                {'status': 'completed'}, {'download_url': 'https://s3.fr-par.scw.cloud/synthetic'},
            ])
            with self.subTest(status=status), self.assertRaises(Failure):
                provider.acquire('https://youtu.be/aqz-KE-bpKQ', 2048, io.BytesIO())
            self.assertEqual(len([call for call in provider.request.call_args_list if len(call.args) > 1]), 1)
            connection.request.assert_called_once()
            connection.close.assert_called_once()

    def test_private_dns_rejected_before_connect(self):
        for address in ['127.0.0.1', '169.254.169.254', '10.0.0.1', '::1', '::ffff:8.8.8.8']:
            with self.subTest(address=address), patch('service.socket.getaddrinfo', return_value=[
                    (socket.AF_INET, socket.SOCK_STREAM, 6, '', (address, 443))]), \
                    patch('service.socket.socket') as connection:
                with self.assertRaises(Failure):
                    PublicTLS('storage.test', 443, timeout=1).connect()
                connection.assert_not_called()

    def test_sources(self):
        for value in ['https://youtu.be/aqz-KE-bpKQ', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
                      'https://youtube.com/shorts/aqz-KE-bpKQ']:
            self.assertEqual(source_url(value), 'https://www.youtube.com/watch?v=aqz-KE-bpKQ')
        for value in ['http://youtube.com/watch?v=aqz-KE-bpKQ', 'https://127.0.0.1/',
                      'https://youtube.com:443/watch?v=aqz-KE-bpKQ',
                      'https://youtube.com/watch?v=aqz-KE-bpKQ&list=test',
                      'https://user@youtube.com/watch?v=aqz-KE-bpKQ', None]:
            with self.subTest(value=value), self.assertRaises(Failure):
                source_url(value)

    def test_storage_fail_closed(self):
        self.assertEqual(storage_url('http://s3.fr-par.scw.cloud/bucket/file?x=1'),
                         'https://s3.fr-par.scw.cloud/bucket/file?x=1')
        for value in ['https://127.0.0.1/', 'https://s3.fr-par.scw.cloud.evil.com/',
                      'https://user@s3.fr-par.scw.cloud/a', 'https://s3.fr-par.scw.cloud:443/a',
                      '/relative', None]:
            with self.subTest(value=value), self.assertRaises(Failure):
                storage_url(value)

    def test_only_native_audio(self):
        self.assertEqual(select_format([FORMAT], 2048), FORMAT)
        for change in [{'vcodec': 'h264'}, {'acodec': 'none'}, {'has_drm': True},
                       {'audio_channels': 6}, {'abr': float('nan')}, {'protocol': 'm3u8'},
                       {'format_id': '../secret'}]:
            with self.subTest(change=change), self.assertRaises(Failure):
                select_format([{**FORMAT, **change}], 2048)
        with self.assertRaisesRegex(Failure, 'IMPORT_TOO_LARGE'):
            select_format([FORMAT], 100)

    def test_metadata_is_allowlisted(self):
        result = metadata(FORMAT)
        self.assertEqual(result['sample_rate_hz'], 44100)
        self.assertNotIn('url', result)
        self.assertNotIn('http_headers', result)
        self.assertNotIn('secret', json.dumps(result))

    def test_missing_140_selects_an_available_alternative(self):
        for alternative in [
            {**FORMAT, 'format_id': '251', 'ext': 'webm', 'acodec': 'opus'},
            {**FORMAT, 'format_id': 'audio-mp3', 'ext': 'mp3', 'acodec': 'mp3'},
            {**FORMAT, 'format_id': '140-1'},
        ]:
            with self.subTest(format_id=alternative['format_id']):
                self.assertEqual(select_format([alternative], 2048), alternative)

    def test_ineligible_preferred_format_does_not_block_alternative(self):
        alternative = {**FORMAT, 'format_id': '250', 'ext': 'webm', 'acodec': 'opus', 'abr': 70}
        for change in [{'filesize': 99999}, {'abr': 256}, {'has_drm': True}, {'vcodec': 'h264'}]:
            with self.subTest(change=change):
                self.assertEqual(select_format([{**FORMAT, **change}, alternative], 2048), alternative)

    def test_missing_optional_metadata_can_continue_without_inventing_values(self):
        for fields in [('abr',), ('audio_channels',), ('abr', 'audio_channels')]:
            for explicit_null in [False, True]:
                candidate = {**FORMAT, 'format_id': '251', 'ext': 'webm', 'acodec': 'opus'}
                for field in fields:
                    if explicit_null:
                        candidate[field] = None
                    else:
                        del candidate[field]
                with self.subTest(fields=fields, null=explicit_null):
                    self.assertEqual(select_format([candidate], 2048), candidate)
                    extra = metadata(candidate)
                    if 'abr' in fields:
                        self.assertNotIn('bitrate_kbps', extra)
                    if 'audio_channels' in fields:
                        self.assertNotIn('audio_channels', extra)

    def test_complete_metadata_is_preferred_over_incomplete_aac(self):
        incomplete = {**FORMAT, 'abr': None}
        complete = {**FORMAT, 'format_id': '250', 'ext': 'webm', 'acodec': 'opus', 'abr': 70}
        self.assertEqual(select_format([incomplete, complete], 2048), complete)
        self.assertEqual(select_format([FORMAT, complete], 2048), complete)

    def test_preference_webm_then_mp3_then_m4a(self):
        webm = {**FORMAT, 'format_id': 'opus-audio', 'ext': 'webm', 'acodec': 'opus', 'abr': None}
        mp3 = {**FORMAT, 'format_id': 'mp3-audio', 'ext': 'mp3', 'acodec': 'mp3'}
        self.assertEqual(select_format([FORMAT, mp3, webm], 2048), webm)
        self.assertEqual(select_format([FORMAT, mp3], 2048), mp3)
        self.assertEqual(select_format([FORMAT], 2048), FORMAT)
        for change in [{'vcodec': 'h264'}, {'has_drm': True}, {'abr': 200}, {'filesize': 5000}]:
            self.assertEqual(select_format([FORMAT, mp3, {**webm, **change}], 2048), mp3)

    def test_invalid_optional_metadata_is_not_treated_as_missing(self):
        for change in [{'abr': 0}, {'abr': -1}, {'abr': float('inf')}, {'abr': '128'},
                       {'abr': True}, {'audio_channels': 0}, {'audio_channels': '2'},
                       {'audio_channels': True}, {'audio_channels': 6}]:
            with self.subTest(change=change), self.assertRaises(Failure):
                select_format([{**FORMAT, **change}], 2048)

    def test_fallback_acquisition_completes_with_one_post(self):
        for missing_metadata in [False, True]:
            alternative = {**FORMAT, 'format_id': '251', 'ext': 'webm', 'acodec': 'opus'}
            if missing_metadata:
                alternative.pop('abr')
                alternative.pop('audio_channels')
            response = unittest.mock.Mock(status=200)
            response.getheader.side_effect = lambda name, default=None: '5' if name == 'Content-Length' else default
            response.read1 = io.BytesIO(b'audio').read
            connection = unittest.mock.Mock()
            connection.getresponse.return_value = response
            provider = Provider('Basic synthetic', lambda: None, unittest.mock.Mock(return_value=connection))
            provider.request = unittest.mock.Mock(side_effect=[
                [alternative], {'task_id': '00000000-0000-4000-8000-000000000001'},
                {'status': 'completed'}, {'download_url': 'https://s3.fr-par.scw.cloud/synthetic'},
            ])
            output = io.BytesIO()
            size, extra = provider.acquire('https://youtu.be/aqz-KE-bpKQ', 2048, output)
            self.assertEqual(size, 5)
            self.assertEqual(output.getvalue(), b'audio')
            self.assertEqual(extra['format_id'], '251')
            posts = [call for call in provider.request.call_args_list if len(call.args) > 1]
            self.assertEqual(len(posts), 1)
            self.assertEqual(posts[0].args, ('/api/download', {
                'url': 'https://youtu.be/aqz-KE-bpKQ', 'format_id': '251'}))

    def test_provider_flow_waits_for_completed(self):
        calls, connections = [], []
        class Response:
            status = 200
            def __init__(self):
                self.data = io.BytesIO(b'audio')
            def getheader(self, name, default=None):
                return '5' if name == 'Content-Length' else default
            def read1(self, n):
                return self.data.read(n)
        class Connection:
            def __init__(self, *args, **kwargs):
                connections.append(args)
            def request(self, method, path, headers):
                self.assert_no_auth = 'Authorization' not in headers
                if not self.assert_no_auth:
                    raise AssertionError('Credential forwarded to storage')
            def getresponse(self):
                return Response()
            def close(self):
                pass
        provider = Provider('Basic synthetic', lambda: None, Connection)
        replies = iter([[FORMAT], {'task_id': '00000000-0000-4000-8000-000000000001'},
                        *[{'status': 'unknown'} for _ in range(8)], {'status': 'processing', 'progress': 100},
                        {'status': 'completed'},
                        {'download_url': 'http://s3.fr-par.scw.cloud/bucket/file'}])
        def request(path, body=None):
            calls.append((path, body))
            return next(replies)
        provider.request = request
        with patch('service.time.sleep'):
            out = io.BytesIO()
            size, extra = provider.acquire('https://www.youtube.com/watch?v=aqz-KE-bpKQ', 2048, out)
        self.assertEqual(size, 5)
        self.assertEqual(out.getvalue(), b'audio')
        self.assertEqual(len([c for c in calls if c[1] is not None]), 1)
        self.assertEqual(len([c for c in calls if '/status/' in c[0]]), 10)
        self.assertEqual(connections, [('s3.fr-par.scw.cloud', 443)])
        self.assertEqual(extra['provider'], 'videoscale')

    def test_fresh_task_status_404_retries_read_not_submission(self):
        provider = Provider('Basic synthetic', lambda: None)
        calls = []
        replies = iter([[FORMAT], {'task_id': '00000000-0000-4000-8000-000000000001'},
                        Failure('IMPORT_SOURCE_UNAVAILABLE', 422), {'status': 'failed'}])
        def request(path, body=None):
            calls.append((path, body))
            value = next(replies)
            if isinstance(value, Exception):
                raise value
            return value
        provider.request = request
        with patch('service.time.sleep'), self.assertRaises(Failure):
            provider.acquire('https://www.youtube.com/watch?v=aqz-KE-bpKQ', 2048, io.BytesIO())
        self.assertEqual(len([c for c in calls if c[1] is not None]), 1)
        self.assertEqual(len([c for c in calls if '/status/' in c[0]]), 2)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.server = Server(('127.0.0.1', 0), Handler)
        self.server.api_key = 's' * 32
        self.server.provider_auth = 'Basic synthetic'
        self.server.scratch = self.directory.name
        self.server.slots = threading.BoundedSemaphore(1)
        from concurrent.futures import Future
        title = Future()
        title.set_result({'title': 'Official fixture title', 'channel': 'Fixture creator'})
        self.server.metadata = unittest.mock.Mock()
        self.server.metadata.start.return_value = title
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.origin = 'http://127.0.0.1:' + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def request(self, body=None, auth=True, request_id=''):
        data = json.dumps(body if body is not None else {
            'url': 'https://youtu.be/aqz-KE-bpKQ', 'max_bytes': 2048, 'max_duration_seconds': 1200}).encode()
        request = urllib.request.Request(self.origin + '/audio-imports', data=data,
                                         headers={'Content-Type': 'application/json',
                                                  'Authorization': 'Bearer ' + ('s' * 32 if auth else 'bad'),
                                                  'X-Import-Request-ID': request_id})
        try:
            return urllib.request.urlopen(request, timeout=5)
        except urllib.error.HTTPError as error:
            return error

    def test_auth_and_validation_do_not_call_provider(self):
        with patch('service.Provider.acquire') as acquire:
            with self.request(auth=False) as response:
                self.assertEqual(response.status, 401)
            with self.request({'url': 'bad'}) as response:
                self.assertEqual(response.status, 400)
            acquire.assert_not_called()

    def test_log_correlation_accepts_only_bounded_ids(self):
        for request_id in ['00000000-0000-4000-8000-000000000001', 'secret-url-not-an-id']:
            with patch('service.Provider.acquire', side_effect=RuntimeError('secret response body')), \
                    patch('builtins.print') as log:
                with self.request(request_id=request_id) as response:
                    response.read()
                # Wait for this handler's final log, not just its HTTP response.
                for _ in range(100):
                    if log.called:
                        break
                    threading.Event().wait(0.01)
                event = json.loads(log.call_args.args[0])
                if request_id.startswith('00000000'):
                    self.assertEqual(event['acquisition_id'], request_id)
                else:
                    self.assertNotEqual(event['acquisition_id'], request_id)
                self.assertNotIn('secret', json.dumps(event))

    def test_metadata_miss_does_not_fail_or_repeat_acquisition(self):
        from concurrent.futures import Future
        missing = Future()
        missing.set_result({})
        self.server.metadata.start.return_value = missing
        def acquire(_self, url, limit, out):
            out.write(b'audio')
            return 5, metadata(FORMAT)
        with patch('service.Provider.acquire', autospec=True, side_effect=acquire) as call:
            with self.request() as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), b'audio')
            self.assertEqual(call.call_count, 1)

    def test_binary_metadata_cleanup(self):
        def acquire(_self, url, limit, out):
            out.write(b'audio')
            return 5, metadata(FORMAT)
        with patch('service.Provider.acquire', acquire):
            with self.request() as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), b'audio')
                extra = json.loads(base64.b64decode(response.headers['X-Import-Extra-Data-Base64']))
                self.assertEqual(extra['format_id'], '140')
                self.assertEqual(extra['title'], 'Official fixture title')
        import os
        self.assertEqual(os.listdir(self.directory.name), [])
        self.assertTrue(self.server.slots.acquire(timeout=2))

    def test_failure_cleanup_and_sanitized_errors(self):
        def acquire(_self, url, limit, out):
            out.write(b'partial')
            raise RuntimeError('private URL and secret must not escape')
        with patch('service.Provider.acquire', acquire):
            with self.request() as response:
                self.assertEqual(response.status, 503)
                self.assertEqual(response.headers['X-Import-Error'], 'IMPORT_DEPENDENCY_FAILED')
                self.assertNotIn(b'secret', response.read())
        import os
        self.assertEqual(os.listdir(self.directory.name), [])

    def test_capacity(self):
        self.server.slots.acquire()
        with patch('service.Provider.acquire') as acquire:
            with self.request() as response:
                self.assertEqual(response.status, 503)
                self.assertEqual(json.load(response)['code'], 'IMPORT_QUEUE_FULL')
            acquire.assert_not_called()

    def test_disconnect_stops_work_and_reclaims_scratch(self):
        entered, proceed, finished = threading.Event(), threading.Event(), threading.Event()
        def acquire(provider, url, limit, out):
            out.write(b'partial')
            entered.set()
            proceed.wait(2)
            try:
                provider.check()
                raise AssertionError('Disconnected client was not detected')
            finally:
                finished.set()
        data = json.dumps({'url': 'https://youtu.be/aqz-KE-bpKQ', 'max_bytes': 2048,
                           'max_duration_seconds': 1200}).encode()
        with patch('service.Provider.acquire', acquire):
            client = socket.create_connection(('127.0.0.1', self.server.server_port))
            client.sendall(('POST /audio-imports HTTP/1.1\r\nHost: localhost\r\n'
                            'Content-Type: application/json\r\nAuthorization: Bearer ' + 's' * 32 +
                            '\r\nContent-Length: ' + str(len(data)) + '\r\n\r\n').encode() + data)
            self.assertTrue(entered.wait(2))
            client.shutdown(socket.SHUT_RDWR)
            client.close()
            proceed.set()
            self.assertTrue(finished.wait(2))
            self.assertTrue(self.server.slots.acquire(timeout=2))
        import os
        self.assertEqual(os.listdir(self.directory.name), [])


if __name__ == '__main__':
    unittest.main()
